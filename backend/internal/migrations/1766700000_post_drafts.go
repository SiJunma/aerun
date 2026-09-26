package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766700000_post_drafts.go turns posts into a drafts-capable table so the
// legacy `users/{uid}/drafts/{topicId}` documents (and the drafts page) have a
// real home. A draft is a post with is_draft=true, sequence 0 and no effect on
// any projection until it is published.
//
// Changes:
//   - `posts.is_draft` — false for every existing row.
//   - `posts.sequence` becomes optional: a draft carries 0, a published post
//     carries its per-topic monotonic number.
//   - `idx_posts_topic_sequence` gains the predicate `sequence > 0`, so any
//     number of drafts (sequence 0) in one topic can coexist while published
//     replies keep their uniqueness backstop.
//   - `idx_posts_draft` — unique(author_id, topic_id) where is_draft = true:
//     the legacy contract "one draft per user per topic" (the Firestore
//     document id was the topic id) survives as a database constraint.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
		if err != nil {
			return fmt.Errorf("find posts: %w", err)
		}

		seqField, ok := posts.Fields.GetByName("sequence").(*core.NumberField)
		if !ok {
			return fmt.Errorf("posts.sequence is not a number field")
		}
		seqField.Required = false

		if posts.Fields.GetByName("is_draft") == nil {
			posts.Fields.Add(&core.BoolField{Name: "is_draft"})
		}

		posts.RemoveIndex("idx_posts_topic_sequence")
		posts.AddIndex("idx_posts_topic_sequence", true, "topic_id, sequence", "sequence > 0")
		posts.AddIndex("idx_posts_drafts_unique", true, "author_id, topic_id", "is_draft = true")

		return app.Save(posts)
	}, func(app core.App) error {
		posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
		if err != nil {
			return err
		}
		posts.Fields.RemoveByName("is_draft")
		if seqField, ok := posts.Fields.GetByName("sequence").(*core.NumberField); ok {
			seqField.Required = true
		}
		posts.RemoveIndex("idx_posts_topic_sequence")
		posts.RemoveIndex("idx_posts_drafts_unique")
		posts.AddIndex("idx_posts_topic_sequence", true, "topic_id, sequence", "")
		return app.Save(posts)
	})
}
