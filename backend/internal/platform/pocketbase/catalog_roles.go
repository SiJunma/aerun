package pocketbase

import (
	"encoding/json"
	"net/http"
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
