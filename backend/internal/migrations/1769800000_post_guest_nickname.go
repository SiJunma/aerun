// 1769800000 adds a `guest_nickname` text field to posts and topics collections so
// guests can post under a chosen display name without an account.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return addGuestNicknameField(app)
	}, func(app core.App) error {
		return removeGuestNicknameField(app)
	})
}

func addGuestNicknameField(app core.App) error {
	// Posts collection
	posts, err := app.FindCollectionByNameOrId("posts")
	if err == nil {
		if posts.Fields.GetByName("guest_nickname") == nil {
			posts.Fields.Add(&core.TextField{Name: "guest_nickname", Max: 64})
			if err := app.Save(posts); err != nil {
				return fmt.Errorf("posts guest_nickname field: %w", err)
			}
		}
	}
	// Topics collection
	topics, err := app.FindCollectionByNameOrId("topics")
	if err == nil {
		if topics.Fields.GetByName("guest_nickname") == nil {
			topics.Fields.Add(&core.TextField{Name: "guest_nickname", Max: 64})
			if err := app.Save(topics); err != nil {
				return fmt.Errorf("topics guest_nickname field: %w", err)
			}
		}
		if topics.Fields.GetByName("last_post_guest_nickname") == nil {
			topics.Fields.Add(&core.TextField{Name: "last_post_guest_nickname", Max: 64})
			if err := app.Save(topics); err != nil {
				return fmt.Errorf("topics last_post_guest_nickname field: %w", err)
			}
		}
	}
	return nil
}

func removeGuestNicknameField(app core.App) error {
	posts, err := app.FindCollectionByNameOrId("posts")
	if err == nil && posts != nil {
		posts.Fields.RemoveByName("guest_nickname")
		if err := app.Save(posts); err != nil {
			return fmt.Errorf("remove posts guest_nickname field: %w", err)
		}
	}
	topics, err := app.FindCollectionByNameOrId("topics")
	if err == nil && topics != nil {
		topics.Fields.RemoveByName("guest_nickname")
		if err := app.Save(topics); err != nil {
			return fmt.Errorf("remove topics guest_nickname field: %w", err)
		}
	}
	return nil
}
