package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// realtimeSignalsCollectionTable is the nudge queue realtime reads from
// (internal/platform/pocketbase/realtime_signals.go).
const realtimeSignalsCollectionTable = "realtime_signals"

// realtimeSignalsAudienceAll is the audience_id wildcard: a signal every signed-in
// member may be told about.
const realtimeSignalsAudienceAll = "*"

// realtimeSignalsReadRule is the ONE rule this collection has, and it is safe
// only because of what the table does not contain.
//
// The rule admits a row to its own recipient, and to everyone for the public
// wildcard. That is a wide rule — and on any other collection here it would be
// a disaster, because on those the row IS the message, the post, the member's
// settings. Here a row is four short fields carrying no forum content, so the
// widest possible read reveals nothing a subscriber did not already know.
//
// The first clause is the guest exclusion, and it is deliberate: a signed-out
// visitor's `auth.id` is "", which matches neither an audience_id nor the
// wildcard, so guests receive no signals at all and keep polling. Re-opening
// anonymous access is not worth a faster badge.
const realtimeSignalsReadRule = `@request.auth.id != "" && ` +
	`(audience_id = @request.auth.id || audience_id = "` + realtimeSignalsAudienceAll + `")`

// 1768400000_realtime_signals.go adds the collection realtime delivers through.
//
// WHY THIS TABLE EXISTS AT ALL. PocketBase v0.40.4 has no `RealtimeRule`: a
// realtime subscription is authorized by the very same ListRule/ViewRule that
// REST uses (`apis/realtime.go:605-614` maps `collection/<id>` to ViewRule and
// `collection/*` to ListRule). So enabling realtime for a collection's CONTENT
// is enabling REST reads on that content — there is no second, narrower door.
//
// That rules out streaming posts, DMs and notifications directly. What can be
// streamed is a table that carries no forum data, so the client learns "something
// changed over here" and re-reads it through `/api/aerun`, where authorization
// already lives and is already tested. The browser never receives forum content
// over SSE; it receives an id.
//
// THE FIELDS ARE DELIBERATELY BORING. topic, entity_id, audience_id, at. No
// title, no body, no nickname, no counter. A gate asserts this stays true — the
// invariant is the absence of content, and it is exactly the kind of thing that
// gets "improved" into a leak by someone adding a convenience column.
//
// THERE IS NO `at`-FREE RETENTION STORY HERE because these rows are pure
// notification scaffolding: the only reader is a client that will re-read within
// a poll interval, so anything older than a few minutes is dead weight.
// publishSignal prunes them opportunistically rather than on a cron, because a
// background scheduler is a thing that has to survive every test and every
// shutdown, and this does not need to exist between writes.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		collection := core.NewBaseCollection(realtimeSignalsCollectionTable)
		collection.Fields.Add(
			// What changed, as a name this codebase already knows. Kept short and
			// closed by convention rather than by a lookup table: the client
			// switches on it, and a typo here costs a missed refresh that polling
			// then covers anyway.
			&core.TextField{Name: "topic", Required: true, Max: 64},
			// The id of the thing that changed — a topic, a conversation, a
			// notification row. An id and nothing else. Whatever the client does
			// with it, it has to go back through the command layer to get content.
			&core.TextField{Name: "entity_id", Max: 15},
			// The one member who should hear about it, or "*". This is the whole
			// authorization story of the table.
			&core.TextField{Name: "audience_id", Required: true, Max: 15},
			// Explicit rather than an autodate `created`: the prune compares
			// against a retention window, and an autodate column is not something
			// to reason about when the row may be written out of order.
			&core.DateField{Name: "at"},
		)
		collection.ListRule = ptr(realtimeSignalsReadRule)
		collection.ViewRule = ptr(realtimeSignalsReadRule)
		// Server-only writes, like every other collection the command layer owns.
		// A client that could write a signal could aim one at somebody else.
		collection.CreateRule = nil
		collection.UpdateRule = nil
		collection.DeleteRule = nil
		// The client's subscription filter, which is `audience_id` first.
		collection.AddIndex("idx_realtime_signals_audience_at", false, "audience_id, at", "")
		// The prune, which is `at` alone.
		collection.AddIndex("idx_realtime_signals_at", false, "at", "")
		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId(realtimeSignalsCollectionTable)
		if err != nil {
			return err
		}
		return app.Delete(collection)
	})
}

// ptr returns a pointer to a rule string, which is how every collection in this
// schema assigns a non-nil rule: the field is *string precisely so that nil can
// mean "locked" and a pointer to "" can mean "set but empty".
func ptr(s string) *string { return &s }
