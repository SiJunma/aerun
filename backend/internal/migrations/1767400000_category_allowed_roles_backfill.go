package migrations

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

// 1767400000_category_allowed_roles_backfill.go completes the category
// visibility contract and retires the legacy permission map.
//
// Migration 1766500000 added `categories.allowed_roles` but documented the
// OPPOSITE empty-list meaning ("every role with view_forum"), which is how the
// legacy `permissions: {}` document meant "public". Meanwhile
// `canViewCategory` (category_access.go) still read that legacy map. The audit
// reversed the empty-list meaning to root-only (ADR-1) precisely because the
// importer writes `allowed_roles`, and a restricted category whose list arrived
// empty would otherwise have been published to the whole forum.
//
// The two halves are reconciled here, in this order:
//
//  1. Backfill every existing row BEFORE the reader changes. A row whose legacy
//     map names roles keeps exactly that list (the "Скрытые игры" case, which
//     names a custom role id directly); a row with no map becomes the explicit
//     full public list, which is what "empty map = public" meant. Nothing is
//     left to the reader's interpretation.
//  2. Drop `categories.permissions`. It was added by 1766300000, no writer ever
//     existed (the browser API is locked and the command layer did not touch it),
//     and leaving it would keep two competing definitions of one rule — exactly
//     the drift this migration exists to end.
//
// The public list is every role_id in the roles collection (guest included),
// sorted ascending. Sorting is not cosmetic: the importer applies the identical
// rule, and an unsorted map iteration would make two runs produce two different
// byte sequences for the same category.
//
// The down path restores the legacy field and empties allowed_roles, which
// returns the collection to the shape the pre-audit code understood.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := backfillCategoryAllowedRoles(app); err != nil {
			return fmt.Errorf("categories.allowed_roles backfill: %w", err)
		}
		return dropLegacyCategoryPermissions(app)
	}, func(app core.App) error {
		return restoreLegacyCategoryPermissions(app)
	})
}

// backfillCategoryAllowedRoles fills categories.allowed_roles from the legacy
// permissions map. Rows that already carry a list are left untouched, so the
// migration is idempotent and a partially-migrated database converges.
func backfillCategoryAllowedRoles(app core.App) error {
	publicRoles, err := allRoleIDsSorted(app)
	if err != nil {
		return err
	}

	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		return err
	}
	records, err := app.FindAllRecords(categories, nil)
	if err != nil {
		return err
	}

	for _, record := range records {
		if len(decodeRoleIDList(record.Get("allowed_roles"))) > 0 {
			continue
		}
		allowed := legacyViewForumRoles(record.Get("permissions"))
		if len(allowed) == 0 {
			allowed = publicRoles
		}
		raw, err := json.Marshal(allowed)
		if err != nil {
			return err
		}
		record.Set("allowed_roles", types.JSONRaw(raw))
		if err := app.Save(record); err != nil {
			return fmt.Errorf("category %s: %w", record.Id, err)
		}
	}
	return nil
}

// legacyViewForumRoles extracts permissions.view_forum from the deprecated
// category permission map. A missing, empty or unparsable map yields no roles,
// which the caller reads as "public" — the historical meaning.
func legacyViewForumRoles(raw any) []string {
	var perms map[string]any
	switch value := raw.(type) {
	case nil:
		return nil
	case types.JSONRaw:
		if len(value) == 0 {
			return nil
		}
		if err := json.Unmarshal(value, &perms); err != nil {
			return nil
		}
	case string:
		if value == "" || value == "{}" {
			return nil
		}
		if err := json.Unmarshal([]byte(value), &perms); err != nil {
			return nil
		}
	case map[string]any:
		perms = value
	default:
		data, err := json.Marshal(value)
		if err != nil {
			return nil
		}
		if err := json.Unmarshal(data, &perms); err != nil {
			return nil
		}
	}
	return decodeRoleIDList(perms["view_forum"])
}

// decodeRoleIDList normalises a JSON value that should be a list of role ids.
// PocketBase stores JSON fields as types.JSONRaw, but a value can also arrive as
// a plain slice or as string-encoded JSON depending on who wrote it, so every
// shape the codebase can produce is accepted.
func decodeRoleIDList(raw any) []string {
	switch value := raw.(type) {
	case nil:
		return nil
	case types.JSONRaw:
		if len(value) == 0 {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil
		}
		return decoded
	case string:
		if value == "" || value == "[]" {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return nil
		}
		return decoded
	case []string:
		return value
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// allRoleIDsSorted returns every role_id in the registry, ascending. An absent
// roles collection is not an error: it yields an empty list, and the affected
// categories then keep an empty allowed_roles, which the reader treats as
// root-only — the fail-closed direction.
func allRoleIDsSorted(app core.App) ([]string, error) {
	roles, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return nil, err
	}
	records, err := app.FindAllRecords(roles, nil)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.GetString("role_id"))
	}
	slices.Sort(ids)
	return ids, nil
}

// dropLegacyCategoryPermissions removes the deprecated map once every row has
// been translated. Keeping it would leave two readers of one rule, which is the
// drift class this whole migration exists to remove.
func dropLegacyCategoryPermissions(app core.App) error {
	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	categories.Fields.RemoveByName("permissions")
	return app.Save(categories)
}

func restoreLegacyCategoryPermissions(app core.App) error {
	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	ensureField(categories, &core.JSONField{Name: "permissions", MaxSize: 65536})
	if err := app.Save(categories); err != nil {
		return err
	}

	records, err := app.FindAllRecords(categories, nil)
	if err != nil {
		return err
	}
	for _, record := range records {
		record.Set("allowed_roles", nil)
		if err := app.Save(record); err != nil {
			return err
		}
	}
	return nil
}
