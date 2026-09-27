package migrations

import (
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// TestGuestPresenceMigration covers 1766800000: the collection that restores
// anonymous visitor presence must exist with a server-only rule set, the visitor
// id must be shape-constrained and unique, and the up function must be able to
// rebuild the collection after a rollback.
func TestGuestPresenceMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	collection, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		t.Fatalf("guest_presence collection must exist after migrations: %v", err)
	}

	// Server-only. The legacy node this replaces was world-writable
	// (`.write: true`); the presence routes are the only writer now.
	for name, rule := range map[string]*string{
		"list":   collection.ListRule,
		"view":   collection.ViewRule,
		"create": collection.CreateRule,
		"update": collection.UpdateRule,
		"delete": collection.DeleteRule,
	} {
		if rule != nil {
			t.Fatalf("%s rule must stay server-only, got %q", name, *rule)
		}
	}

	field, ok := collection.Fields.GetByName("guest_id").(*core.TextField)
	if !ok {
		t.Fatal("guest_id must be a text field")
	}
	if !field.Required || field.Max != 64 {
		t.Fatalf("guest_id must be required and capped at 64, got required=%v max=%d", field.Required, field.Max)
	}
	for _, name := range []string{"first_seen", "last_seen"} {
		if _, ok := collection.Fields.GetByName(name).(*core.DateField); !ok {
			t.Fatalf("%s must be a date field", name)
		}
	}
	if idx := collection.GetIndex("idx_guest_presence_guest_id"); !strings.Contains(idx, "UNIQUE") {
		t.Fatalf("the visitor id index must be unique, got %q", idx)
	}
	if idx := collection.GetIndex("idx_guest_presence_last_seen"); idx == "" {
		t.Fatal("the last_seen index must exist: the window read and the prune both use it")
	}

	// One row per visitor. The heartbeat relies on this index to turn a
	// repeated beat into an update, so the constraint is part of the contract.
	seedGuestPresenceRow(t, app, "guestunique00001")
	if err := app.Save(newGuestPresenceRecord(t, app, "guestunique00001")); err == nil {
		t.Fatal("a duplicate guest_id must be rejected by the unique index")
	}

	// Rollback then re-apply: the down path drops the collection and the up
	// function has to be able to rebuild it from nothing.
	if err := app.Delete(collection); err != nil {
		t.Fatalf("roll back guest_presence: %v", err)
	}
	if _, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable); err == nil {
		t.Fatal("the collection must be gone after the rollback")
	}
	if err := createGuestPresence(app); err != nil {
		t.Fatalf("re-apply guest_presence: %v", err)
	}
	rebuilt, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		t.Fatalf("the collection must come back after re-applying: %v", err)
	}
	if rebuilt.GetIndex("idx_guest_presence_guest_id") == "" {
		t.Fatal("the rebuilt collection lost its visitor id index")
	}
}

// newGuestPresenceRecord builds an unsaved row for the guest_presence table.
func newGuestPresenceRecord(t *testing.T, app core.App, guestID string) *core.Record {
	t.Helper()

	collection, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		t.Fatalf("guest_presence collection: %v", err)
	}
	record := core.NewRecord(collection)
	record.Set("guest_id", guestID)
	record.Set("first_seen", time.Now())
	record.Set("last_seen", time.Now())
	return record
}

// seedGuestPresenceRow persists one visitor row.
func seedGuestPresenceRow(t *testing.T, app core.App, guestID string) {
	t.Helper()

	if err := app.Save(newGuestPresenceRecord(t, app, guestID)); err != nil {
		t.Fatalf("seed guest row: %v", err)
	}
}
