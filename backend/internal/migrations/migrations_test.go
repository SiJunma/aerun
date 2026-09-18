package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestMigrationsProduceHealthyApp boots a fresh data directory with every
// registered migration applied, verifying Sprint 1 DoD: reproducible startup
// from an empty folder.
func TestMigrationsProduceHealthyApp(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	collection, err := app.FindCollectionByNameOrId("idempotency_keys")
	if err != nil {
		t.Fatalf("idempotency_keys collection must exist after migrations: %v", err)
	}
	if collection.Fields.GetByName("actor") == nil {
		t.Fatal("actor field must exist")
	}
	var _ core.App = app
}
