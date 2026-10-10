package migrations

// Repair migration: `edit_self_profile` (and any other compiled key) missing
// from the stored `roles` data on databases seeded BEFORE the key existed.
//
// WHY THIS EXISTS. Migration 1766000000 seeded the system role rows from the
// compiled specs, and 1767800000/1768600000 reconciled them afterwards — but
// `edit_self_profile` was added to internal/auth later (commit bce786d), after
// 1768600000 had already run on production databases. PocketBase migrations run
// ONCE, so those databases keep pre-`bce786d` rows: the `player` row lacks the
// key, `NarrowForStatus` has nothing to keep for pending accounts, and
// PATCH /api/aerun/me/profile answers 403 "you are not allowed to edit your
// profile" even though the compiled matrix grants it. CI never sees this
// because a fresh test DB is seeded by the CURRENT specs.
//
// A second gap on the same old databases: the `roles.permissions` SelectField
// dictionary (its `Values` list) may predate the key, so even a corrected row
// value could fail field validation on save. The dictionary is therefore
// extended first, exactly as 1767800000 did for its own new keys — ORDER
// MATTERS: extend the vocabulary BEFORE writing rows.
//
// The repair does two things and nothing else:
//
//  1. Dictionary: append every value from auth.AllPermissionValues() that the
//     SelectField lacks (asserting against the FULL compiled list, so future
//     keys self-heal too). The collection is saved only when something changed.
//  2. Rows: reconcileSystemRolePermissions (already introduced by 1768600000)
//     rewrites is_system rows to compiledRolePermissions() and skips rows whose
//     set already matches — CUSTOM roles are never touched, because an operator
//     who deliberately narrowed one must not be overruled by a migration.
//
// Idempotent by construction: a second run finds no missing dictionary keys
// and no row differing from the compiled specs, so it writes nothing.
//
// The revert is a deliberate no-op (same reasoning as 1767600000's down path):
// removing dictionary keys that stored rows may contain would break validation
// on the next save, and restoring pre-repair rows would only re-introduce the
// 403 this migration exists to fix.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func init() {
	m.Register(applyProfilePermissionRepair, revertProfilePermissionRepair)
}

func applyProfilePermissionRepair(app core.App) error {
	if err := repairRolePermissionDictionary(app); err != nil {
		return fmt.Errorf("roles permissions dictionary: %w", err)
	}
	// Reused verbatim from 1768600000: system rows only, save only when the
	// stored set differs from the compiled spec, custom rows untouched.
	if err := reconcileSystemRolePermissions(app); err != nil {
		return fmt.Errorf("roles permissions reconcile: %w", err)
	}
	return nil
}

// repairRolePermissionDictionary appends compiled permission keys the
// SelectField dictionary is missing. Like extendRolePermissionVocabulary
// (1767800000) but with a changed-guard: the collection is saved only when a
// key was actually added, so a second run writes nothing at all.
func repairRolePermissionDictionary(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		return fmt.Errorf("roles.permissions is not a select field")
	}
	existing := make(map[string]bool, len(field.Values))
	for _, v := range field.Values {
		existing[v] = true
	}
	changed := false
	for _, v := range auth.AllPermissionValues() {
		if !existing[v] {
			field.Values = append(field.Values, v)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	field.MaxSelect = len(field.Values)
	return app.Save(col)
}

func revertProfilePermissionRepair(app core.App) error {
	// No-op by design — see the file header. The dictionary keeps its keys and
	// the rows keep the compiled truth; rolling back would resurrect the bug.
	return nil
}
