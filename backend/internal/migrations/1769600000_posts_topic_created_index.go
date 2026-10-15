package migrations

// Migration 1769600000: add composite index `(topic_id, created, id)` to `posts`.
//
// This index accelerates:
//  1. Chronological topic post pagination (ORDER BY created ASC, id ASC).
//  2. Deep-link post location (COUNT(*) WHERE topic_id = ? AND created <= ?).
//  3. Unread post cutoff calculation for `page=last|unread`.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
		if err != nil {
			return fmt.Errorf("find posts collection: %w", err)
		}

		posts.AddIndex("idx_posts_topic_created", false, "topic_id, created, id", "")
		return app.Save(posts)
	}, func(app core.App) error {
		posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
		if err != nil {
			return err
		}

		posts.RemoveIndex("idx_posts_topic_created")
		return app.Save(posts)
	})
}
