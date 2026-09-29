package migrations

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestUserLastSeenBackfill proves the never-empty contract holds for every
// account that already existed when the column was introduced.
//
// The members table's LAST SEEN column rendered "..." for anyone not connected
// at that instant, because nothing durable recorded a last visit. The fix is
// this column, and its floor is `created`: registration is provably real
// activity, so seeding from it can only understate how recently someone was
// here. It must never be the zero time, and it must never be "now".
func TestUserLastSeenBackfill(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	if users.Fields.GetByName("last_seen") == nil {
		t.Fatal("users must carry a last_seen column")
	}

	// Queried raw rather than through the record API on purpose. A record read
	// would apply the same validation that makes this migration necessary in
	// the first place, and the fixture rows that predate the identity contract
	// cannot be loaded as records at all. The column is what the members table
	// actually reads, so the column is what gets asserted.
	var raw []dbx.NullStringMap
	if err := app.DB().NewQuery(
		"SELECT `id`, `created`, `last_seen` FROM `users`",
	).All(&raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 {
		t.Fatal("the populated fixture must contain accounts to make this test meaningful")
	}
	for _, row := range raw {
		id := row["id"].String
		created := row["created"].String
		seen := row["last_seen"].String
		if seen == "" {
			t.Fatalf("account %s was left with an empty last_seen", id)
		}
		if created == "" {
			t.Fatalf("account %s has no created date to fall back to", id)
		}
		// The backfill must reproduce the registration date exactly, not an
		// approximation and not the migration's own clock.
		if seen != created {
			t.Fatalf("account %s: last_seen %q must be seeded from created %q", id, seen, created)
		}
	}
}

// TestUserLastSeenIsNotAutodate pins the field type. A Last seen column that
// PocketBase overwrote on every write would be worse than none: the heartbeat
// sets it explicitly, and an autodate would make it mean "when the row was
// edited", which is the trap the whole change exists to avoid.
func TestUserLastSeenIsNotAutodate(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	field := users.Fields.GetByName("last_seen")
	if _, ok := field.(*core.DateField); !ok {
		t.Fatalf("last_seen must be a plain date field the server writes explicitly, got %T", field)
	}
	if _, isAutodate := field.(*core.AutodateField); isAutodate {
		t.Fatal("last_seen must not be an autodate: it would be overwritten on every " +
			"save and report an edit time as a visit time")
	}
}
