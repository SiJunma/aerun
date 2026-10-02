package migrations

// 1767900000_dm_tombstones.go lets a direct message be edited and deleted
// WITHOUT erasing the conversation, which is the opposite of what the forum
// does to a post.
//
// The owner drew the line: posts and topics are HARD deleted, a DM is SOFT.
// A message is history between two people, and both participants must keep
// seeing that something was said and where it sat in the thread. A hard delete
// would leave a hole in the transcript — replies referring to a message that no
// longer exists, and a "messages_count" that no longer matches the rows.
//
// So a deleted DM message KEEPS ITS ROW and its `sequence`, loses its `text`,
// and gains `deleted_at`. The reader sees a tombstone in place, exactly as a
// messenger does. The `sequence` column is retained here even though the forum
// dropped the same idea from posts: for posts it was an invented optimisation
// with no legacy behind it, while DM ordering genuinely needs a stable ordinal
// because a tombstone must not renumber the messages after it.
//
// `edited` marks that a message's text was changed after sending. It is a
// timestamp rather than a flag so the UI can say when, and it is left EMPTY
// for a message that was never touched, so "was this edited" is answerable
// without a boolean that is always false.
//
// A tombstone is also NOT editable: once deleted, the text is gone and there
// is nothing left to correct.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return addMessageLifecycleFields(app)
	}, func(app core.App) error {
		return removeMessageLifecycleFields(app)
	})
}

func addMessageLifecycleFields(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_messages")
	if err != nil {
		return fmt.Errorf("dm_messages: %w", err)
	}
	// Both optional: an existing message has neither an edit time nor a
	// deletion, and a NOT NULL default would rewrite the whole table for no
	// information. "Empty means never" is the whole contract.
	if col.Fields.GetByName("deleted_at") == nil {
		col.Fields.Add(&core.DateField{Name: "deleted_at"})
	}
	if col.Fields.GetByName("edited") == nil {
		col.Fields.Add(&core.DateField{Name: "edited"})
	}
	// `text` is relaxed to optional, and this is the load-bearing part of the
	// migration rather than a detail. It was declared Required when DM messages
	// had no lifecycle, so a tombstone — which by definition has no text —
	// could not be written at all: the delete failed with a validation error
	// and the row was left untouched.
	//
	// The schema now states what the tombstone actually is: a message with no
	// body and a deletion time. Relaxing the column is more honest than writing
	// a placeholder string like "[deleted]" into it, because a placeholder is
	// content the product never sent and would have to be special-cased in
	// every reader to avoid rendering as if the author had written it.
	if field, ok := col.Fields.GetByName("text").(*core.TextField); ok {
		field.Required = false
	}
	return app.Save(col)
}

func removeMessageLifecycleFields(app core.App) error {
	col, err := app.FindCollectionByNameOrId("dm_messages")
	if err != nil {
		return fmt.Errorf("dm_messages: %w", err)
	}
	// Rollback restores the fields as empty rather than dropping the rows: a
	// deleted message's TEXT is already gone, so the row is preserved as an
	// empty message rather than resurrected or removed. That is lossy by
	// design — the alternative is fabricating content.
	col.Fields.RemoveByName("deleted_at")
	col.Fields.RemoveByName("edited")
	if field, ok := col.Fields.GetByName("text").(*core.TextField); ok {
		field.Required = true
	}
	return app.Save(col)
}
