package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const ipBansCollectionTable = "ip_bans"

func init() {
	m.Register(createIPBansSchema, removeIPBansSchema)
}

func createIPBansSchema(app core.App) error {
	collection := core.NewBaseCollection(ipBansCollectionTable)
	collection.Fields.Add(
		&core.TextField{Name: "ip_or_subnet", Required: true, Max: 50},
		&core.TextField{Name: "ip_start", Required: true, Max: 32},
		&core.TextField{Name: "ip_end", Required: true, Max: 32},
		&core.TextField{Name: "reason", Required: true, Max: 255},
		&core.TextField{Name: "banned_by", Required: true, Max: 15},
		&core.DateField{Name: "created_at"},
		&core.DateField{Name: "expires_at"},
		&core.BoolField{Name: "is_active"},
	)

	// Deny-by-default: only server Go commands access ip_bans
	lockBrowserRules(collection)

	collection.AddIndex("idx_ip_bans_lookup", false, "is_active, ip_start, ip_end", "")
	collection.AddIndex("idx_ip_bans_subnet", false, "ip_or_subnet", "")

	if err := app.Save(collection); err != nil {
		return fmt.Errorf("create ip_bans collection: %w", err)
	}
	return nil
}

func removeIPBansSchema(app core.App) error {
	collection, err := app.FindCollectionByNameOrId(ipBansCollectionTable)
	if err != nil || collection == nil {
		return nil
	}
	return app.Delete(collection)
}
