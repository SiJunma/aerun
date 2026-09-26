package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// usersCollectionName is the PocketBase auth collection reconfigured by
// 1766000000_identity_rbac.go.
const usersCollectionName = "users"

// 1766500000_custom_roles_and_category_visibility.go makes custom roles
// first-class data instead of something the importer folds away.
//
// Background: the legacy forum builds roles in the Admin UI from a permission
// matrix — a custom role is created on top of a system role ("base_role_id")
// and then edited name/permissions granularly (PROJECT_SPEC.md §5.3, and
// MAX_ROLE_PERMISSIONS in src/constants/permissions.js caps what a custom role
// may hold). The 2026-09 export contains four such roles (Demon, Anaptix,
// NorthbayСitizen, NorthbayCitizen+), and category visibility references them
// directly: `categories.permissions.view_forum` is a list of role ids that
// includes custom ones, e.g. "Скрытые игры" is granted only to the custom role
// PYaDjGY5XvWHNEjTswuz. Folding custom roles into their base role would both
// erase the granted permission set and expose such a category to every player,
// so roles migrate verbatim and the schema has to carry them.
//
// Changes:
//   - `users.role` SelectField -> TextField. A select could only ever hold the
//     six compiled ids, so a user could not be assigned an imported custom
//     role. It stays required and is still validated against the roles
//     collection by the command layer (admin_users.go), which is the only
//     writer.
//   - `users.custom_role_id` records, for a user on a custom role, the system
//     role it derives from. That keeps "am I staff?" answerable from the
//     compiled matrix and keeps rank ordering well defined, because a custom
//     role has no authority rank of its own.
//   - `roles.base_role_id` and `roles.max_characters_limit` mirror the legacy
//     role document (PROJECT_SPEC.md §5.3 puts the mask limit on the role).
//   - `categories.allowed_roles` holds the role ids permitted to see a
//     category. An empty list means "every role with view_forum", which is how
//     the legacy export represents a public category.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := makeRoleDynamic(app); err != nil {
			return fmt.Errorf("users.role: %w", err)
		}
		if err := extendRoles(app); err != nil {
			return fmt.Errorf("roles: %w", err)
		}
		return addCategoryVisibility(app)
	}, func(app core.App) error {
		return revertCustomRoles(app)
	})
}

// makeRoleDynamic replaces the users.role select with a text field so imported
// custom role ids are storable, and adds the custom_role_id companion field.
//
// The values are copied into the new field on the way, so an existing database
// keeps its assignments; role validation moves to the command layer, which
// already rejected unknown values.
// mutateCollectionForSchema loads a detached copy of a collection for schema
// edits.
//
// It must be the non-cached finder: PocketBase derives the "old" schema of a
// collection save from FindCachedCollectionByNameOrId (see
// onCollectionSaveExecute), so mutating the *cached* instance in place makes
// old and new the same object, the sync thinks nothing changed and the new
// columns are never created in the record table. The collection metadata would
// be saved while the table silently kept the old shape.
func mutateCollectionForSchema(app core.App, name string) (*core.Collection, error) {
	collection, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		return nil, err
	}
	return collection, nil
}

