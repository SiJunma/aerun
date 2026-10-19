// 1770000011_dm_member_sequences.go moves the direct-message "hidden from me"
// horizon from a TIMESTAMP to a SEQUENCE.
//
// WHY. The horizon was `dm_members.cleared_at`, a text field holding the
// `created` instant of the last message the member had seen, and the message
// list filtered on it with a STRICT comparison:
//
//	query = query.AndWhere(dbx.NewExp("created > {:cleared_at}", …))
//
// `created` is a millisecond-resolution timestamp, so two messages written
// inside the same millisecond carry the SAME value. The clear anchors the
// horizon to the conversation's `last_message_at` (the previous message's
// own instant), and the reply that follows in that same millisecond then
// compares EQUAL, not greater — and vanishes from the thread until some
// later message moves the clock. The test that pins this contract
// (TestClearedConversationShowsTheNextMessageImmediately) fails roughly once
// in thirty runs, on the parent commit as much as on this one: a race, not a
// regression, and unfixable by moving the anchor.
//
// THE FIX IS THE ORDINAL, NOT THE CLOCK. `dm_messages.sequence` is
// monotonic within a conversation and has no resolution limit, so
// "hidden up to and including N" is exact:
//
//	hidden = sequence <= N
//
// This migration adds the three columns the new model needs and backfills
// them from what the timestamps already said:
//
//   - `cleared_sequence` — the READ horizon as an ordinal: messages up to and
//     including it are hidden from this member. Backfilled as the highest
//     message sequence in that conversation whose `created` is at or before the
//     stored `cleared_at`; 0 when the member had cleared nothing that still
//     exists.
//   - `deleted` — the owner's "Deleted" folder marker: this member moved the
//     chat out of their inbox. A BOOLEAN and not a sequence, because the
//     horizon of a chat with no messages is 0, and "deleted at sequence 0"
//     would be indistinguishable from "not deleted".
//   - `erased_sequence` — the ERASE marker: this member erased the chat for
//     THEMSELVES, irreversibly, and will never read it again. It is the
//     per-member half of the hard-delete rule, and a sequence rather than a
//     boolean because "erased up to N" is what the rule needs: a member who
//     erased when the chat held five messages has discarded exactly those
//     five, and a later message in the same chat is not covered.
//
// `cleared_at` is KEPT: it is the import source (`social_import.go` writes it
// from the legacy Firebase export) and it is what the backfill reads. The
// runtime stops using it; a later migration may drop it once every live
// database has been backfilled.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(addDMMemberSequences, removeDMMemberSequences)
}

func addDMMemberSequences(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_members")
	if err != nil || col == nil {
		return fmt.Errorf("dm_members collection: %w", err)
	}
	if col.Fields.GetByName("cleared_sequence") == nil {
		col.Fields.Add(&core.NumberField{Name: "cleared_sequence", OnlyInt: true})
	}
	if col.Fields.GetByName("deleted") == nil {
		col.Fields.Add(&core.BoolField{Name: "deleted"})
	}
	if col.Fields.GetByName("erased_sequence") == nil {
		col.Fields.Add(&core.NumberField{Name: "erased_sequence", OnlyInt: true})
	}
	if err := app.Save(col); err != nil {
		return fmt.Errorf("dm_members fields: %w", err)
	}

	// Backfill the horizon from the timestamps the old model stored.
	//
	// The join is the whole point: a member's `cleared_at` is a wall-clock
	// instant, and the messages it refers to are found by their OWN `created`.
	// Taking the MAX sequence among them yields the exact boundary the
	// timestamp filter was approximating.
	_, err = app.DB().NewQuery(`
		UPDATE dm_members
		SET cleared_sequence = COALESCE((
			SELECT MAX(m.sequence)
			FROM dm_messages m
			WHERE m.conversation_id = dm_members.conversation_id
			  AND m.created <= dm_members.cleared_at
		), 0)
		WHERE cleared_at IS NOT NULL AND cleared_at != ''
	`).Execute()
	if err != nil {
		return fmt.Errorf("dm_members cleared_sequence backfill: %w", err)
	}
	return nil
}

// removeDMMemberSequences drops the two columns on rollback.
//
// The backfilled values are NOT restored into `cleared_at`: the old field
// still holds the timestamp it always held, so the old model keeps working
// on the rows that were backfilled. A member whose horizon was re-expressed
// as an ordinal is, after a rollback, back to the timestamp that was always
// there — the approximation the old filter had.
func removeDMMemberSequences(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_members")
	if err != nil || col == nil {
		return fmt.Errorf("dm_members collection: %w", err)
	}
	col.Fields.RemoveByName("cleared_sequence")
	col.Fields.RemoveByName("deleted")
	col.Fields.RemoveByName("erased_sequence")
	if err := app.Save(col); err != nil {
		return fmt.Errorf("dm_members fields: %w", err)
	}
	return nil
}
