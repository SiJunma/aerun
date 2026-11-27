package pocketbase

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/SherClockHolmes/webpush-go"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const pushSubscriptionsCollectionName = "push_subscriptions"

// pushSubscriptionForm is the payload for subscribing a device to push.
type pushSubscriptionForm struct {
	Endpoint  string `json:"endpoint"`
	P256DHKey string `json:"p256dhKey"`
	AuthKey   string `json:"authKey"`
	UserAgent string `json:"userAgent"`
}

// vapidKeys holds the VAPID key pair for signing push requests.
type vapidKeys struct {
	PublicKey  string
	PrivateKey string
}

// PushContent is the notification itself: what the device shows and where
// a tap leads. maybeEnqueuePushNotification stores it FLAT in the outbox
// row — recipient_id, event_type, title, body, url, badge_count at the top
// level — which is exactly the shape processPushEvent reads. The previous
// shape wrapped a whole PushEventPayload inside another one, so the dispatch
// side always read empty title/body/url.
type PushContent struct {
	Title      string `json:"title"`
	Body       string `json:"body"`
	URL        string `json:"url"`
	BadgeCount int    `json:"badge_count"`
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

// deriveVAPIDSubject builds the VAPID JWT subject from the forum's public
// URL. The subject must be a mailto: URI or an https: URL (RFC 8292): the
// previous shape — "mailto:" + the whole URL + "/admin" — was neither, so
// it is now a plain admin mailbox on the forum's host.
func deriveVAPIDSubject(app core.App) string {
	appURL := strings.TrimSpace(app.Settings().Meta.AppURL)
	if appURL != "" {
		if u, err := url.Parse(appURL); err == nil && u.Hostname() != "" {
			return "mailto:admin@" + u.Hostname()
		}
		if strings.HasPrefix(appURL, "mailto:") {
			return appURL
		}
	}
	return "mailto:admin@aerun.invalid"
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
		"items":      items,
		"request_id": requestIDFrom(e),
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
		"deleted":    true,
		"request_id": requestIDFrom(e),
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
		"publicKey":  keys.PublicKey,
		"request_id": requestIDFrom(e),
	})
}

// pushContentForNotification derives the push content of an in-app
// notification from the title createNotification already computed and the
// payload its caller attached. Topic notifications carry topic_id/post_id
// and author_nickname, so the tap opens the post itself; anything else
// links to the notifications feed, with the acting nickname as the body
// when the payload names one.
func pushContentForNotification(title string, payload any) PushContent {
	content := PushContent{Title: title, URL: "/notifications"}
	fields, ok := payload.(map[string]any)
	if !ok {
		return content
	}
	if topicID, _ := fields["topic_id"].(string); topicID != "" {
		url := "/topic/" + topicID
		if postID, _ := fields["post_id"].(string); postID != "" {
			url += "?post=" + postID
		}
		content.URL = url
	}
	if nick, _ := fields["author_nickname"].(string); nick != "" {
		content.Body = nick
	} else if nick, _ := fields["voter_nickname"].(string); nick != "" {
		content.Body = nick
	}
	return content
}

// maybeEnqueuePushNotification queues a push notification for a recipient.
// It is called inside the same DB transaction as the triggering event (post,
// DM, etc.). The actual dispatch happens asynchronously via the outbox worker.
//
// dedupeKey must identify the triggering event (notification id, message id):
// the same key enqueued twice is one outbox row, so a retried transaction can
// never double-notify. A timestamp is NOT a dedupe key — it is unique on
// every call, which is how the previous shape silently disabled deduping.
//
// The payload is stored flat (see PushContent): processPushEvent reads
// title/body/url/badge_count from the top level of the row.
func maybeEnqueuePushNotification(txApp core.App, recipientID string, eventType string, dedupeKey string, content PushContent) error {
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

	raw, err := json.Marshal(map[string]any{
		"recipient_id": recipientID,
		"event_type":   eventType,
		"title":        content.Title,
		"body":         content.Body,
		"url":          content.URL,
		"badge_count":  content.BadgeCount,
	})
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
		"title": title,
		"body":  body,
		"url":   url,
		"tag":   "aerun-notification",
	}
	// badge_count is sent only when it means something: a 0 would clear the
	// badge on the device, and the dispatcher passes 0 when it could not
	// compute the unread count — not when the count is actually zero.
	if badgeCount > 0 {
		payload["badge_count"] = badgeCount
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
