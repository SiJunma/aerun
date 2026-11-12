package pocketbase

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// TestIdempotencyPruneCron verifies SEC-09: idempotency keys older than 48 hours
// are pruned, while recent keys are preserved.
func TestIdempotencyPruneCron(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	col, err := app.FindCollectionByNameOrId(idempotencyCollection)
	if err != nil {
		t.Fatalf("collection %q must exist: %v", idempotencyCollection, err)
	}

	now := time.Now()

	// 1. Seed an old record (50 hours ago)
	oldRec := core.NewRecord(col)
	oldRec.Set("actor", "user1")
	oldRec.Set("key", "idem-old-key-1")
	oldRec.Set("request_hash", "hash1")
	oldRec.Set("response_json", `{"status":200,"body":"{}"}`)
	if err := app.Save(oldRec); err != nil {
		t.Fatal(err)
	}
	// Force created timestamp into the past (50h ago)
	oldTime := now.Add(-50 * time.Hour).UTC().Format("2006-01-02 15:04:05.000Z")
	_, err = app.DB().NewQuery("UPDATE " + idempotencyCollection + " SET created = {:t} WHERE id = {:id}").
		Bind(map[string]any{"t": oldTime, "id": oldRec.Id}).
		Execute()
	if err != nil {
		t.Fatal(err)
	}

	// 2. Seed a fresh record (1 hour ago)
	freshRec := core.NewRecord(col)
	freshRec.Set("actor", "user1")
	freshRec.Set("key", "idem-fresh-key-2")
	freshRec.Set("request_hash", "hash2")
	freshRec.Set("response_json", `{"status":200,"body":"{}"}`)
	if err := app.Save(freshRec); err != nil {
		t.Fatal(err)
	}

	// 3. Run prune
	pruned, err := pruneIdempotencyKeys(app, now)
	if err != nil {
		t.Fatalf("pruneIdempotencyKeys failed: %v", err)
	}
	if pruned != 1 {
		t.Fatalf("pruned = %d, want 1", pruned)
	}

	// 4. Verify old is gone, fresh remains
	if rec, _ := app.FindRecordById(idempotencyCollection, oldRec.Id); rec != nil {
		t.Errorf("old idempotency key should have been pruned")
	}
	if rec, _ := app.FindRecordById(idempotencyCollection, freshRec.Id); rec == nil {
		t.Errorf("fresh idempotency key must not be pruned")
	}
}
