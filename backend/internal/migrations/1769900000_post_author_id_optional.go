// 1769900000 makes posts.author_id and topics.author_id optional so guests can post without an account.
// Their display name is stored in posts.guest_nickname (migration 1769800000).
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return makeAuthorIdOptional(app)
	}, func(app core.App) error {
		return makeAuthorIdRequired(app)
	})
}

func makeAuthorIdOptional(app core.App) error {
	// Posts collection
	posts, err := app.FindCollectionByNameOrId("posts")
	if err == nil {
		field := posts.Fields.GetByName("author_id")
		if field != nil {
			textField, ok := field.(*core.TextField)
			if ok {
				textField.Required = false
				if err := app.Save(posts); err != nil {
					return fmt.Errorf("make posts.author_id optional: %w", err)
				}
			}
		}
	}
	// Topics collection
	topics, err := app.FindCollectionByNameOrId("topics")
	if err == nil {
		field := topics.Fields.GetByName("author_id")
		if field != nil {
			textField, ok := field.(*core.TextField)
			if ok {
				textField.Required = false
				if err := app.Save(topics); err != nil {
					return fmt.Errorf("make topics.author_id optional: %w", err)
				}
			}
		}
	}
	return nil
}

func makeAuthorIdRequired(app core.App) error {
	posts, err := app.FindCollectionByNameOrId("posts")
	if err == nil {
		field := posts.Fields.GetByName("author_id")
		if field != nil {
			textField, ok := field.(*core.TextField)
			if ok {
				textField.Required = true
				if err := app.Save(posts); err != nil {
					return fmt.Errorf("make posts.author_id required: %w", err)
				}
			}
		}
	}
	topics, err := app.FindCollectionByNameOrId("topics")
	if err == nil {
		field := topics.Fields.GetByName("author_id")
		if field != nil {
			textField, ok := field.(*core.TextField)
			if ok {
				textField.Required = true
				if err := app.Save(topics); err != nil {
					return fmt.Errorf("make topics.author_id required: %w", err)
				}
			}
		}
	}
	return nil
}