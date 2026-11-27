package pocketbase

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/SherClockHolmes/webpush-go"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const pushSubscriptionsCollectionName = "push_subscriptions"

// pushSubscriptionForm is the payload for subscribing a device to push.
type pushSubscriptionForm struct {
	Endpoint   string `json:"endpoint"`
	P256DHKey  string `json:"p256dhKey"`
	AuthKey    string `json:"authKey"`
	UserAgent  string `json:"userAgent"`
}

// vapidKeys holds the VAPID key pair for signing push requests.
type vapidKeys struct {
	PublicKey  string
	PrivateKey string
}

// PushEventPayload is the serialized payload stored in outbox_events for push dispatch.
type PushEventPayload struct {
	RecipientID string `json:"recipient_id"`
	EventType   string `json:"event_type"`
	Payload     any    `json:"payload"`
}

// getVAPIDKeys resolves the forum's VAPID keys from forum_settings.
func getVAPIDKeys(app core.App) (*vapidKeys, error) {
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return nil, fmt.Errorf("forum settings row not found")
	}

	publicKey := record.GetString("vapid_public_key")
	privateKey := record.GetString("vapid_private_key")

	if publicKey == "" || privateKey == "" {
		return nil, fmt.Errorf("VAPID keys not configured")
	}

	return &vapidKeys{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
	}, nil
}

// pushEnabled reports whether Web Push is enabled at the forum level.
func pushEnabled(app core.App) bool {
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return false
	}
	return record.GetBool("push_enabled")
}

// pushNotificationEnabled reads the recipient's push notification preference
// from settings.push_notifications.enabled, defaulting to true.
func pushNotificationEnabled(user *core.Record) bool {
	raw := user.Get("settings")
	if raw == nil {
		return true
	}
	var settings map[string]any
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &settings); err != nil {
			return true
		}
	case map[string]any:
		settings = v
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return true
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return true
		}
	}
	node, ok := settings["push_notifications"]
	if !ok || node == nil {
		return true
	}
	group, ok := node.(map[string]any)
	if !ok {
		if data, err := json.Marshal(node); err == nil {
			_ = json.Unmarshal(data, &group)
		}
	}
	if group == nil {
		return true
	}
	val, ok := group["enabled"]
	if !ok || val == nil {
		return true
	}
	if b, ok := val.(bool); ok {
		return b
	}
	return true
}

// deriveVAPIDSubject builds the VAPID JWT subject (mailto) from the forum's public URL.
func deriveVAPIDSubject(app core.App) string {
	appURL := app.Settings().Meta.AppURL
	if appURL == "" {
		appURL = "https://aerun.example.com"
	}
	appURL = strings.TrimRight(appURL, "/")
	return "mailto:" + appURL + "/admin"
}

// computeHMACSHA256 computes an HMAC-SHA256 signature.
func computeHMACSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// subscribePushHandler subscribes the caller's device to push notifications.
// POST /api/aerun/me/push/subscribe
func subscribePushHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}
	if !pushEnabled(e.App) {
		return forbiddenError("push notifications are disabled on this forum")
	}

	var form pushSubscriptionForm
	if err := json.NewDecoder(e.Request.Body).Decode(&form); err != nil {
		return validationError("invalid request body")
	}
	if form.Endpoint == "" || form.P256DHKey == "" || form.AuthKey == "" {
		return validationError("endpoint, p256dhKey and authKey are required")
	}

	_, err := e.App.FindFirstRecordByFilter(
		pushSubscriptionsCollectionName,
		"endpoint = {:endpoint} && user_id = {:user}",
		dbx.Params{"endpoint": form.Endpoint, "user": e.Auth.Id},
	)
	if err == nil {
		// Already subscribed — idempotent
		return e.JSON(http.StatusOK, map[string]any{
			"subscribed": true,
			"request_id": requestIDFrom(e),
		})
	}

	col, err := e.App.FindCollectionByNameOrId(pushSubscriptionsCollectionName)
	if err != nil {
		return internalError("push_subscriptions collection unavailable", err)
	}

	record := core.NewRecord(col)
	record.Set("user_id", e.Auth.Id)
	record.Set("endpoint", form.Endpoint)
	record.Set("p256dh", form.P256DHKey)
	record.Set("auth_key", form.AuthKey)
	record.Set("user_agent", form.UserAgent)

	if err := e.App.Save(record); err != nil {
		return internalError("failed to save push subscription", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"subscribed": true,
		"request_id": requestIDFrom(e),
	})
}

// unsubscribePushHandler removes the caller's push subscription by endpoint.
// DELETE /api/aerun/me/push/subscribe
func unsubscribePushHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	var form struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(e.Request.Body).Decode(&form); err != nil {
		return validationError("invalid request body")
	}
	if form.Endpoint == "" {
		return validationError("endpoint is required")
	}

	records, err := e.App.FindRecordsByFilter(
		pushSubscriptionsCollectionName,
		"endpoint = {:endpoint} && user_id = {:user}",
		"", 100, 0,
		dbx.Params{"endpoint": form.Endpoint, "user": e.Auth.Id},
	)
	if err != nil {
		return internalError("failed to find push subscriptions", err)
	}
	for _, rec := range records {
		if err := e.App.Delete(rec); err != nil {
			return internalError("failed to delete push subscription", err)
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"unsubscribed": true,
		"request_id":   requestIDFrom(e),
	})
}

