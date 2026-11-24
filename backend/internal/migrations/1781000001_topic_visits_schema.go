package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const topicVisitsCollectionTable = "topic_visits"

func init() {
	m.Register(createTopicVisitsSchema, removeTopicVisitsSchema)
}

func createTopicVisitsSchema(app core.App) error {
	collection := core.NewBaseCollection(topicVisitsCollectionTable)
	collection.Fields.Add(
		&core.TextField{Name: "topic_id", Required: true, Max: 15},
		&core.DateField{Name: "occurred_at", Required: true},
		&core.TextField{Name: "user_id", Max: 15},
		&core.TextField{Name: "guest_id", Max: 64},
		&core.TextField{Name: "session_id", Required: true, Max: 64},
	)

	// Deny-by-default: only server Go commands access topic_visits
	lockBrowserRules(collection)

	collection.AddIndex("idx_topic_visits_topic", false, "topic_id", "")
	collection.AddIndex("idx_topic_visits_session", false, "session_id", "")
	collection.AddIndex("idx_topic_visits_occurred_at", false, "occurred_at", "")

	if err := app.Save(collection); err != nil {
		return fmt.Errorf("create topic_visits collection: %w", err)
	}
	return nil
}

func removeTopicVisitsSchema(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(topicVisitsCollectionTable)
	if err != nil || collection == nil {
		return nil
	}
	return app.Delete(collection)
}
