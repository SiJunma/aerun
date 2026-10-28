package pocketbase

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const (
	outboxEventsCollectionName = "outbox_events"
	defaultOutboxBatchSize     = 20
)

// MailSender is the interface for dispatching emails from the outbox worker.
// It takes the whole payload rather than loose strings because the payload
// carries both bodies: the plain-text one and the HTML wrapper the shared
// email template produced. See pocketBaseMailSender for the multipart build.
type MailSender interface {
	Send(ctx context.Context, payload MailPayload) error
}

// MailPayload represents the structured data for an outbox email event.
type MailPayload struct {
	RecipientID string `json:"recipient_id"`
	ToEmail     string `json:"to_email"`
	Subject     string `json:"subject"`
	BodyText    string `json:"body_text"`
	// BodyHTML is the rendered shared-template wrapper. Empty means the event
	// predates HTML delivery or was queued by a plain-text path, and the
	// sender falls back to text-only.
	BodyHTML string `json:"body_html,omitempty"`
}

// enqueueOutboxEvent inserts a pending outbox event within a transaction.
// It is strictly idempotent: if an event with dedupeKey already exists, it is a no-op.
func enqueueOutboxEvent(txApp core.App, dedupeKey, eventType string, payload any) error {
	col, err := txApp.FindCollectionByNameOrId(outboxEventsCollectionName)
	if err != nil {
		return internalError("outbox_events collection unavailable", err)
	}

	// Fast pre-check: if dedupe_key exists, skip
	existing, err := txApp.FindFirstRecordByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:key}",
		dbx.Params{"key": dedupeKey},
	)
	if err == nil && existing != nil {
		txApp.Logger().Debug("outbox event suppressed by deduplicator", "dedupe_key", dedupeKey, "event_type", eventType)
		return nil
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return internalError("failed to serialize outbox payload", err)
	}

	record := core.NewRecord(col)
	record.Set("dedupe_key", dedupeKey)
	record.Set("event_type", eventType)
	record.Set("payload", types.JSONRaw(raw))
	record.Set("status", "pending")
	record.Set("attempts", 0)
	record.Set("max_attempts", messaging.MaxOutboxAttempts)
	record.Set("last_error", "")
	record.Set("next_attempt_at", "")
	record.Set("sent_at", "")

	if err := txApp.Save(record); err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "UNIQUE constraint failed") ||
			strings.Contains(errStr, "validation_not_unique") ||
			strings.Contains(errStr, "must be unique") {
			// Idempotent duplicate key under race condition
			return nil
		}
		return internalError("failed to enqueue outbox event", err)
	}

	return nil
}

func outboxEventPayload(rec *core.Record) map[string]any {
	var payload any
	raw := rec.Get("payload")
	if raw != nil {
		switch p := raw.(type) {
		case types.JSONRaw:
			_ = json.Unmarshal([]byte(p), &payload)
		case string:
			_ = json.Unmarshal([]byte(p), &payload)
		default:
			payload = p
		}
	}

	return map[string]any{
		"id":              rec.Id,
		"dedupe_key":      rec.GetString("dedupe_key"),
		"event_type":      rec.GetString("event_type"),
		"payload":         payload,
		"status":          rec.GetString("status"),
		"attempts":        rec.GetInt("attempts"),
		"max_attempts":    rec.GetInt("max_attempts"),
		"last_error":      rec.GetString("last_error"),
		"next_attempt_at": rec.GetString("next_attempt_at"),
		"sent_at":         rec.GetString("sent_at"),
		"created":         rec.GetDateTime("created").String(),
		"updated":         rec.GetDateTime("updated").String(),
	}
}

// OutboxWorker coordinates background dispatch of outbox events.
type OutboxWorker struct {
	BaseDelay time.Duration
}

// NewOutboxWorker constructs an OutboxWorker with default exponential backoff parameters.
func NewOutboxWorker() *OutboxWorker {
	return &OutboxWorker{
		BaseDelay: 30 * time.Second,
	}
}

