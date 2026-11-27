package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		// 1. Create push_subscriptions collection
		pushSubsCollection := core.NewBaseCollection("push_subscriptions")
		pushSubsCollection.Fields = append(pushSubsCollection.Fields,
			&core.TextField{Name: "user_id", Required: true, Max: 36},
			&core.TextField{Name: "endpoint", Required: true, Max: 1024},
			&core.TextField{Name: "p256dh", Required: true, Max: 256},
			&core.TextField{Name: "auth_key", Required: true, Max: 256},
			&core.TextField{Name: "user_agent", Max: 512},
		)
		// Deny all browser access - only server-side via /api/aerun/me/push/*
		pushSubsCollection.ListRule = nil
		pushSubsCollection.ViewRule = nil
		pushSubsCollection.CreateRule = nil
		pushSubsCollection.UpdateRule = nil
		pushSubsCollection.DeleteRule = nil

		if err := app.Save(pushSubsCollection); err != nil {
			return err
		}

		// 2. Add VAPID fields to forum_settings
		settingsCollection, err := app.FindCollectionByNameOrId("forum_settings")
		if err != nil {
			return err
		}

		settingsCollection.Fields = append(settingsCollection.Fields,
			&core.TextField{Name: "vapid_public_key", Max: 256},
			&core.TextField{Name: "vapid_private_key", Max: 256},
			&core.BoolField{Name: "push_enabled"},
		)

		return app.Save(settingsCollection)
	}, func(app core.App) error {
		// Revert: drop push_subscriptions collection
		pushSubs, err := app.FindCollectionByNameOrId("push_subscriptions")
		if err == nil {
			_ = app.Delete(pushSubs)
		}

		settingsCollection, err := app.FindCollectionByNameOrId("forum_settings")
		if err != nil {
			return err
		}

		settingsCollection.Fields.RemoveByName("vapid_public_key")
		settingsCollection.Fields.RemoveByName("vapid_private_key")
		settingsCollection.Fields.RemoveByName("push_enabled")

		return app.Save(settingsCollection)
	})
}

var _ = fmt.Sprint
