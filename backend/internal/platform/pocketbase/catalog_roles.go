package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func roleRecordPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":                   r.Id,
		"role_id":              r.GetString("role_id"),
		"name":                 r.GetString("name"),
		"rank":                 r.GetInt("rank"),
		"color":                r.GetString("color"),
		"is_system":            r.GetBool("is_system"),
		"base_role_id":         r.GetString("base_role_id"),
		"max_characters_limit": r.GetInt("max_characters_limit"),
		"permissions":          r.GetStringSlice("permissions"),
	}
}

func listRolesHandler(e *core.RequestEvent) error {
	col, err := e.App.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return internalError("roles collection unavailable", err)
	}

	records, err := e.App.FindRecordsByFilter(col, "", "rank", 0, 0)
	if err != nil {
		return internalError("failed to query roles", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		items = append(items, roleRecordPayload(r))
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

type roleCreateForm struct {
	RoleID             string   `json:"role_id"`
	Name               string   `json:"name"`
	Rank               int      `json:"rank"`
	Color              string   `json:"color"`
	BaseRoleID         string   `json:"base_role_id"`
	MaxCharactersLimit int      `json:"max_characters_limit"`
	Permissions        []string `json:"permissions"`
}

func sanitizeRoleID(input, name string) string {
	candidate := strings.TrimSpace(input)
	if candidate == "" {
		candidate = strings.ToLower(strings.TrimSpace(name))
	}
	var b strings.Builder
	for _, r := range candidate {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else if r == ' ' {
			b.WriteRune('_')
		}
	}
	res := b.String()
	if len(res) > 32 {
		res = res[:32]
	}
	return res
}

func validateRolePermissions(perms []string) ([]string, error) {
	allVals := auth.AllPermissionValues()
	validSet := make(map[string]bool, len(allVals))
	for _, v := range allVals {
		validSet[v] = true
	}

	cleaned := make([]string, 0, len(perms))
	seen := make(map[string]bool, len(perms))
	for _, p := range perms {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			continue
		}
		if !validSet[p] {
			return nil, validationError("invalid permission: " + p)
		}
		seen[p] = true
		cleaned = append(cleaned, p)
	}
	return cleaned, nil
}

func createRoleHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	raw, err := readBodyLimited(e, 64*1024)
	if err != nil {
		return err
	}
	var form roleCreateForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed role payload")
	}

	form.Name = strings.TrimSpace(form.Name)
	if form.Name == "" || len(form.Name) > 64 {
		return validationError("role name is required and must not exceed 64 characters")
	}

	roleID := sanitizeRoleID(form.RoleID, form.Name)
	if len(roleID) < 2 {
		return validationError("role_id must be at least 2 alphanumeric characters")
	}

	perms, err := validateRolePermissions(form.Permissions)
	if err != nil {
		return err
	}
	if err := validateRoleRank(form.Rank); err != nil {
		return err
	}
	// The UNIQUE check below only covers rows that exist. A reserved id that has
	// not been created yet would pass it and then shadow the compiled matrix:
	// the resolver finds the registry row first and the account loses the
	// system role's permissions silently (a root row named "root" that is
	// is_system=false is exactly that failure, with extra steps).
	if isReservedRoleID(roleID) {
		return validationError("role_id '" + roleID + "' is reserved by the compiled role matrix")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		col, err := txApp.FindCollectionByNameOrId(rolesCollectionName)
		if err != nil {
			return 0, nil, internalError("roles collection unavailable", err)
		}

		existing, _ := txApp.FindFirstRecordByFilter(col, "role_id = {:rid}", dbx.Params{"rid": roleID})
		if existing != nil {
			return 0, nil, conflictError("a role with this role_id already exists")
		}

		rec := core.NewRecord(col)
		rec.Set("role_id", roleID)
		rec.Set("name", form.Name)
		rec.Set("rank", form.Rank)
		rec.Set("color", form.Color)
		rec.Set("is_system", false)
		rec.Set("base_role_id", form.BaseRoleID)
		rec.Set("max_characters_limit", form.MaxCharactersLimit)
		rec.Set("permissions", perms)

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to create role", err)
		}

		_ = recordAuditLog(txApp, "role_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"role_id":   roleID,
			"name":      form.Name,
		})

		return http.StatusCreated, roleRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

func findRoleRecord(app core.App, identifier string) (*core.Record, error) {
	col, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return nil, err
	}

	rec, err := app.FindRecordById(col, identifier)
	if err == nil && rec != nil {
		return rec, nil
	}

	rec, err = app.FindFirstRecordByFilter(col, "role_id = {:rid}", dbx.Params{"rid": identifier})
	if err == nil && rec != nil {
		return rec, nil
	}
	return nil, notFoundError("role not found")
}

func updateRoleHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	identifier := e.Request.PathValue("id")
	if identifier == "" {
		return validationError("role identifier is required")
	}

	raw, err := readBodyLimited(e, 64*1024)
	if err != nil {
		return err
	}
	var form map[string]any
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed role payload")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := findRoleRecord(txApp, identifier)
		if err != nil {
			return 0, nil, err
		}

		// ADR-3: system roles are reconciled from the compiled matrix by
		// import-roles, so an API edit would be reverted on the next run — and
		// until that run, the registry would disagree with the fallback the
		// resolver uses when a lookup fails. Refusing the whole row (including
		// color) is simpler to reason about than a per-field allowlist nobody
		// would trust.
		if rec.GetBool("is_system") {
			return 0, nil, forbiddenError(
				"system roles are reconciled from the compiled matrix and are not editable")
		}

		if nameRaw, ok := form["name"]; ok {
			name, ok := nameRaw.(string)
			name = strings.TrimSpace(name)
			if !ok || name == "" || len(name) > 64 {
				return 0, nil, validationError("name must be 1-64 characters")
			}
			rec.Set("name", name)
		}

		if rankRaw, ok := form["rank"]; ok {
			if r, ok := rankRaw.(float64); ok {
				if err := validateRoleRank(int(r)); err != nil {
					return 0, nil, err
				}
				rec.Set("rank", int(r))
			}
		}

		if colorRaw, ok := form["color"]; ok {
			if c, ok := colorRaw.(string); ok {
				rec.Set("color", c)
			}
		}

		if baseRaw, ok := form["base_role_id"]; ok {
			if b, ok := baseRaw.(string); ok {
				rec.Set("base_role_id", b)
			}
		}

		if limitRaw, ok := form["max_characters_limit"]; ok {
			if l, ok := limitRaw.(float64); ok {
				rec.Set("max_characters_limit", int(l))
			}
		}

		if permsRaw, ok := form["permissions"]; ok {
			if arr, ok := permsRaw.([]any); ok {
				strArr := make([]string, 0, len(arr))
				for _, it := range arr {
					if s, ok := it.(string); ok {
						strArr = append(strArr, s)
					}
				}
				perms, err := validateRolePermissions(strArr)
				if err != nil {
					return 0, nil, err
				}
				rec.Set("permissions", perms)
			}
		}

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update role", err)
		}

		_ = recordAuditLog(txApp, "role_updated", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"role_id":   rec.GetString("role_id"),
			"name":      rec.GetString("name"),
		})

		return http.StatusOK, roleRecordPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

func deleteRoleHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	identifier := e.Request.PathValue("id")
	if identifier == "" {
		return validationError("role identifier is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := findRoleRecord(txApp, identifier)
		if err != nil {
			return 0, nil, err
		}

		if rec.GetBool("is_system") {
			return 0, nil, forbiddenError("system roles cannot be deleted")
		}

		roleID := rec.GetString("role_id")

		// A deleted role leaves users.role and categories.allowed_roles
		// pointing at nothing. Neither is a foreign key (see 1766500000 for why
		// they are plain text), so nothing would stop the write and every
		// affected account would silently fall back to the compiled deny path:
		// an admin who deleted an unused-looking role would lock its holders
		// out of the forum without an error anywhere.
		holders, err := txApp.CountRecords(usersCollectionName, dbx.HashExp{"role": roleID})
		if err != nil {
			return 0, nil, internalError("failed to count role holders", err)
		}
		if holders > 0 {
			return 0, nil, conflictError(
				"this role is assigned to " + fmt.Sprint(holders) + " account(s); move them to another role first")
		}

		categories, err := categoriesGrantingRole(txApp, roleID)
		if err != nil {
			return 0, nil, err
		}
		if len(categories) > 0 {
			return 0, nil, conflictError(
				"this role grants visibility of category(ies) " + strings.Join(categories, ", ") +
					"; remove it from their allowed_roles first")
		}

		targetID := rec.Id
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete role", err)
		}

		_ = recordAuditLog(txApp, "role_deleted", e.Auth.Id, map[string]any{
			"target_id": targetID,
			"role_id":   roleID,
		})

		return http.StatusOK, map[string]any{
			"ok":        true,
			"target_id": targetID,
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// categoriesGrantingRole returns the slugs of categories whose allowed_roles
// name the given role.
//
// The scan reads each row and parses its JSON rather than using a SQL LIKE: the
// collection is small (tens of rows), and matching inside a JSON document with
// LIKE is exactly the shortcut that later reports a role as unreferenced when it
// is referenced — a substring match on `player` also hits `player_two`.
// Correctness here is worth the full scan.
func categoriesGrantingRole(app core.App, roleID string) ([]string, error) {
	records, err := app.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return nil, internalError("failed to query categories", err)
	}

	var slugs []string
	for _, rec := range records {
		if slices.Contains(decodeRoleIDList(rec.Get("allowed_roles")), roleID) {
			slug := rec.GetString("slug")
			if slug == "" {
				slug = rec.Id
			}
			slugs = append(slugs, slug)
		}
	}
	sort.Strings(slugs)
	return slugs, nil
}

// isReservedRoleID reports whether an id belongs to the compiled role matrix.
// Those ids are the wire contract with the legacy data and the fallback the
// access resolver uses; a custom row must never take one of their names.
func isReservedRoleID(roleID string) bool {
	return slices.Contains(auth.AllRoleValues(), roleID)
}

// validateRoleRank bounds the authority rank.
//
// The compiled bands are 200/300/400/600/800/1000. The upper bound of 10000
// leaves room for a custom role to sort above every system role without letting
// a typo turn into a 10^9 that reorders the whole board.
//
// The LOWER bound is 1, not 0, and that is not a preference: `roles.rank` is a
// Required NumberField, so PocketBase answers 0 with
// `validation_required: "Cannot be blank"`. Validating only `rank < 0` here
// would let 0 through this function and turn it into a 500 further down, so the
// caller would learn nothing about what was actually wrong with their payload.
// Rejecting it here keeps the refusal a 400 with a message that names the
// range.
func validateRoleRank(rank int) error {
	if rank < 1 || rank > 10000 {
		return validationError("rank must be between 1 and 10000")
	}
	return nil
}
