package pocketbase

// Tests for the TASK-4 outbox dispatch wiring.
//
// The worker itself was already covered by TestSprint5OutboxWorkerRetryAndDoD.
// What was untested — and what made the gap invisible — is the wiring: nothing
// called the worker at all. These tests pin the two properties the cron entry
// introduces, ADR-6 and the overlap guard.

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedPendingOutboxEvent writes one pending event, which is the state a DM or a
// notification leaves behind.
func seedPendingOutboxEvent(t testing.TB, app *tests.TestApp, dedupeKey, to string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(outboxEventsCollectionName)
	if err != nil {
		t.Fatalf("outbox_events collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("dedupe_key", dedupeKey)
	rec.Set("event_type", "dm_message")
	rec.Set("payload", []byte(`{"to_email":"`+to+`","subject":"hi","body_text":"there"}`))
	rec.Set("status", "pending")
	rec.Set("attempts", 0)
	rec.Set("max_attempts", 3)
	rec.Set("last_error", "")
	rec.Set("next_attempt_at", "")
	rec.Set("sent_at", "")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed outbox event: %v", err)
	}
	return rec
}

// TestDispatchOutboxLeavesRowsUntouchedWhenSMTPDisabled is the ADR-6 contract.
//
// The failure this prevents is quiet and expensive: with mail hard-disabled
// (which is every deployment today), a dispatch that tried and failed would walk
// every pending event through its retry budget and end as `failed`, and enabling
// SMTP later would then find an empty queue. The command's guarantee — commit
// first, deliver after, never lose the action — depends on the queue surviving.
func TestDispatchOutboxLeavesRowsUntouchedWhenSMTPDisabled(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	event := seedPendingOutboxEvent(t, app, "adr6-pending", "player@example.com")

	processed := dispatchOutboxOnce(app, time.Now())
	if processed != 0 {
		t.Fatalf("a disabled SMTP must process nothing, got %d", processed)
	}

	reloaded, err := app.FindRecordById(outboxEventsCollectionName, event.Id)
	if err != nil || reloaded == nil {
		t.Fatalf("event disappeared: %v", err)
	}
	if reloaded.GetString("status") != "pending" {
		t.Fatalf("status must stay pending, got %q", reloaded.GetString("status"))
	}
	if reloaded.GetInt("attempts") != 0 {
		t.Fatalf("attempt counter must stay 0, got %d", reloaded.GetInt("attempts"))
	}
	if reloaded.GetString("last_error") != "" {
		t.Fatalf("no error may be recorded for a send that was never attempted, got %q",
			reloaded.GetString("last_error"))
	}
}

// TestDispatchOutboxSkipsOverlappingTick covers the second property: two batches
// must never run at once. The first tick here is made to block by holding the
// in-flight flag, which is exactly the state a slow SMTP relay produces.
func TestDispatchOutboxSkipsOverlappingTick(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	event := seedPendingOutboxEvent(t, app, "overlap-pending", "player@example.com")

	// Simulate the previous tick still running.
	outboxDispatchInFlight.Store(true)
	defer outboxDispatchInFlight.Store(false)

	if processed := dispatchOutboxOnce(app, time.Now()); processed != 0 {
		t.Fatalf("an overlapping tick must process nothing, got %d", processed)
	}

	reloaded, err := app.FindRecordById(outboxEventsCollectionName, event.Id)
	if err != nil || reloaded == nil {
		t.Fatalf("event disappeared: %v", err)
	}
	if reloaded.GetString("status") != "pending" {
		t.Fatalf("a skipped tick must not touch the row, got %q", reloaded.GetString("status"))
	}
}

// TestRegisterOutboxWorkerCronIsIdempotent mirrors the presence prune: the
// OnServe hook can be bound more than once (every test that builds a server does
// it), and re-adding the same job id must replace rather than duplicate.
func TestRegisterOutboxWorkerCronIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	if err := registerOutboxWorkerCron(app); err != nil {
		t.Fatalf("first registration: %v", err)
	}
	if err := registerOutboxWorkerCron(app); err != nil {
		t.Fatalf("second registration must replace, not fail: %v", err)
	}
}

// TestOutboxSenderRejectsMissingRecipient covers the one input the transport
// cannot handle. Returning an error (rather than a nil "success") is what lets
// the worker record the reason and retire the event honestly instead of marking
// a message nobody will ever receive as sent.
func TestOutboxSenderRejectsMissingRecipient(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	sender := pocketBaseMailSender{app: app}
	if err := sender.Send(t.Context(), "   ", "subject", "body"); err == nil {
		t.Fatal("a blank recipient must be an error, not a silent success")
	}
}
