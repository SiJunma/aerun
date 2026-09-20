package migrations

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// 1766000000_identity_rbac.go creates the Sprint 2 identity contract:
//
//   - `users` — the PocketBase auth collection. PocketBase's own init
//     migration already creates a default `users` collection on any fresh
//     install, so this migration ADOPTS it (or creates it when absent) and
//     reconfigures it: Aerun identity fields, locked mutations, a public
//     profile read rule that never exposes email, and auth side channels
//     (auth alerts, OTP, OAuth2) switched off while mail delivery stays
//     hard-disabled.
//   - `roles` — the canonical role registry (name, rank, color, system flag,
//     permission set), seeded from the compiled matrix in internal/auth so
//     the collection data and the Go enforcement fallback can never drift
//     apart silently (identity_test.go cross-checks them).
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := configureUsers(app); err != nil {
			return fmt.Errorf("users: %w", err)
		}
		if err := createRoles(app); err != nil {
			return fmt.Errorf("roles: %w", err)
		}
		return nil
	}, func(app core.App) error {
		roles, err := app.FindCollectionByNameOrId("roles")
		if err != nil {
			return err
		}
		if err := app.Delete(roles); err != nil {
			return err
		}
		return revertUsers(app)
	})
}

// publicProfileRule lets guests read public profiles of active accounts and
// lets every account read its own record regardless of status. Password,
// tokenKey and email stay private: email is dropped from responses while
// emailVisibility is false, and legacy_firebase_uid is a hidden field.
const publicProfileRule = `status = "active" || id = @request.auth.id`

func configureUsers(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// Fresh installs always have the default users collection from the
		// PocketBase init migration; create one only as a safety net.
		users = core.NewAuthCollection("users")
	}

	// Replace the scaffold identity fields with the Aerun contract. The
	// defaults "name"/"avatar" are legacy PocketBase demo fields.
	users.Fields.RemoveByName("name")
	users.Fields.RemoveByName("avatar")

	ensureField(users, &core.TextField{Name: "nickname", Required: true, Max: 64})
	ensureField(users, &core.TextField{Name: "nickname_normalized", Required: true, Max: 128})
	ensureField(users, &core.SelectField{
		Name:      "role",
		Required:  true,
		MaxSelect: 1,
		Values:    auth.AllRoleValues(),
	})
	ensureField(users, &core.SelectField{
		Name:      "status",
		Required:  true,
		MaxSelect: 1,
		Values:    auth.AllStatusValues(),
	})
	ensureField(users, &core.TextField{Name: "legacy_firebase_uid", Max: 128, Hidden: true})
	ensureField(users, &core.TextField{Name: "avatar_url", Max: 512})
	ensureField(users, &core.JSONField{Name: "settings", MaxSize: 262144})

	// Deny-by-default: browser mutations are locked; every future profile
	// change goes through a server command (plan invariant 2).
	users.CreateRule = nil
	users.UpdateRule = nil
	users.DeleteRule = nil
	users.ListRule = types.Pointer(publicProfileRule)
	users.ViewRule = types.Pointer(publicProfileRule)

	// Partial unique index: rows that predate the Aerun identity contract
	// (PocketBase project snapshots, Firebase Auth records awaiting the
	// Sprint 7 import) have no normalised nickname yet. Without the
	// predicate the very first empty string would already collide with the
	// next one, so only real nicknames are constrained — exactly like
	// legacy_firebase_uid below.
	users.AddIndex("idx_users_nickname_normalized", true, "nickname_normalized", "nickname_normalized != ''")
	// Partial unique index: multiple locally registered (non-imported)
	// accounts have no legacy uid and empty strings must not collide.
	users.AddIndex("idx_users_legacy_firebase_uid", true, "legacy_firebase_uid", "legacy_firebase_uid != ''")

	// Auth side channels: no emails may leave the process while
	// AERUN_MAIL_MODE=disabled (the mailer guard is the second layer).
	users.AuthAlert.Enabled = false
	users.OTP.Enabled = false
	users.OAuth2.Enabled = false
	users.MFA.Enabled = false
	// The removed scaffold fields were the default OAuth2 mappings; unset
	// them so collection validation does not reference missing fields.
	users.OAuth2.MappedFields.Name = ""
	users.OAuth2.MappedFields.AvatarURL = ""

	return app.Save(users)
}

// ensureField adds the field only when absent, so re-running the migration
// against an already-configured collection never creates duplicates.
func ensureField(collection *core.Collection, field core.Field) {
	if collection.Fields.GetByName(field.GetName()) == nil {
		collection.Fields.Add(field)
	}
}

func createRoles(app core.App) error {
	roles := core.NewBaseCollection("roles")
	roles.Fields.Add(
		&core.TextField{Name: "role_id", Required: true, Max: 32},
		&core.TextField{Name: "name", Required: true, Max: 64},
		&core.NumberField{Name: "rank", Required: true, OnlyInt: true},
		&core.TextField{Name: "color", Max: 32},
		&core.BoolField{Name: "is_system"},
		&core.SelectField{
			Name:      "permissions",
			MaxSelect: len(auth.AllPermissions()),
			Values:    auth.AllPermissionValues(),
		},
	)
	// Locked completely: role rows are managed by server commands only.
	roles.ListRule = nil
	roles.ViewRule = nil
	roles.CreateRule = nil
	roles.UpdateRule = nil
	roles.DeleteRule = nil
	roles.AddIndex("idx_roles_role_id", true, "role_id", "")

	if err := app.Save(roles); err != nil {
		return err
	}

	for _, spec := range auth.SystemRoles() {
		record := core.NewRecord(roles)
		record.Set("role_id", string(spec.Role))
		record.Set("name", spec.Name)
		record.Set("rank", spec.Rank)
		record.Set("color", spec.Color)
		record.Set("is_system", spec.IsSystem)
		record.Set("permissions", auth.PermissionValues(spec.Permissions))
		if err := app.Save(record); err != nil {
			return fmt.Errorf("seed role %s: %w", spec.Role, err)
		}
	}
	return nil
}

// revertUsers restores the PocketBase default users collection shape for the
// down path: Aerun fields and indexes are removed and the stock owner rules
// are reinstated. It is best effort — the up path is what production runs.
func revertUsers(app core.App) error {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return err
	}
	for _, name := range []string{
		"nickname", "nickname_normalized", "role", "status",
		"legacy_firebase_uid", "avatar_url", "settings",
	} {
		users.Fields.RemoveByName(name)
	}
	users.Fields.Add(
		&core.TextField{Name: "name", Max: 255},
		&core.FileField{Name: "avatar", MaxSelect: 1, MimeTypes: []string{
			"image/jpeg", "image/png", "image/webp", "image/gif",
		}},
	)
	ownerRule := "id = @request.auth.id"
	users.ListRule = types.Pointer(ownerRule)
	users.ViewRule = types.Pointer(ownerRule)
	users.CreateRule = types.Pointer("")
	users.UpdateRule = types.Pointer(ownerRule)
	users.DeleteRule = types.Pointer(ownerRule)
	users.RemoveIndex("idx_users_nickname_normalized")
	users.RemoveIndex("idx_users_legacy_firebase_uid")
	return app.Save(users)
}
