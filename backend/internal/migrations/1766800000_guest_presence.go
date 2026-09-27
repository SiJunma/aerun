package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// guestPresenceCollectionTable is the collection the presence routes write and
// read (internal/platform/pocketbase/presence.go).
const guestPresenceCollectionTable = "guest_presence"

// 1766800000_guest_presence.go restores anonymous visitor presence, which
// Sprint 6 deleted together with the RTDB status rows. The legacy contract lived
// in Firebase as `guest_presence/{guest_id} = { guest_id, last_seen }`
// (database.rules.json, public read); the Firestore `guest_activity` collection
// it had replaced is marked DEPRECATED in PROJECT_CONTEXT.md with the reason
// that matters here: "to eliminate document write costs". Presence is ephemeral
// and does not belong anywhere near the priced document writes.
//
// Two shape decisions are inherited from that contract, not invented here:
//
//   - The visitor id is a client-generated opaque string, not an account and
//     not a PocketBase id. There is no auth record behind a guest, so the row is
//     the only identity the counter can have.
//   - No PII. The row carries an id and two timestamps, exactly like the legacy
//     node. Storing IP or user-agent would turn "how many guests are reading
//     right now" into a record of who read what, and nobody asked for that.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return createGuestPresence(app)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable)
		if err != nil {
			return err
		}
		return app.Delete(collection)
	})
}

func createGuestPresence(app core.App) error {
	collection := core.NewBaseCollection(guestPresenceCollectionTable)
	collection.Fields.Add(
		// Text rather than the record id: the client generator
		// (Math.random().toString(36).substring(2) + Date.now().toString(36))
		// emits 18-19 characters, which does not fit PocketBase's 15-character
		// [a-z0-9] id space. The route validates the shape; the unique index
		// below enforces one row per visitor.
		&core.TextField{Name: "guest_id", Required: true, Max: 64},
		// Plain datetime fields, never autodate: first_seen is written once by
		// the heartbeat, and both values are the client-independent record of
		// when the visitor was last seen.
		&core.DateField{Name: "first_seen"},
		&core.DateField{Name: "last_seen"},
	)
	// Server-only, unlike the legacy node that any browser could write
	// (`.write: true`). The presence routes are the single validated ingress and
	// reads go through GET /presence/guests, so no client needs the collection
	// API at all — and an internet-facing table with a public create rule is not
	// something a rewrite should carry forward.
	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	// One row per visitor: the heartbeat upserts on this index, which is what
	// makes a repeated beat idempotent instead of piling up rows.
	collection.AddIndex("idx_guest_presence_guest_id", true, "guest_id", "")
	// Serves the online-window read and the retention prune.
	collection.AddIndex("idx_guest_presence_last_seen", false, "last_seen", "")
	return app.Save(collection)
}
