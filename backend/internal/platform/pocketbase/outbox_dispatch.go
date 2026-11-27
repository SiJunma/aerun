package pocketbase

// Outbox dispatch wiring (TASK-4).
//
// OutboxWorker.ProcessBatch was implemented and tested in Sprint 5, but
// nothing ever called it: run.go registered only the guest-presence prune. The
// queue therefore worked exactly as designed in the sense that nothing broke —
// and also exactly as designed in the sense that no DM or notification email
// would ever leave it, even once SMTP is configured on the VPS. A tested worker
// that is never scheduled is indistinguishable from a missing feature.
//
// Three properties this file exists to guarantee:
//
//   - ADR-6: with SMTP disabled the worker must not even look at the MAIL
//     rows. Marking a pending mail event `failed` because mail is switched
//     off would destroy the queue's only guarantee (invariant 4: delivery
//     happens after commit and can fail without losing the action), and it
//     would do so during the entire window before Sprint 8 — which is "now",
//     in every deployment that exists. Mail events stay `pending`, untouched,
//     and are drained when SMTP is enabled. Push events are exempt: they
//     have no mail transport, so the batch still runs for them with a nil
//     sender (ProcessBatch leaves mail rows alone when the sender is nil).
//   - No two batches may run at once. SQLite allows one writer; a slow SMTP
//     handshake can easily outlast the one-minute tick, and the overlap would
//     surface as SQLITE_BUSY rather than as anything recognisable.
//   - Sending happens through PocketBase's own mailer, so
//     MailHardDisableGuard stays the second boundary until Sprint 8 removes it
//     deliberately.

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/mailer"
)

const (
	// outboxDispatchJobID identifies the job in PocketBase's cron, mirroring
	// registerGuestPresenceCron.
	outboxDispatchJobID = "__aerunOutboxDispatch__"
	// outboxDispatchSchedule runs every minute. The worker only reads rows whose
	// next_attempt_at has passed, so a frequent tick costs one indexed query and
	// keeps the retry backoff honest (the smallest backoff step is 30 s).
	outboxDispatchSchedule = "* * * * *"
	// outboxDispatchBatch matches the worker default; the backoff means a burst
	// drains over several ticks rather than one.
	outboxDispatchBatch = 20
	// outboxDispatchTimeout bounds one tick. Without it a hung SMTP connection
	// would hold the in-flight flag forever and the queue would silently stop
	// after the first slow relay.
	outboxDispatchTimeout = 30 * time.Second
)

// outboxDispatchInFlight is the overlap guard. atomic rather than a mutex
// because the flag is never waited on: the tick either owns the batch or skips
// it, and skipping is the correct answer under contention (the next tick is at
// most a minute away).
var outboxDispatchInFlight atomic.Bool

// registerOutboxWorkerCron schedules the dispatch job.
//
// PocketBase starts its scheduler from an OnServe hook bound at priority 999,
// so a job registered from our own OnServe handler (default priority) is in
// place before the first tick — the same guarantee registerGuestPresenceCron
// documents. Re-registering the same job id replaces it, which keeps this
// idempotent for tests that bind OnServe more than once.
func registerOutboxWorkerCron(app core.App) error {
	return app.Cron().Add(outboxDispatchJobID, outboxDispatchSchedule, func() {
		dispatchOutboxOnce(app, time.Now())
	})
}

// dispatchOutboxOnce runs at most one batch. It returns the number of events
// processed so both the cron path and the tests observe the same behaviour, and
// it never returns an error to the caller: a failed batch is logged and retried
// on the next tick, which is exactly what the per-row backoff already assumes.
func dispatchOutboxOnce(app core.App, now time.Time) int {
	// ADR-6, narrowed to mail: with SMTP off the mail rows stay pending,
	// untouched — but the batch still runs, with a nil sender, so queued
	// push events (which need no mail transport) keep flowing. ProcessBatch
	// leaves mail rows alone when the sender is nil.
	mailDisabled := !app.Settings().SMTP.Enabled
	if mailDisabled {
		app.Logger().Debug("outbox dispatch: SMTP is disabled, mail events stay pending (ADR-6)",
			"reason", "mail hard-disabled; only push events dispatch")
	}

	if !outboxDispatchInFlight.CompareAndSwap(false, true) {
		app.Logger().Warn("outbox dispatch tick skipped: previous batch still running")
		return 0
	}
	defer outboxDispatchInFlight.Store(false)

	ctx, cancel := context.WithTimeout(context.Background(), outboxDispatchTimeout)
	defer cancel()

	worker := NewOutboxWorker()
	var sender MailSender
	if !mailDisabled {
		sender = pocketBaseMailSender{app: app}
	}
	processed, err := worker.ProcessBatch(ctx, app, sender, outboxDispatchBatch)
	if err != nil {
		app.Logger().Error("outbox dispatch failed", "error", err)
		return processed
	}
	if processed > 0 {
		app.Logger().Info("outbox batch processed", "events", processed, "at", now.UTC().Format(time.RFC3339))
	}
	return processed
}

// pocketBaseMailSender adapts PocketBase's mailer to the worker's MailSender
// interface. Going through app.NewMailClient() rather than dialling SMTP
// directly means the OnMailerSend hook — MailHardDisableGuard — still sees every
// attempt, so the hard-disable cannot be bypassed by the background worker.
type pocketBaseMailSender struct {
	app core.App
}

func (s pocketBaseMailSender) Send(ctx context.Context, payload MailPayload) error {
	to := strings.TrimSpace(payload.ToEmail)
	if to == "" {
		// An event with no recipient address is a data problem, not a
		// transport problem. Returning an error burns the retry budget and
		// ends as `failed`, which is the honest outcome for an undeliverable
		// message — but the worker records the reason in last_error, so it is
		// not silent.
		return errors.New("outbox event has no recipient address")
	}

	client := s.app.NewMailClient()
	if client == nil {
		return errors.New("no mail client is configured")
	}

	sender := s.app.Settings().Meta.SenderAddress
	if sender == "" {
		sender = "no-reply@aerun.invalid"
	}

	// BodyHTML carries the shared-template wrapper; BodyText is its
	// plain-text alternative. PocketBase builds a multipart/alternative
	// message when both are set and a text-only one when HTML is empty, so a
	// payload from before HTML delivery keeps sending exactly as it did.
	//
	// The subject goes through sanitizeMailSubject once more, here, as the
	// last line before the wire (SEC-07): payloads already in the outbox
	// were rendered before renderEmailFromTemplate sanitised, and a payload
	// that arrives by another path than that renderer would otherwise
	// cross the transport with its newlines intact.
	return client.Send(&mailer.Message{
		From:    mail.Address{Name: s.app.Settings().Meta.SenderName, Address: sender},
		To:      []mail.Address{{Address: to}},
		Subject: sanitizeMailSubject(payload.Subject),
		Text:    payload.BodyText,
		HTML:    payload.BodyHTML,
	})
}
