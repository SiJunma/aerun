package migrations

import (
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// 1766200000_guest_view_forum.go grants the guest role its global
// `view_forum` baseline.
//
// Background: 1766000000 seeded `guest` with an empty permission set on the
// assumption that guests would only reach the forum through category-level
// `view_forum` overrides. That is not the product contract: guests may read
// the public forum, and the legacy constants already list `view_forum` in the
// guest ceiling (`MAX_ROLE_PERMISSIONS.guest` in
// src/constants/permissions.js). A permissionless guest is locked out of every
// read path that is not explicitly overridden at category level, which is
// exactly the regression this migration removes.
//
// The compiled matrix in internal/auth is the reconciliation reference for the
// roles collection, so the fix lives there too and a fresh install gets it
// straight from 1766000000; this migration only carries the already-seeded
// `roles` row onto the new contract. Future sprints append new timestamped
// migrations; never edit an applied migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return setGuestPermissions(app, auth.DefaultPermissions(auth.RoleGuest))
	}, func(app core.App) error {
		// Down: back to the pre-fix contract (no global guest permissions).
		return setGuestPermissions(app, []auth.Permission{})
	})
}

// rolesCollectionName is the role registry collection created by
// 1766000000_identity_rbac.go.
const rolesCollectionName = "roles"

// setGuestPermissions replaces the permission set of the `guest` role row with
// `perms`, creating the row from the compiled spec when a database predating
// the roles seed is migrated. The set is replaced rather than merged on
// purpose: the row is a system role whose authority is the compiled matrix, so
// the migration makes the stored value match the contract exactly. Guest
// accounts are never stored identities, so no users record is touched.
func setGuestPermissions(app core.App, perms []auth.Permission) error {
	collection, err := app.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return fmt.Errorf("roles: %w", err)
	}
	records, err := app.FindAllRecords(collection, dbx.HashExp{"role_id": string(auth.RoleGuest)})
	if err != nil {
		return fmt.Errorf("guest role lookup: %w", err)
	}
	for _, record := range records {
		record.Set("permissions", auth.PermissionValues(perms))
		if err := app.Save(record); err != nil {
			return fmt.Errorf("update guest role %s: %w", record.Id, err)
		}
	}
	if len(records) > 0 {
		return nil
	}
	return seedGuestRole(app, collection, perms)
}

// seedGuestRole creates the guest row from the compiled spec when the roles
// collection has none.
func seedGuestRole(app core.App, collection *core.Collection, perms []auth.Permission) error {
	spec, ok := auth.SpecFor(auth.RoleGuest)
	if !ok {
		return fmt.Errorf("guest role is missing from the compiled matrix")
	}
	record := core.NewRecord(collection)
	record.Set("role_id", string(spec.Role))
	record.Set("name", spec.Name)
	record.Set("rank", spec.Rank)
	record.Set("color", spec.Color)
	record.Set("is_system", spec.IsSystem)
	record.Set("permissions", auth.PermissionValues(perms))
	if err := app.Save(record); err != nil {
		return fmt.Errorf("seed guest role: %w", err)
	}
	return nil
}
