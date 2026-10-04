package migrations

// 1768600000_reputation_permission_split.go splits `delete_reputation` into four
// keys and reconciles the two system-role rows that had drifted from the
// compiled matrix.
//
// WHY THE SPLIT. One key covered both "retract my own +1" and "remove an
// abusive comment about a third party", and the handler behind it compared
// nothing — ownership was never checked anywhere. So the key was simultaneously
// too weak (no member could retract their own entry) and, as a single
// undifferentiated grant, too strong to reason about. Four keys make the four
// real capabilities separately assignable, and the handler now decides by
// comparing `vote.voter_id` to the caller.
//
// THE BACK-FILL IS THE CONSERVATIVE DIRECTION. A row that held
// `delete_reputation` was, by definition, a row whose operator intended staff
// delete rights, so it receives `delete_others_reputation` — the closest
// meaning the key had. The `_self_` keys are NOT back-filled onto custom rows:
// granting every custom role the ability to retract its own entries is a real
// decision, and the compiled matrix already grants it to player and above.
//
// SYSTEM ROLES ARE RECONCILED, CUSTOM ROLES ARE NOT. `moderator` was missing
// `use_direct_messages` and `player` carried `view_master_dice`. The compiled
// matrix is the reference for system rows and the operator's own choices are the
// reference for every other row, so this rewrites exactly the rows whose role_id
// is a system role.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// retiredReputationKey is the single key this migration retires.
const retiredReputationKey = "delete_reputation"

// newReputationKeys are the four keys that replace it.
var newReputationKeys = []auth.Permission{
	auth.PermEditSelfReputation,
	auth.PermDeleteSelfReputation,
	auth.PermEditOthersReputation,
	auth.PermDeleteOthersReputation,
}

func init() {
	m.Register(applyReputationPermissionSplit, revertReputationPermissionSplit)
}

func applyReputationPermissionSplit(app core.App) error {
	if err := extendRolePermissionVocabularyWithReputationKeys(app); err != nil {
		return err
	}
	if err := backfillReputationPermissions(app); err != nil {
		return err
	}
	// Only now that no row holds the retired key can the SelectField drop it.
	if err := removeRetiredKeyFromVocabulary(app); err != nil {
		return err
	}
	return reconcileSystemRolePermissions(app)
}

func revertReputationPermissionSplit(app core.App) error {
	if err := restoreReputationVocabulary(app); err != nil {
		return err
	}
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		return err
	}
	// A row holding the staff meaning gets the single key back. `_self_` keys are
	// dropped: they were new, and the pre-split world had no such capability for
	// anybody, so leaving them would invent authority the rollback is meant to
	// remove.
	legacy := retiredReputationKey
	for _, row := range rows {
		current := row.GetStringSlice("permissions")
		kept := make([]string, 0, len(current)+1)
		restored := false
		for _, p := range current {
			switch p {
			case string(auth.PermEditOthersReputation), string(auth.PermDeleteOthersReputation):
				if !restored {
					kept = append(kept, legacy)
					restored = true
				}
			case string(auth.PermEditSelfReputation), string(auth.PermDeleteSelfReputation):
				// no-op: a capability that did not exist before the split
			default:
				kept = append(kept, p)
			}
		}
		row.Set("permissions", kept)
		if err := app.Save(row); err != nil {
			return fmt.Errorf("role %s: %w", row.GetString("role_id"), err)
		}
	}
	return nil
}

// extendRolePermissionVocabularyWithReputationKeys adds the four new keys.
//
// Named with a suffix because migration 1767800000 already owns a helper by the
// natural name for the same operation over a different key set; two migrations
// sharing one package cannot both call it that.
//
// The retired value is deliberately NOT dropped here. A SelectField rejects a
// value outside its own list, so removing `delete_reputation` while rows still
// carried it would make those rows unsaveable — the back-fill below has to run
// against a vocabulary that still accepts the old key. It is removed afterwards,
// by removeRetiredKeyFromVocabulary, once no row holds it.
func extendRolePermissionVocabularyWithReputationKeys(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		return fmt.Errorf("roles.permissions is not a SelectField")
	}
	existing := make(map[string]bool, len(field.Values))
	for _, v := range field.Values {
		existing[v] = true
	}
	for _, k := range newReputationKeys {
		if !existing[string(k)] {
			field.Values = append(field.Values, string(k))
		}
	}
	field.MaxSelect = len(field.Values)
	return app.Save(col)
}