// listPushSubscriptionsHandler returns the caller's registered push devices.
// GET /api/aerun/me/push/subscriptions
func listPushSubscriptionsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	records, err := e.App.FindRecordsByFilter(
		pushSubscriptionsCollectionName,
		"user_id = {:user}",
		"created DESC",
		100, 0,
		dbx.Params{"user": e.Auth.Id},
	)
	if err != nil {
		return internalError("failed to list push subscriptions", err)
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = map[string]any{
			"id":         r.Id,
			"endpoint":   r.GetString("endpoint"),
			"user_agent": r.GetString("user_agent"),
			"created":    r.GetDateTime("created").String(),
			"updated":    r.GetDateTime("updated").String(),
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"request_id":  requestIDFrom(e),
	})
}

// deletePushSubscriptionHandler removes a specific push subscription by id.
// DELETE /api/aerun/me/push/subscriptions/{id}
func deletePushSubscriptionHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	id := e.Request.PathValue("id")
	rec, err := e.App.FindRecordById(pushSubscriptionsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("push subscription not found")
	}
	if rec.GetString("user_id") != e.Auth.Id {
		return forbiddenError("you do not own this push subscription")
	}

	if err := e.App.Delete(rec); err != nil {
		return internalError("failed to delete push subscription", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"deleted":     true,
		"request_id":  requestIDFrom(e),
	})
}

// getVAPIDPublicKeyHandler returns the forum's VAPID public key for the client.
// GET /api/aerun/me/push/vapid-public-key
func getVAPIDPublicKeyHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}
	if !pushEnabled(e.App) {
		return forbiddenError("push notifications are disabled on this forum")
	}

	keys, err := getVAPIDKeys(e.App)
	if err != nil {
		return internalError("VAPID keys not configured", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"publicKey": keys.PublicKey,
		"request_id": requestIDFrom(e),
	})
}

// maybeEnqueuePushNotification queues a push notification for a recipient.
// It is called inside the same DB transaction as the triggering event (post,
// DM, etc.). The actual dispatch happens asynchronously via the outbox worker.
func maybeEnqueuePushNotification(txApp core.App, recipientID string, eventType string, payload PushEventPayload) error {
	if !pushEnabled(txApp) {
		return nil
	}

	user, err := txApp.FindRecordById(usersCollectionName, recipientID)
	if err != nil || user == nil {
		return nil
	}

	if !pushNotificationEnabled(user) {
		return nil
	}

	now := time.Now()
	if isMemberOnline(recipientID, now) || isMemberRecentlyActive(txApp, recipientID, now) {
		return nil
	}

	dedupeKey := fmt.Sprintf("push:%s:%s:%d", eventType, recipientID, now.UnixMilli())
	pushPayload := PushEventPayload{
		RecipientID: recipientID,
		EventType:   eventType,
		Payload:     payload,
	}

	raw, err := json.Marshal(pushPayload)
	if err != nil {
		return internalError("failed to serialize push payload", err)
	}

	col, err := txApp.FindCollectionByNameOrId(outboxEventsCollectionName)
	if err != nil {
		return internalError("outbox_events collection unavailable", err)
	}

	existing, err := txApp.FindFirstRecordByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:key}",
		dbx.Params{"key": dedupeKey},
	)
	if err == nil && existing != nil {
		return nil
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
			return nil
		}
		return internalError("failed to enqueue push event", err)
	}

	return nil
}

// sendPushToSubscription sends a push notification to a single subscription.
func sendPushToSubscription(app core.App, rec *core.Record, title, body, url string, badgeCount int) error {
	keys, err := getVAPIDKeys(app)
	if err != nil {
		return err
	}

	subscription := &webpush.Subscription{
		Endpoint: rec.GetString("endpoint"),
		Keys: webpush.Keys{
			P256dh: rec.GetString("p256dh"),
			Auth:   rec.GetString("auth_key"),
		},
	}

	payload := map[string]any{
		"title":       title,
		"body":        body,
		"url":         url,
		"badge_count": badgeCount,
		"tag":         "aerun-notification",
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	options := &webpush.Options{
		Subscriber:      deriveVAPIDSubject(app),
		VAPIDPublicKey:  keys.PublicKey,
		VAPIDPrivateKey: keys.PrivateKey,
		TTL:             86400,
	}

	resp, err := webpush.SendNotification(payloadBytes, subscription, options)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		if err := app.Delete(rec); err != nil {
			app.Logger().Warn("failed to delete dead push subscription", "error", err, "subscription_id", rec.Id)
		}
		return nil
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("push service returned status %d", resp.StatusCode)
	}

	return nil
}