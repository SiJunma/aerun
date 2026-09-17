package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1765900000_domain_foundation.go creates the first idempotency foundation
// table. Future sprints append new timestamped migrations; never edit an
// applied migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		collection := core.NewBaseCollection("idempotency_keys")

		collection.Fields.Add(
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.TextField{Name: "actor", Required: true, Max: 128},
			&core.TextField{Name: "key", Required: true, Max: 255},
			&core.TextField{Name: "request_hash", Required: true, Max: 64},
			&core.TextField{Name: "response_json"},
			&core.SelectField{Name: "status", MaxSelect: 1, Values: []string{"completed", "failed"}},
		)

		// Rules stay nil: browser access is locked (superuser-only); the Go
		// command layer writes through app hooks and never via HTTP rules.
		// UNIQUE(actor, key) enforces plan invariant 6 (section 3.4).
		collection.AddIndex("idx_idempotency_actor_key", true, "actor, key", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("idempotency_keys")
		if err != nil {
			return err
		}
		return app.Delete(collection)
	})
}
