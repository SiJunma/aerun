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
	// A role created WITHOUT a rank. The role form has no rank input, so
	// "create a role based on Player" posted rank: 0 and validateRoleRank
	// rejected it — custom roles could not be created at all. An omitted rank
	// is now placed just above the base role the admin picked in the form,
	// which is the ordering that choice already implies.
	//
	// `== 0`, not `<= 0`: zero is Go's zero value for a missing JSON key, which
	// is the ONLY case that means "no opinion". A negative rank is a value the
	// caller actually sent, so it stays a 400 instead of being silently replaced
	// by a default the admin never asked for.
	rank := form.Rank
	if rank == 0 {
		rank = defaultRoleRank(form.BaseRoleID)
	}
	if err := validateRoleRank(rank); err != nil {
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

	baseRoleID := strings.TrimSpace(form.BaseRoleID)
	// Same rule as on update: the base must exist, or the delete-revert path
	// would later move every holder onto a role that is not there.
	if err := validateBaseRole(e.App, baseRoleID); err != nil {
		return err
	}
	form.BaseRoleID = baseRoleID

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
		rec.Set("rank", rank)
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

		// Roles are data the admin owns: a system role is edited exactly like a
		// custom one, which is what makes it usable as a live template for the
		// "create a role based on this" flow. (Previously this returned 403 and
		// cited import-roles as the reason. That import is a one-shot CLI an
		// operator runs deliberately — it is NOT on the server start path — so
		// the argument for immutability never actually held, and the cost was
		// real: the whole registry could not be reshaped from the admin panel.)
		//
		// Two identity fields stay locked regardless, because they are not
		// presentation. `role_id` is the key users.role and categories
		// .allowed_roles point at, and `is_system` decides whether the row is
		// deletable and whether the role may serve as a base. Neither is in the
		// payload below, so a caller cannot flip them by sending extra keys.

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
				base := strings.TrimSpace(b)
				// A system role IS the template; it cannot itself be derived
				// from something. Allowing it would give the admin two sources
				// of truth for one row, and the "revert to base on delete"
				// path has no defined target for such a role.
				if base != "" && rec.GetBool("is_system") {
					return 0, nil, validationError("a system role cannot have a base role")
				}
				// A role derived from itself would resolve its own permissions
				// forever. The delete-revert path below reads base_role_id as
				// the fallback target, so a self-reference would also point
				// holders at a row that no longer exists.
				if base == rec.GetString("role_id") {
					return 0, nil, validationError("a role cannot be its own base role")
				}
				if err := validateBaseRole(txApp, base); err != nil {
					return 0, nil, err
				}
				rec.Set("base_role_id", base)
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

		// Holders fall back to the role's base rather than being locked out.
		//
		// The previous contract was a 409 telling the admin to move them by
		// hand. That made deleting a role with any members impossible from the
		// panel, which is the one thing an admin does when the role no longer
		// fits the staff it describes. Reverting to the base is the outcome the
		// admin already expects: a role derived from Moderator was, until the
		// moment it was deleted, a Moderator with a few differences.
		//
		// `users.role` is plain text (1766500000), so nothing would have stopped
		// the delete and every holder would have silently fallen through to the
		// compiled deny path — losing access with no error anywhere. The write
		// below is what makes the deletion honest instead.
		baseRoleID := rec.GetString("base_role_id")
		holders, err := txApp.FindAllRecords(usersCollectionName,
			dbx.HashExp{"role": roleID})
		if err != nil {
			return 0, nil, internalError("failed to count role holders", err)
		}
		if len(holders) > 0 && baseRoleID == "" {
			// No base to fall back to. Refusing beats silently stranding them,
			// and the message names the fix rather than the symptom.
			return 0, nil, conflictError(
				"this role is assigned to " + fmt.Sprint(len(holders)) +
					" account(s) and has no base role to fall back to; " +
					"set a base role or move them to another role first")
		}

		// A category that lists the role keeps the entry removed below only if
		// the admin asked for it, so this stays a refusal: dropping the id from
		// allowed_roles would silently hide the category from everyone it was
		// granting to, which is a visibility change nobody asked for.
		categories, err := categoriesGrantingRole(txApp, roleID)
		if err != nil {
			return 0, nil, err
		}
		if len(categories) > 0 {
			return 0, nil, conflictError(
				"this role grants visibility of category(ies) " + strings.Join(categories, ", ") +
					"; remove it from their allowed_roles first")
		}

		for _, holder := range holders {
			holder.Set("role", baseRoleID)
			// custom_role_id names the system role behind a holder's CUSTOM
			// role. After the revert the holder is on that system role directly,
			// so the column must be cleared or the staff check would keep
			// resolving against a role that no longer exists.
			holder.Set("custom_role_id", "")
			if err := txApp.Save(holder); err != nil {
				return 0, nil, internalError("failed to reassign role holders", err)
			}
		}

		targetID := rec.Id
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete role", err)
		}

		_ = recordAuditLog(txApp, "role_deleted", e.Auth.Id, map[string]any{
			"target_id":        targetID,
			"role_id":          roleID,
			"reassigned_to":    baseRoleID,
			"reassigned_users": len(holders),
		})

		return http.StatusOK, map[string]any{
			"ok":               true,
			"target_id":        targetID,
			"reassigned_to":    baseRoleID,
			"reassigned_users": len(holders),
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

// validateBaseRole checks that a base role id names a real, non-deleted role.
//
// An empty base is legal and means "this role stands on its own"; callers that
// require a base (the delete fallback) check for that separately.
//
// A base that does not exist would be invisible: the permission resolver reads
// `permissions` directly and never walks base_role_id, so a dangling base
// grants nothing today but silently breaks the delete-revert target later.
// Requiring it to exist keeps the stored value usable as a real pointer.
func validateBaseRole(app core.App, base string) error {
	if base == "" {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return internalError("roles collection unavailable", err)
	}
	rec, err := app.FindFirstRecordByFilter(col, "role_id = {:rid}", dbx.Params{"rid": base})
	if err != nil || rec == nil {
		return validationError("base role '" + base + "' does not exist")
	}
	return nil
}

// isReservedRoleID reports whether an id belongs to the compiled role matrix.
// Those ids are the wire contract with the legacy data and the fallback the
// access resolver uses; a custom row must never take one of their names.
func isReservedRoleID(roleID string) bool {
	return slices.Contains(auth.AllRoleValues(), roleID)
}

// defaultRoleRank derives an authority rank for a role created without one.
//
// The admin role form has no rank input at all — it asks for a name, a base
// role and a permission set — so every create posted rank: 0 and
// validateRoleRank refused it with "rank must be between 1 and 10000". Creating
// a custom role was therefore impossible, and the admin could not tell that the
// missing field was the problem.
//
// Rather than adding a field the admin has to reason about, an omitted rank is
// placed one step above the BASE role they picked. That is the ordering the base
// role already implies: a role derived from Player is a stronger Player, and
// the list renders it between Player and the next tier up. A base role that is
// not in the compiled matrix falls back to just above root, so the new row is
// always visible rather than buried at the bottom.
//
// Rank orders roles in the UI and in the reconciliation; it grants nothing on
// its own — authority comes from the permissions the admin ticked — so deriving
// it cannot accidentally widen anybody's access.
func defaultRoleRank(baseRoleID string) int {
	if spec, ok := auth.SpecFor(auth.Role(strings.TrimSpace(baseRoleID))); ok {
		return spec.Rank + 1
	}
	// Unknown base: land above every compiled role (root is the highest at 1000)
	// so the new role is visible instead of sorted to the bottom.
	systemRoles := auth.SystemRoles()
	highest := 0
	for _, spec := range systemRoles {
		if spec.Rank > highest {
			highest = spec.Rank
		}
	}
	return highest + 1
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
