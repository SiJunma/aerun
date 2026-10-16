// 1770000002_last_post_author_ref_schema.go adds the last-post AuthorRef
// variant to the topics collection.
//
// WHY A SECOND MIGRATION. Migration 1770000000 introduced the opener/post
// AuthorRef (author_kind + guest_display_name) but left the last-post
// projection on the legacy pair (last_post_author_id +
// last_post_guest_nickname) plus the mask. The audit's Stage 2 unifies every
// writer through setLastPostProjection/rebuildTopicProjection, and that
// projection needs its own variant column: without it the topic row cannot
// tell "last post by a guest" from "last post by a deleted account" from
// "legacy row the backfill never classified".
//
// WHAT IT DOES. Adds last_post_author_kind (select account/guest) and
// last_post_guest_display_name (text 64) to topics, with an index on the
// variant, then classifies existing rows: a projection pointing at a post row
// inherits that post's variant; otherwise account id implies account, guest
// nickname implies guest, and rows with neither stay unclassified with a Warn
// report. Idempotent by construction; the revert removes only the two new
// columns and their index.
package migrations

import (
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const (
	lastPostAuthorKindField       = "last_post_author_kind"
	lastPostGuestDisplayNameField = "last_post_guest_display_name"
)

func init() {
	m.Register(addLastPostAuthorRefSchema, removeLastPostAuthorRefSchema)
}

func addLastPostAuthorRefSchema(app core.App) error {
	topics, err := app.FindCollectionByNameOrId(topicsCollectionTable)
	if err != nil || topics == nil {
		return fmt.Errorf("find topics collection: %w", err)
	}
	if topics.Fields.GetByName(lastPostAuthorKindField) == nil {
		topics.Fields.Add(&core.SelectField{
			Name:      lastPostAuthorKindField,
			MaxSelect: 1,
			Values:    []string{authorKindAccount, authorKindGuest},
		})
	}
	if topics.Fields.GetByName(lastPostGuestDisplayNameField) == nil {
		topics.Fields.Add(&core.TextField{Name: lastPostGuestDisplayNameField, Max: 64})
	}
	topics.AddIndex("idx_topics_last_post_author_kind", false, lastPostAuthorKindField, "")
	if err := app.Save(topics); err != nil {
		return fmt.Errorf("save topics last-post author ref schema: %w", err)
	}
	return backfillLastPostAuthorRefs(app)
}

// backfillLastPostAuthorRefs classifies the existing last-post projection.
// A projection whose last_post_id still resolves to a post row inherits that
// row's variant — the post is the authority. Otherwise the legacy pair
// decides: account id implies account, guest nickname implies guest, and a
// projection with neither stays unclassified and is counted, never invented.
func backfillLastPostAuthorRefs(app core.App) error {
	topics, err := app.FindAllRecords(topicsCollectionTable)
	if err != nil {
		return fmt.Errorf("list topics for last-post author ref backfill: %w", err)
	}
	unknown := 0
	for _, topic := range topics {
		if topic.GetString(lastPostAuthorKindField) != "" {
			continue
		}
		if lastPostID := topic.GetString("last_post_id"); lastPostID != "" {
			if post, err := app.FindRecordById(postsCollectionTable, lastPostID); err == nil && post != nil {
				switch post.GetString(authorKindField) {
				case authorKindAccount:
					topic.Set(lastPostAuthorKindField, authorKindAccount)
					topic.Set(lastPostGuestDisplayNameField, "")
				case authorKindGuest:
					topic.Set(lastPostAuthorKindField, authorKindGuest)
					topic.Set(lastPostGuestDisplayNameField, strings.TrimSpace(post.GetString(guestDisplayNameField)))
				default:
					unknown++
					continue
				}
				if err := app.Save(topic); err != nil {
					return fmt.Errorf("backfill topics last-post author ref %s: %w", topic.Id, err)
				}
				continue
			}
		}
		authorID := strings.TrimSpace(topic.GetString("last_post_author_id"))
		guestName := strings.TrimSpace(topic.GetString("last_post_guest_nickname"))
		switch {
		case authorID != "":
			topic.Set(lastPostAuthorKindField, authorKindAccount)
			topic.Set(lastPostGuestDisplayNameField, "")
		case guestName != "":
			topic.Set(lastPostAuthorKindField, authorKindGuest)
			topic.Set(lastPostGuestDisplayNameField, guestName)
		default:
			unknown++
			continue
		}
		if err := app.Save(topic); err != nil {
			return fmt.Errorf("backfill topics last-post author ref %s: %w", topic.Id, err)
		}
	}
	if unknown > 0 {
		app.Logger().Warn("last-post author ref backfill left legacy rows unclassified", "collection", topicsCollectionTable, "count", unknown)
	}
	return nil
}

func removeLastPostAuthorRefSchema(app core.App) error {
	topics, err := app.FindCollectionByNameOrId(topicsCollectionTable)
	if err != nil || topics == nil {
		return fmt.Errorf("find topics collection: %w", err)
	}
	topics.RemoveIndex("idx_topics_last_post_author_kind")
	topics.Fields.RemoveByName(lastPostAuthorKindField)
	topics.Fields.RemoveByName(lastPostGuestDisplayNameField)
	if err := app.Save(topics); err != nil {
		return fmt.Errorf("remove topics last-post author ref schema: %w", err)
	}
	return nil
}