// ProcessBatch processes a single batch of pending outbox events.
// Invariant (DoD): restarting the worker never resends an already successful ('sent') event.
func (w *OutboxWorker) ProcessBatch(ctx context.Context, app core.App, sender MailSender, batchSize int) (int, error) {
	if batchSize <= 0 {
		batchSize = defaultOutboxBatchSize
	}

	nowISO := time.Now().UTC().Format(time.RFC3339)

	// Fetch up to batchSize pending records eligible for dispatch
	records, err := app.FindRecordsByFilter(
		outboxEventsCollectionName,
		"status = 'pending' && (next_attempt_at = '' || next_attempt_at <= {:now})",
		"created",
		batchSize,
		0,
		dbx.Params{"now": nowISO},
	)
	if err != nil {
		return 0, err
	}

	processed := 0
	for _, rec := range records {
		if ctx.Err() != nil {
			break
		}

		// Double-check status: skip if already sent or failed
		if rec.GetString("status") != "pending" {
			continue
		}

		// If no sender configured (e.g. AERUN_MAIL_MODE=disabled / explicit no-SMTP mode),
		// we skip delivery without failing or crashing.
		if sender == nil {
			continue
		}

		var payload MailPayload
		rawPayload := rec.Get("payload")
		if rawPayload != nil {
			switch p := rawPayload.(type) {
			case types.JSONRaw:
				_ = json.Unmarshal([]byte(p), &payload)
			case string:
				_ = json.Unmarshal([]byte(p), &payload)
			default:
				data, _ := json.Marshal(p)
				_ = json.Unmarshal(data, &payload)
			}
		}

		// Notification emails are re-checked at dispatch time: up to a
		// minute passes between queue and send, and the recipient's state
		// may have changed in between (Firebase parity: DM mail only while
		// offline with unread mail; topic mail only while the toggle is on).
		switch rec.GetString("event_type") {
		case "email:dm_unread":
			if skipReason := dmEmailSkipReason(app, rec); skipReason != "" {
				rec.Set("status", "sent")
				rec.Set("sent_at", time.Now().UTC().Format(time.RFC3339))
				rec.Set("last_error", "skipped: "+skipReason)
				_ = app.Save(rec)
				processed++
				continue
			}
		case "email:topic_reply":
			if skipReason := topicReplyEmailSkipReason(app, rec); skipReason != "" {
				rec.Set("status", "sent")
				rec.Set("sent_at", time.Now().UTC().Format(time.RFC3339))
				rec.Set("last_error", "skipped: "+skipReason)
				_ = app.Save(rec)
				processed++
				continue
			}
		}

		sendErr := sender.Send(ctx, payload)
		if sendErr == nil {
			// Successful delivery: mark sent
			rec.Set("status", "sent")
			rec.Set("sent_at", time.Now().UTC().Format(time.RFC3339))
			rec.Set("last_error", "")
			_ = app.Save(rec)
			processed++
		} else {
			// Delivery failed: apply exponential backoff
			attempts := rec.GetInt("attempts") + 1
			maxAttempts := rec.GetInt("max_attempts")
			if maxAttempts <= 0 {
				maxAttempts = messaging.MaxOutboxAttempts
			}

			rec.Set("attempts", attempts)
			rec.Set("last_error", sendErr.Error())

			if attempts >= maxAttempts {
				rec.Set("status", "failed")
			} else {
				backoffMultiplier := math.Pow(2, float64(attempts-1))
				delay := time.Duration(float64(w.BaseDelay) * backoffMultiplier)
				nextAttempt := time.Now().UTC().Add(delay).Format(time.RFC3339)
				rec.Set("next_attempt_at", nextAttempt)
			}
			_ = app.Save(rec)
			processed++
		}
	}

	return processed, nil
}

// dmEmailSkipReason reports why a queued DM email must NOT be sent, or ""
// when it may go out.
//
// Firebase parity (onDmMessageCreated): no mail while the recipient is online,
// after they read the conversation, or when they disabled DM mail. A skipped
// event is retired as sent-with-reason rather than deleted, so the audit trail
// shows it was considered, not lost.
func dmEmailSkipReason(app core.App, rec *core.Record) string {
	now := time.Now()

	var payload MailPayload
	if raw := rec.Get("payload"); raw != nil {
		switch p := raw.(type) {
		case types.JSONRaw:
			_ = json.Unmarshal([]byte(p), &payload)
		case string:
			_ = json.Unmarshal([]byte(p), &payload)
		default:
			data, _ := json.Marshal(p)
			_ = json.Unmarshal(data, &payload)
		}
	}
	recipientID := payload.RecipientID
	conversationID := ""
	if key := rec.GetString("dedupe_key"); key != "" {
		conversationID = parseDMUnreadConversationID(key)
	}
	if recipientID == "" || conversationID == "" {
		return "unparseable dm_unread event"
	}

	if isMemberOnline(recipientID, now) || isMemberRecentlyActive(app, recipientID, now) {
		return "recipient online or recently active"
	}

	if user, err := app.FindRecordById(usersCollectionName, recipientID); err == nil && user != nil {
		if !dmEmailEnabled(user) {
			return "dm mail disabled"
		}
	}

	member, err := app.FindFirstRecordByFilter(
		dmMembersCollectionName,
		"conversation_id = {:conv} && user_id = {:user}",
		dbx.Params{"conv": conversationID, "user": recipientID},
	)
	if err != nil || member == nil {
		return "not a conversation member"
	}
	conv, err := app.FindRecordById(dmConversationsCollectionName, conversationID)
	if err != nil || conv == nil {
		return "conversation gone"
	}
	if conv.GetInt("messages_count") <= member.GetInt("last_read_sequence") {
		return "already read"
	}
	return ""
}

// parseDMUnreadConversationID extracts the conversation id from a
// dm:first-unread:{conversation}:{recipient} dedupe key.
func parseDMUnreadConversationID(dedupeKey string) string {
	const prefix = "dm:first-unread:"
	rest := strings.TrimPrefix(dedupeKey, prefix)
	if rest == dedupeKey {
		return ""
	}
	idx := strings.LastIndex(rest, ":")
	if idx <= 0 {
		return ""
	}
	return rest[:idx]
}

// adminListOutboxEventsHandler returns paginated outbox events for staff visibility.
func adminListOutboxEventsHandler(e *core.RequestEvent) error {
	limit := messaging.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), messaging.DefaultPageLimit), messaging.DefaultPageLimit)
	status := strings.TrimSpace(e.Request.URL.Query().Get("status"))

	query := e.App.RecordQuery(outboxEventsCollectionName)

	if status != "" {
		query = query.AndWhere(dbx.HashExp{"status": status})
	}

	query = query.OrderBy("created DESC", "id DESC").Limit(int64(limit))

	records := []*core.Record{}
	if err := query.All(&records); err != nil {
		return internalError("failed to query outbox events", err)
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = outboxEventPayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"limit":      limit,
		"request_id": requestIDFrom(e),
	})
}

// adminRetryOutboxEventHandler resets a failed outbox event back to pending.
func adminRetryOutboxEventHandler(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	rec, err := e.App.FindRecordById(outboxEventsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("outbox event not found")
	}

	rec.Set("status", "pending")
	rec.Set("attempts", 0)
	rec.Set("next_attempt_at", "")
	rec.Set("last_error", "")

	if err := e.App.Save(rec); err != nil {
		return internalError("failed to update outbox event", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"retried":    true,
		"event":      outboxEventPayload(rec),
		"request_id": requestIDFrom(e),
	})
}
