package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const dailyVisitsSummaryCollectionTable = "daily_visits_summary"

func init() {
	m.Register(createDailyVisitsSummarySchema, removeDailyVisitsSummarySchema)
}

func createDailyVisitsSummarySchema(app core.App) error {
	collection := core.NewBaseCollection(dailyVisitsSummaryCollectionTable)
	collection.Fields.Add(
		&core.TextField{Name: "date", Required: true, Max: 10},
		&core.NumberField{Name: "total_visits", OnlyInt: true},
		&core.NumberField{Name: "unique_visitors", OnlyInt: true},
		&core.NumberField{Name: "unique_members", OnlyInt: true},
		&core.NumberField{Name: "unique_guests", OnlyInt: true},
		&core.NumberField{Name: "bot_visits", OnlyInt: true},
		&core.NumberField{Name: "new_registrations", OnlyInt: true},
		&core.NumberField{Name: "posts_count", OnlyInt: true},
		&core.JSONField{Name: "countries_json"},
		&core.JSONField{Name: "devices_json"},
		&core.JSONField{Name: "entry_paths_json"},
	)

	// Deny-by-default: only server Go commands access daily_visits_summary
	lockBrowserRules(collection)

	collection.AddIndex("idx_daily_visits_date", true, "date", "")

	if err := app.Save(collection); err != nil {
		return fmt.Errorf("create daily_visits_summary collection: %w", err)
	}
	return nil
}

func removeDailyVisitsSummarySchema(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(dailyVisitsSummaryCollectionTable)
	if err != nil || collection == nil {
		return nil
	}
	return app.Delete(collection)
}
