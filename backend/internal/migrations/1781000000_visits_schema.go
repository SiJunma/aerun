package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const visitsCollectionTable = "visits"

func init() {
	m.Register(createVisitsSchema, removeVisitsSchema)
}

func createVisitsSchema(app core.App) error {
	collection := core.NewBaseCollection(visitsCollectionTable)
	collection.Fields.Add(
		&core.DateField{Name: "occurred_at", Required: true},
		&core.TextField{Name: "user_id", Max: 15},
		&core.TextField{Name: "guest_id", Max: 64},
		&core.TextField{Name: "session_id", Required: true, Max: 64},
		&core.TextField{Name: "ip", Max: 45},
		&core.TextField{Name: "ip_hash", Required: true, Max: 64},
		&core.TextField{Name: "country", Max: 2},
		&core.TextField{Name: "city", Max: 100},
		&core.TextField{Name: "device", Max: 16},
		&core.TextField{Name: "browser", Max: 32},
		&core.TextField{Name: "os", Max: 32},
		&core.TextField{Name: "entry_path", Max: 255},
		&core.TextField{Name: "referrer", Max: 255},
		&core.BoolField{Name: "is_bot"},
	)

	// Deny-by-default: only server Go commands access visits
	lockBrowserRules(collection)

	collection.AddIndex("idx_visits_occurred_at", false, "occurred_at", "")
	collection.AddIndex("idx_visits_user", false, "user_id", "user_id != ''")
	collection.AddIndex("idx_visits_guest", false, "guest_id", "guest_id != ''")
	collection.AddIndex("idx_visits_session", false, "session_id", "")
	collection.AddIndex("idx_visits_ip_hash", false, "ip_hash", "")
	collection.AddIndex("idx_visits_country", false, "country", "")
	collection.AddIndex("idx_visits_entry_path", false, "entry_path", "")

	if err := app.Save(collection); err != nil {
		return fmt.Errorf("create visits collection: %w", err)
	}
	return nil
}

func removeVisitsSchema(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(visitsCollectionTable)
	if err != nil || collection == nil {
		return nil
	}
	return app.Delete(collection)
}