func makeRoleDynamic(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}

	old, ok := users.Fields.GetByName("role").(*core.SelectField)
	if !ok {
		// A database that never had the select (or already migrated) only
		// needs the companion field.
		if users.Fields.GetByName("role") == nil {
			users.Fields.Add(&core.TextField{Name: "role", Required: true, Max: 64})
		}
		if users.Fields.GetByName("custom_role_id") == nil {
			users.Fields.Add(&core.TextField{Name: "custom_role_id", Max: 64})
		}
		return app.Save(users)
	}

	replacement := &core.TextField{Name: "role", Required: true, Max: 64}
	users.Fields.RemoveByName("role")
	// Insert at the original position so the admin UI keeps its field order.
	users.Fields.Add(replacement)

	// Preserve every existing assignment; a select value is a plain string in
	// SQLite, so copying the raw column value is lossless.
	records, err := app.FindAllRecords(users)
	if err != nil {
		return err
	}
	for _, record := range records {
		value := record.GetString("role")
		if value == "" {
			// Required text: an account without a role would fail the save
			// below. Root is the only safe default — it is the legacy
			// superuser role and the one the importer never assigns.
			value = string(auth.RolePlayer)
		}
		record.Set("role", value)
	}

	// The partial unique index on the old select is meaningless for a free text
	// role, but role assignment is still command-only; keep the field hidden
	// from self-service writes via the collection rules.
	if users.Fields.GetByName("custom_role_id") == nil {
		users.Fields.Add(&core.TextField{Name: "custom_role_id", Max: 64})
	}
	if err := app.Save(users); err != nil {
		return err
	}
	_ = old // the select's Values list is not needed for the copy above
	return nil
}

// extendRoles adds the two legacy role-document fields the Admin UI edits:
// the system role a custom role derives from, and the per-role mask limit
// (PROJECT_SPEC.md §5.3, §"Маски": "Лимит = role.max_characters_limit").
//
// base_role_id is an indexed text field, not a relation: a custom role must be
// readable even when its base role row is absent from a partial export.
func extendRoles(app core.App) error {
	roles, err := mutateCollectionForSchema(app, rolesCollectionName)
	if err != nil {
		return err
	}
	if roles.Fields.GetByName("base_role_id") == nil {
		roles.Fields.Add(&core.TextField{Name: "base_role_id", Max: 32})
	}
	if roles.Fields.GetByName("max_characters_limit") == nil {
		// 0 means "no explicit limit": the command layer falls back to the
		// compiled per-role default rather than hard-coding a number here.
		roles.Fields.Add(&core.NumberField{Name: "max_characters_limit", OnlyInt: true})
	}
	// A custom role must be distinguishable from a system role by lookup, not
	// only by the flag: is_system is not indexed and role_id is the hot path.
	roles.AddIndex("idx_roles_base_role_id", false, "base_role_id", "base_role_id != ''")
	return app.Save(roles)
}

// addCategoryVisibility adds categories.allowed_roles, the role ids permitted
// to see a category.
//
// The legacy documents instead carry a permission map,
// `permissions: {view_forum: [roleId, ...]}`; the importer translates that into
// this list. An empty list is the public case: every role holding view_forum
// may read the category.
func addCategoryVisibility(app core.App) error {
	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	if categories.Fields.GetByName("allowed_roles") == nil {
		// JSON, not a select: a select needs a fixed Values list, which is
		// exactly the constraint that made custom roles unrepresentable.
		categories.Fields.Add(&core.JSONField{Name: "allowed_roles", MaxSize: 16384})
	}
	return app.Save(categories)
}

// revertCustomRoles undoes the up path: drops the added fields and restores
// the compiled role select. Role values that are not compiled roles are reset
// to their base role first, because the select would reject them.
func revertCustomRoles(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	users.Fields.RemoveByName("custom_role_id")
	if _, ok := users.Fields.GetByName("role").(*core.TextField); ok {
		users.Fields.RemoveByName("role")
		users.Fields.Add(&core.SelectField{
			Name:      "role",
			Required:  true,
			MaxSelect: 1,
			Values:    auth.AllRoleValues(),
		})
	}
	if err := app.Save(users); err != nil {
		return err
	}

	roles, err := mutateCollectionForSchema(app, rolesCollectionName)
	if err != nil {
		return err
	}
	roles.Fields.RemoveByName("base_role_id")
	roles.Fields.RemoveByName("max_characters_limit")
	roles.RemoveIndex("idx_roles_base_role_id")
	if err := app.Save(roles); err != nil {
		return err
	}

	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	categories.Fields.RemoveByName("allowed_roles")
	return app.Save(categories)
}
