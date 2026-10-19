// 1770000012_dm_visible_from_sequence.go adds the LOWER VISIBILITY BOUND to
// dm_members: the first message this participant still sees.
//
// WHY A SECOND BOUND. `cleared_sequence` is the READ horizon — how far the
// member has consumed the conversation, and therefore where the "new
// messages" line falls. `erased_sequence` is the ERASE point — how far the
// member has irreversibly discarded the conversation, and therefore where the
// physical deletion may start.
//
// Neither of them can express "this member starts a FRESH dialogue here".
// That is what the owner's rule (г) needs: a member who deleted a chat and
// then receives a new message from the peer must see that message as a NEW
// dialogue — the previous history must not reappear. Re-deriving that from
// the two existing horizons is impossible: the read horizon is about what has
// been consumed, and the erase point is about what may be deleted from the
// database, and neither of them is allowed to move backwards.
//
// So the visibility of a message to a participant is a WINDOW:
//
//	sequence > max(cleared_sequence, erased_sequence)   (the horizon)
//	AND
//	sequence >= visible_from_sequence                  (the window's lower edge)
//
// The default is 1 — every existing participant has always seen the whole
// conversation from the first message, and the backfill must not hide
// anything from anyone who was a member before this migration.
//
// The column is a NUMBER, not a boolean, for the same reason the other two
// are: a participant's window moves as messages arrive, and "from where do I
// see this conversation" is a position in the message stream, not a state.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(addDMVisibleFromSequence, removeDMVisibleFromSequence)
}

func addDMVisibleFromSequence(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_members")
	if err != nil || col == nil {
		return fmt.Errorf("dm_members collection: %w", err)
	}
	if col.Fields.GetByName("visible_from_sequence") == nil {
		col.Fields.Add(&core.NumberField{Name: "visible_from_sequence", OnlyInt: true})
	}
	if err := app.Save(col); err != nil {
		return fmt.Errorf("dm_members fields: %w", err)
	}

	// The backfill is 1, not 0: a 0 lower bound would hide nothing, but it
	// would also be indistinguishable from "no window" in every later
	// comparison, and the read filter compares with `>=`. 1 is the first
	// message of any conversation, so it means "seen from the start" — the
	// truth for every row that exists today.
	if _, err := app.DB().NewQuery(`
		UPDATE dm_members
		SET visible_from_sequence = 1
		WHERE visible_from_sequence IS NULL OR visible_from_sequence < 1
	`).Execute(); err != nil {
		return fmt.Errorf("dm_members visible_from_sequence backfill: %w", err)
	}
	return nil
}

// removeDMVisibleFromSequence drops the column on rollback.
//
// The backfilled 1 is NOT restored into anything: the two horizons that remain
// (`cleared_sequence`, `erased_sequence`) are untouched by the backfill, so
// the old model keeps working on the rows that were rewritten.
func removeDMVisibleFromSequence(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_members")
	if err != nil || col == nil {
		return fmt.Errorf("dm_members collection: %w", err)
	}
	col.Fields.RemoveByName("visible_from_sequence")
	if err := app.Save(col); err != nil {
		return fmt.Errorf("dm_members fields: %w", err)
	}
	return nil
}