// removeRetiredKeyFromVocabulary drops `delete_reputation` once nothing holds it.
func removeRetiredKeyFromVocabulary(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		return fmt.Errorf("roles.permissions is not a SelectField")
	}
	kept := make([]string, 0, len(field.Values))
	for _, v := range field.Values {
		if v != retiredReputationKey {
			kept = append(kept, v)
		}
	}
	field.Values = kept
	field.MaxSelect = len(kept)
	return app.Save(col)
}

// backfillReputationPermissions rewrites the retired key to the staff meaning.
func backfillReputationPermissions(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		return err
	}
	staff := string(auth.PermDeleteOthersReputation)
	for _, row := range rows {
		current := row.GetStringSlice("permissions")
		if !permissionListHas(current, retiredReputationKey) {
			continue
		}
		kept := make([]string, 0, len(current))
		for _, p := range current {
			if p == retiredReputationKey {
				continue
			}
			kept = append(kept, p)
		}
		if !permissionListHas(kept, staff) {
			kept = append(kept, staff)
		}
		row.Set("permissions", kept)
		if err := app.Save(row); err != nil {
			return fmt.Errorf("role %s: %w", row.GetString("role_id"), err)
		}
	}
	return nil
}

// restoreReputationVocabulary is the rollback for the SelectField: the four new
// keys leave, and `delete_reputation` returns so the rewritten rows stay valid.
func restoreReputationVocabulary(app core.App) error {
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	field, ok := col.Fields.GetByName("permissions").(*core.SelectField)
	if !ok {
		return fmt.Errorf("roles.permissions is not a SelectField")
	}
	drop := map[string]bool{retiredReputationKey: true}
	for _, k := range newReputationKeys {
		drop[string(k)] = true
	}
	kept := make([]string, 0, len(field.Values))
	hasLegacy := false
	for _, v := range field.Values {
		if drop[v] {
			if v == retiredReputationKey {
				hasLegacy = true
			}
			continue
		}
		kept = append(kept, v)
	}
	if hasLegacy {
		kept = append(kept, retiredReputationKey)
	}
	field.Values = kept
	field.MaxSelect = len(kept)
	return app.Save(col)
}

// reconcileSystemRolePermissions rewrites SYSTEM role rows to the compiled specs.
//
// Restricted to `is_system` rows on purpose. An operator who narrowed a custom
// role did so deliberately, and a migration that "reconciles" it would silently
// restore authority somebody deliberately removed — the one failure mode no
// later edit can detect.
//
// The compiled matrix is read from internal/auth rather than restated here, so
// this pass cannot drift from the specs it is supposed to enforce.
func reconcileSystemRolePermissions(app core.App) error {
	compiled := compiledRolePermissions()
	col, err := app.FindCollectionByNameOrId("roles")
	if err != nil {
		return err
	}
	rows, err := app.FindAllRecords(col)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if !row.GetBool("is_system") {
			continue
		}
		want, ok := compiled[row.GetString("role_id")]
		if !ok {
			continue
		}
		values := auth.PermissionValues(want)
		if samePermissionSet(row.GetStringSlice("permissions"), values) {
			continue
		}
		row.Set("permissions", values)
		if err := app.Save(row); err != nil {
			return fmt.Errorf("role %s: %w", row.GetString("role_id"), err)
		}
	}
	return nil
}

// samePermissionSet compares two permission lists as unordered sets.
//
// The order-tolerant comparison matters because PocketBase preserves whatever
// order a SelectField was handed, while the compiled specs are an unordered
// vocabulary. An order-sensitive compare would rewrite every system role on
// every single migration run, turning a reconciliation into a permanent write.
func samePermissionSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[string]int, len(a))
	for _, v := range a {
		counts[v]++
	}
	for _, v := range b {
		counts[v]--
		if counts[v] < 0 {
			return false
		}
	}
	return true
}
