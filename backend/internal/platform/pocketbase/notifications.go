package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const notificationsCollectionName = "notifications"

// createNotification inserts an in-app notification within a transaction.
func createNotification(txApp core.App, recipientID, senderID, notifType, title string, payload any) (*core.Record, error) {
	col, err := txApp.FindCollectionByNameOrId(notificationsCollectionName)
	if err != nil {
		return nil, internalError("notifications collection unavailable", err)
	}

	record := core.NewRecord(col)
	record.Set("recipient_id", recipientID)
	record.Set("sender_id", senderID)
	record.Set("type", notifType)
	record.Set("title", title)
	record.Set("read", false)
	record.Set("archived", false)

	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return nil, internalError("failed to serialize notification payload", err)
		}
		record.Set("payload", types.JSONRaw(raw))
	}

	if err := txApp.Save(record); err != nil {
		return nil, internalError("failed to save notification", err)
	}

	return record, nil
}

func notificationPayload(rec *core.Record) map[string]any {
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
		"id":           rec.Id,
		"recipient_id": rec.GetString("recipient_id"),
		"sender_id":    rec.GetString("sender_id"),
		"type":         rec.GetString("type"),
		"title":        rec.GetString("title"),
		"payload":      payload,
		"read":         rec.GetBool("read"),
		"archived":     rec.GetBool("archived"),
		"created":      rec.GetDateTime("created").String(),
		"updated":      rec.GetDateTime("updated").String(),
	}
}

// listUserNotificationsHandler returns keyset-paginated notifications for the caller.
func listUserNotificationsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	limit := messaging.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), messaging.DefaultPageLimit), messaging.DefaultPageLimit)
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))
	unreadOnly := e.Request.URL.Query().Get("unread") == "true"
	includeArchived := e.Request.URL.Query().Get("archived") == "true"

	query := e.App.RecordQuery(notificationsCollectionName).
		AndWhere(dbx.HashExp{"recipient_id": e.Auth.Id})

	if unreadOnly {
		query = query.AndWhere(dbx.HashExp{"read": false})
	}
	if !includeArchived {
		query = query.AndWhere(dbx.HashExp{"archived": false})
	}

	// Keyset pagination: created DESC, id DESC
	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			created := parts[0]
			id := parts[1]
			query = query.AndWhere(dbx.NewExp(
				"(created < {:created}) OR (created = {:created} AND id < {:id})",
				dbx.Params{"created": created, "id": id},
			))
		}
	}

	query = query.OrderBy("created DESC", "id DESC").Limit(int64(limit + 1))

	records := []*core.Record{}
	if err := query.All(&records); err != nil {
		return internalError("failed to query notifications", err)
	}

	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = notificationPayload(r)
	}

	var nextCursor string
	if hasMore && len(records) > 0 {
		last := records[len(records)-1]
		nextCursor = last.GetDateTime("created").String() + "|" + last.Id
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}

// markNotificationReadHandler marks a specific notification as read.
func markNotificationReadHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	id := e.Request.PathValue("id")
	rec, err := e.App.FindRecordById(notificationsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("notification not found")
	}

	if rec.GetString("recipient_id") != e.Auth.Id {
		return forbiddenError("you do not own this notification")
	}

	rec.Set("read", true)
	if err := e.App.Save(rec); err != nil {
		return internalError("failed to mark notification as read", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"notification": notificationPayload(rec),
		"request_id":   requestIDFrom(e),
	})
}

// markAllNotificationsReadHandler marks all notifications for caller as read.
func markAllNotificationsReadHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	_, err := e.App.DB().Update(
		notificationsCollectionName,
		dbx.Params{"read": true},
		dbx.HashExp{"recipient_id": e.Auth.Id, "read": false},
	).Execute()
	if err != nil {
		return internalError("failed to mark all notifications as read", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"marked_all_read": true,
		"request_id":      requestIDFrom(e),
	})
}

// archiveNotificationHandler archives a notification.
func archiveNotificationHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	id := e.Request.PathValue("id")
	rec, err := e.App.FindRecordById(notificationsCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("notification not found")
	}

	if rec.GetString("recipient_id") != e.Auth.Id {
		return forbiddenError("you do not own this notification")
	}

	rec.Set("archived", true)
	if err := e.App.Save(rec); err != nil {
		return internalError("failed to archive notification", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"notification": notificationPayload(rec),
		"request_id":   requestIDFrom(e),
	})
}

// archiveAllNotificationsHandler archives every notification the caller owns.
//
// This exists because the client used to implement "clear all" by calling the
// read-all route: the rows were marked read and NOTHING was removed, while the
// toast announced they had been cleared. Marking read and removing are
// different acts, and a button labelled "delete" that only marks read is a lie
// about the state of the member's inbox.
func archiveAllNotificationsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	_, err := e.App.DB().Update(
		notificationsCollectionName,
		dbx.Params{"archived": true},
		dbx.HashExp{"recipient_id": e.Auth.Id, "archived": false},
	).Execute()
	if err != nil {
		return internalError("failed to archive all notifications", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"archived_all": true,
		"request_id":   requestIDFrom(e),
	})
}

// getUnreadCountsHandler returns aggregated unread counters (DMs and notifications).
// Replaces the legacy RTDB unread badges.
func getUnreadCountsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	// 1. Unread notifications
	var notifCount struct {
		Count int `db:"count"`
	}
	err := e.App.DB().Select("COUNT(*) as count").
		From(notificationsCollectionName).
		Where(dbx.HashExp{"recipient_id": e.Auth.Id, "read": false, "archived": false}).
		One(&notifCount)
	if err != nil {
		return internalError("failed to count unread notifications", err)
	}

	// 2. Unread DMs: sum of max(0, conv.messages_count - member.last_read_sequence)
	var dmSummary struct {
		UnreadConversations int `db:"unread_conversations"`
		TotalUnreadMessages int `db:"total_unread_messages"`
	}
	query := `
		SELECT 
			COUNT(CASE WHEN c.messages_count > m.last_read_sequence THEN 1 END) AS unread_conversations,
			COALESCE(SUM(CASE WHEN c.messages_count > m.last_read_sequence THEN (c.messages_count - m.last_read_sequence) ELSE 0 END), 0) AS total_unread_messages
		FROM dm_members m
		JOIN dm_conversations c ON c.id = m.conversation_id
		WHERE m.user_id = {:user}
	`
	_ = e.App.DB().NewQuery(query).Bind(dbx.Params{"user": e.Auth.Id}).One(&dmSummary)

	return e.JSON(http.StatusOK, map[string]any{
		"unread_notifications":  notifCount.Count,
		"unread_conversations":  dmSummary.UnreadConversations,
		"total_unread_messages": dmSummary.TotalUnreadMessages,
		"request_id":            requestIDFrom(e),
	})
}
