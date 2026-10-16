// 1770000001_author_ref_snapshot_repair.go is the explicit operator repair for
// databases restored from a snapshot taken before migration 1769800000/1770000000
// while the migration tracker still records them as applied.
//
// WHY THIS EXISTS. PocketBase migrations run ONCE. A restore that mixes an old
// data directory with a new tracker state never re-runs the schema migration
// on restart, and Record.Set on a missing field is a SILENT no-op — so every
// guest write would drop its nickname/display name without an error, and the
// forum index would render "Deleted user" for every guest. The audit forbids
// fixing this with silent runtime code at boot: the failure must either fail
// fast (verifyAuthorRefSchema) or be repaired by an explicit, reported,
// idempotent operator step. This migration is that step.
//
// WHAT IT DOES. For posts and topics it re-declares the exact columns the two
// source migrations own (guest_nickname, last_post_guest_nickname for topics,
// author_kind + guest_display_name for both), saves each collection only when
// something actually changed, then re-runs the AuthorRef backfill for rows
// whose author_kind is still empty. Rows that have neither an account id nor
// a guest display name stay deliberately unclassified and are counted in the
// Warn report — labelling damaged legacy data as a guest would invent an
// identity and make later moderation/audit misleading.
//
// Idempotent by construction: a healthy database finds no missing columns and
// no empty author_kind rows, so it writes nothing and reports zero repairs.
// The revert is a deliberate no-op: removing columns that live rows may carry
// would only resurrect the silent-drop this migration exists to fix.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyAuthorRefSnapshotRepair, revertAuthorRefSnapshotRepair)
}

func applyAuthorRefSnapshotRepair(app core.App) error {
	added, err := ensureAuthorRefSnapshotColumns(app)
	if err != nil {
		return err
	}
	if added > 0 {
		app.Logger().Info("author ref snapshot repair: restored missing columns", "columns", added)
	}
	// backfillAuthorRefs is safe to re-run: it skips rows that already carry an
	// author_kind and leaves unprovable rows unclassified with a Warn report.
	return backfillAuthorRefs(app)
}

func ensureAuthorRefSnapshotColumns(app core.App) (int, error) {
	added := 0
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return added, err
		}
		changed := false
		if collectionName == topicsCollectionTable {
			for _, field := range []struct {
				name string
				max  int
			}{
				{"guest_nickname", 64},
				{"last_post_guest_nickname", 64},
			} {
				if collection.Fields.GetByName(field.name) == nil {
					collection.Fields.Add(&core.TextField{Name: field.name, Max: field.max})
					changed = true
					added++
				}
			}
		} else {
			if collection.Fields.GetByName("guest_nickname") == nil {
				collection.Fields.Add(&core.TextField{Name: "guest_nickname", Max: 64})
				changed = true
				added++
			}
		}
		if collection.Fields.GetByName(authorKindField) == nil {
			collection.Fields.Add(&core.SelectField{
				Name:      authorKindField,
				MaxSelect: 1,
				Values:    []string{authorKindAccount, authorKindGuest},
			})
			changed = true
			added++
		}
		if collection.Fields.GetByName(guestDisplayNameField) == nil {
			collection.Fields.Add(&core.TextField{Name: guestDisplayNameField, Max: 64})
			changed = true
			added++
		}
		if changed {
			collection.AddIndex("idx_"+collectionName+"_author_kind", false, authorKindField, "")
			if err := app.Save(collection); err != nil {
				return added, err
			}
		}
	}
	return added, nil
}

func revertAuthorRefSnapshotRepair(app core.App) error {
	// No-op by design — see the file header. Removing columns that stored rows
	// may carry would break validation on the next save, and restoring the
	// pre-repair shape would only re-introduce the silent guest-drop.
	return nil
}
