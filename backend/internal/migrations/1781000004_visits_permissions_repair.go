package migrations

// Migration 1781000004: Visits & IP Ban permission dictionary extension and
// system role reconciliation (blocking repair for databases seeded before
// `view_visits_dashboard`, `view_raw_ip`, and `manage_ip_bans` existed).
//
// WHY THIS EXISTS. Migrations 1766000000 / 1768600000 / 1769400000 / 1769500000
// seeded and reconciled `roles` before the Visits & Activity Dashboard added
// three new permission keys to `internal/auth`. Because PocketBase executes each
// migration once, existing databases retain the older `roles.permissions`
// SelectField vocabulary and older `root`/`admin` rows — hiding the Visits tab
// from administrators even after deploying the new backend and frontend.
//
// ORDER MATTERS:
//  1. Extend the `roles.permissions` SelectField dictionary first using the
//     full `auth.AllPermissionValues()` list (`repairRolePermissionDictionary`
//     from 1769400000) so saving updated system rows passes SelectField
//     validation and any future permission keys self-heal too.
//  2. Reconcile system role rows (`reconcileSystemRolePermissions` from
//     1768600000) against the compiled specs: `root` receives all permissions
//     (including `view_raw_ip`), `admin` receives all except `view_raw_ip`,
//     unchanged rows are skipped, and custom (`is_system = false`) roles are
//     never touched.
//
// Idempotent by construction. Revert is an intentional no-op: dropping keys from
// the SelectField vocabulary or restoring stale rows would break validation and
// hide the dashboard again.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyVisitsPermissionRepair, revertVisitsPermissionRepair)
}

func applyVisitsPermissionRepair(app core.App) error {
	if err := repairRolePermissionDictionary(app); err != nil {
		return fmt.Errorf("roles permissions dictionary: %w", err)
	}
	if err := reconcileSystemRolePermissions(app); err != nil {
		return fmt.Errorf("roles permissions reconcile: %w", err)
	}
	return nil
}

func revertVisitsPermissionRepair(app core.App) error {
	// Intentional no-op: keep dictionary keys and reconciled system role rows valid.
	return nil
}
