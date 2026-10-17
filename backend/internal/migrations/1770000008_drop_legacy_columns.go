// 1770000008_drop_legacy_columns.go drops legacy columns replaced by AuthorRef
// (migration 1770000000) and the read cursor (migration 1770000007):
//
//   - posts.guest_nickname — replaced by posts.guest_display_name
//   - topics.guest_nickname — replaced by topics.guest_display_name
//   - topics.last_post_guest_nickname — replaced by topics.last_post_guest_display_name
//   - posts.sequence — replaced by created ASC, id ASC ordering
//
// author_id / last_post_author_id are KEPT: they carry the account id for
// account authors (author_kind is the discriminator, author_id is the value).
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(dropLegacyColumns, restoreLegacyColumns)
}

func dropLegacyColumns(app core.App) error {
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil || collection == nil {
			return fmt.Errorf("find %s collection: %w", collectionName, err)
		}
		if field := collection.Fields.GetByName("guest_nickname"); field != nil {
			collection.Fields.RemoveByName("guest_nickname")
		}
		if err := app.Save(collection); err != nil {
			return fmt.Errorf("drop %s.guest_nickname: %w", collectionName, err)
		}
	}

	topics, err := app.FindCollectionByNameOrId(topicsCollectionTable)
	if err != nil || topics == nil {
		return fmt.Errorf("find %s collection: %w", topicsCollectionTable, err)
	}
	if field := topics.Fields.GetByName("last_post_guest_nickname"); field != nil {
		topics.Fields.RemoveByName("last_post_guest_nickname")
	}
	if err := app.Save(topics); err != nil {
		return fmt.Errorf("drop topics.last_post_guest_nickname: %w", err)
	}

	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil || posts == nil {
		return fmt.Errorf("find %s collection: %w", postsCollectionTable, err)
	}
	if field := posts.Fields.GetByName("sequence"); field != nil {
		posts.RemoveIndex("idx_posts_topic_sequence")
		posts.Fields.RemoveByName("sequence")
	}
	if err := app.Save(posts); err != nil {
		return fmt.Errorf("drop posts.sequence: %w", err)
	}

	return nil
}

func restoreLegacyColumns(app core.App) error {
	// Re-adding dropped columns is a no-op revert: the data they held is gone,
	// and recreating empty columns serves no purpose. Legacy code paths no
	// longer read these columns.
	return nil
}