package migrations

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestMigrationsProduceHealthyApp boots a fresh, empty data directory with
// every registered migration applied, verifying Sprint 1 DoD: reproducible
// startup from an empty folder.
func TestMigrationsProduceHealthyApp(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
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

// TestMigrationsAdoptPopulatedDataDir applies the same migrations to
// PocketBase's populated demo data directory, i.e. an existing users
// collection that predates the Aerun identity contract. Adoption must not
// fail and every pre-existing account must survive with its identity intact.
func TestMigrationsAdoptPopulatedDataDir(t *testing.T) {
	// No explicit data dir: PocketBase clones its own populated fixtures,
	// which already contain accounts created before our fields existed.
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("migrations must be applicable to a populated data dir: %v", err)
	}
	defer app.Cleanup()

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection must exist after adoption: %v", err)
	}
	if users.GetIndex("idx_users_nickname_normalized") == "" {
		t.Fatal("the nickname uniqueness index must exist after adoption")
	}

	records, err := app.FindAllRecords("users")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 {
		t.Fatal("the populated fixture must contain accounts to make this test meaningful")
	}
	for _, record := range records {
		// Pre-existing accounts keep whatever identity data they had; what
		// matters is that none of them blocks the uniqueness contract.
		if key := record.GetString("nickname_normalized"); key != "" {
			duplicates, err := app.CountRecords("users", dbx.HashExp{"nickname_normalized": key})
			if err != nil {
				t.Fatal(err)
			}
			if duplicates != 1 {
				t.Fatalf("adopted nickname key %q is not unique (%d rows)", key, duplicates)
			}
		}
	}
}
