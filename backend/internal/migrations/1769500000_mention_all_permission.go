package migrations

// Migration 1769500000: `mention_all` permission dictionary extension and system
// role reconciliation (Part 9 of INPROGRESS_TOPIC_OPEN_READS_AND_DRAFT_SAFETY_PLAN).
//
// 1. Extends the `roles.permissions` SelectField dictionary with any compiled
//    permission key missing from stored collections (including `mention_all`).
// 2. Reconciles system role rows (admin, root) so they receive `mention_all`
//    from their compiled specs. Custom roles are untouched.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyMentionAllPermissionRepair, revertMentionAllPermissionRepair)
}

func applyMentionAllPermissionRepair(app core.App) error {
	if err := repairRolePermissionDictionary(app); err != nil {
		return fmt.Errorf("roles permissions dictionary: %w", err)
	}
	if err := reconcileSystemRolePermissions(app); err != nil {
		return fmt.Errorf("roles permissions reconcile: %w", err)
	}
	return nil
}

func revertMentionAllPermissionRepair(app core.App) error {
	// No-op: SelectField dictionary keeps its keys and stored rows remain valid.
	return nil
}
