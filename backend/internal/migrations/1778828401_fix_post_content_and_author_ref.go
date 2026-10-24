// 1778828401_fix_post_content_and_author_ref.go fixes two runtime issues:
//
// 1. posts.content Max may be stuck at 5000 in some databases, causing
//    validation_max_text_constraint on post edits longer than 5000 chars.
//    Forces Max to 65536 (matching the schema in 1766100000).
//
// 2. last_post_author_ref columns (last_post_author_kind,
//    last_post_author_character_id, last_post_guest_display_name) may be
//    empty for existing topics, causing the frontend to show no author for
//    the last post. Re-derives them from each topic's newest visible post.
//
// Idempotent: safe to re-run.
package migrations

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(fixPostContentAndAuthorRef, revertFixPostContentAndAuthorRef)
}

func fixPostContentAndAuthorRef(app core.App) error {
	// Fix posts.content Max. Always save so PocketBase reloads the schema
	// into memory even if the DB value is already correct (a running server
	// may hold a stale in-memory copy from before the migration).
	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil {
		return fmt.Errorf("find posts collection: %w", err)
	}
	field := posts.Fields.GetByName("content")
	if field != nil {
		if textField, ok := field.(*core.TextField); ok {
			if textField.Max != 65536 {
				textField.Max = 65536
				app.Logger().Info("posts.content Max fixed 5000 -> 65536", "collection", postsCollectionTable)
			}
			if err := app.Save(posts); err != nil {
				return fmt.Errorf("reload posts collection schema: %w", err)
			}
		}
	}

	// Backfill last_post_author_ref for all topics
	topics, err := app.FindAllRecords(topicsCollectionTable)
	if err != nil {
		return fmt.Errorf("list topics for last-post author ref backfill: %w", err)
	}
	fixed := 0
	for _, topic := range topics {
		lastPostID := topic.GetString("last_post_id")
		if lastPostID == "" {
			topic.Set(lastPostAuthorKindField, "")
			topic.Set("last_post_author_character_id", "")
			topic.Set(lastPostGuestDisplayNameField, "")
			topic.Set("last_post_author_id", "")
			if err := app.Save(topic); err != nil {
				return fmt.Errorf("clear topic %s last-post author ref: %w", topic.Id, err)
			}
			fixed++
			continue
		}
		post, err := app.FindRecordById(postsCollectionTable, lastPostID)
		if err != nil || post == nil {
			continue
		}
		topic.Set("last_post_author_id", post.GetString("author_id"))
		topic.Set(lastPostAuthorKindField, post.GetString(authorKindField))
		topic.Set("last_post_author_character_id", post.GetString("author_character_id"))
		topic.Set(lastPostGuestDisplayNameField, strings.TrimSpace(post.GetString(guestDisplayNameField)))
		if err := app.Save(topic); err != nil {
			return fmt.Errorf("backfill topic %s last-post author ref: %w", topic.Id, err)
		}
		fixed++
	}
	app.Logger().Info("last-post author ref backfill complete", "collection", topicsCollectionTable, "topics", len(topics), "fixed", fixed)
	return nil
}

func revertFixPostContentAndAuthorRef(app core.App) error {
	return nil
}