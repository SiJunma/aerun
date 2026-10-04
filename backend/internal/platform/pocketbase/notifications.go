package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const notificationsCollectionName = "notifications"

// topicReadStatesCollectionName is the server-side read state the unread-topic
// count reads. Created by migration 1768300000; named here as well because the
// SQL in countUnreadTopics joins the table by name, and a silent "no such table"
// would degrade the badge to zero rather than fail loudly.
const topicReadStatesCollectionName = "topic_read_states"

// markTopicReadHandler records where the caller stopped reading a topic.
//
//	POST /api/aerun/topics/:id/read
//
// This is what makes the unread badge correct across devices, and it is the only
// writer of the read state the count reads. It replaces a localStorage map
// (`aerun_readmap_<uid>`) that only the browser that wrote it could see — so
// reading a topic on the desktop left the phone's badge untouched, and there was
// no way to tell a stale count from a correct one.
//
// TWO THINGS ARE DELIBERATELY NOT HERE.
//
// The timestamp is the caller's arrival time, not the topic's last post time.
// Writing `topics.last_post_created` instead would be self-fulfilling: the topic
// would always be exactly read-up-to and never unread again, and a reply landing
// while the topic was open in another tab would be marked read without anybody
// having seen it.
//
// A GET is not a read. The topic is fetched constantly — by the list, by the
// badge, by quote tracking — and marking on every fetch would clear the badge the
// moment the member looked at their own inbox.
//
// The write is an UPSERT, so revisiting a topic moves the position forward
// instead of failing on the unique (user, topic) index. It is not wrapped in the
// command layer's idempotency machinery: it has no side effect beyond the row it
// owns, and requiring a client-generated key for "I am here" would only add a
// failure mode in which a member opened a topic and the badge did not move.
func markTopicReadHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	topicID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	topic, err := e.App.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		return notFoundError("topic not found")
	}
	// Read state is a fact about a topic you can see. Writing one for a topic you
	// cannot read would be a blind write into another category's space, and the
	// row would outlive the access that made it meaningless.
	allowed, err := canViewCategory(e.App, acc, topic.GetString("category_id"))
	if err != nil {
		return internalError("failed to check category access", err)
	}
	if !allowed {
		return forbiddenError("you do not have permission to view this category")
	}

	now := types.NowDateTime()
	if err := upsertTopicReadState(e.App, e.Auth.Id, topicID, now); err != nil {
		return internalError("failed to save read state", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"topic_id":     topicID,
		"last_read_at": now.String(),
		"request_id":   requestIDFrom(e),
	})
}

// upsertTopicReadState moves (or creates) the read position for one topic.
//
// Extracted because markTopicReadHandler and markAllTopicsReadHandler must not be
// able to disagree about what a read position is — the same reasoning that made
// both notification paths share one helper.
func upsertTopicReadState(app core.App, userID, topicID string, at types.DateTime) error {
	existing, err := app.FindFirstRecordByFilter(
		topicReadStatesCollectionName,
		"user_id = {:user} && topic_id = {:topic}",
		dbx.Params{"user": userID, "topic": topicID},
	)
	if err == nil && existing != nil {
		existing.Set("last_read_at", at)
		return app.Save(existing)
	}

	col, err := app.FindCollectionByNameOrId(topicReadStatesCollectionName)
	if err != nil {
		return err
	}
	rec := core.NewRecord(col)
	rec.Set("user_id", userID)
	rec.Set("topic_id", topicID)
	rec.Set("last_read_at", at)
	if err := app.Save(rec); err != nil {
		// The concurrent writer's row already says the same thing. Two tabs
		// opening the same topic race here, and the loser must not see an error.
		if strings.Contains(err.Error(), "UNIQUE constraint failed") ||
			strings.Contains(err.Error(), "validation_not_unique") {
			return nil
		}
		return err
	}
	return nil
}

// markAllTopicsReadHandler moves the caller's read position across many topics at
// once, for the "mark all read" button on /new-replies.
//
//	POST /api/aerun/me/topics/read-all
//
// The ids are validated against the same category gate as a single read, and an
// id the caller may not read is REFUSED rather than skipped. Skipping it would let
// the response report success while quietly leaving another category's read state
// untouched — and the button would claim to have read everything when it had not
// even looked. The client's previous behaviour (a localStorage write) marked every
// id it happened to hold, which was the top 50 topics regardless of visibility.
func markAllTopicsReadHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	var body struct {
		TopicIDs []string `json:"topic_ids"`
	}
	if e.Request.Body != nil {
		if err := json.NewDecoder(e.Request.Body).Decode(&body); err != nil {
			return validationError("invalid request body")
		}
	}

	if len(body.TopicIDs) == 0 {
		return e.JSON(http.StatusOK, map[string]any{
			"marked":     0,
			"request_id": requestIDFrom(e),
		})
	}

	acc := AccessFrom(e)
	now := types.NowDateTime()

	marked := 0
	for _, topicID := range body.TopicIDs {
		topic, err := e.App.FindRecordById(topicsCollectionName, topicID)
		if err != nil || topic == nil {
			return notFoundError("topic not found")
		}
		allowed, err := canViewCategory(e.App, acc, topic.GetString("category_id"))
		if err != nil {
			return internalError("failed to check category access", err)
		}
		if !allowed {
			return forbiddenError("you do not have permission to view one of these categories")
		}
		if err := upsertTopicReadState(e.App, e.Auth.Id, topicID, now); err != nil {
			return internalError("failed to save read state", err)
		}
		marked++
	}

	return e.JSON(http.StatusOK, map[string]any{
		"marked":     marked,
		"request_id": requestIDFrom(e),
	})
}

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

// getUnreadCountsHandler returns aggregated unread counters (DMs, notifications
// and topics). Replaces the legacy RTDB unread badges.
//
// UNREAD TOPICS LIVE HERE, not on the topic list, and that is the point of this
// endpoint's shape. The main-page projection used to carry `topics?limit=50` —
// fifty whole topic records — so the navbar badge could render a number. Every
// member on every page paid for fifty rows to be told "3". And the number was
// wrong twice over: `limit=50` silently caps it (a member with 60 unread is told
// 50), and `AuthProvider` held `unreadTopicsCount` in a `useState` with NO
// setter, so the badge and the tab title rendered a permanent 0.
//
// A count belongs with the other counts. Computing it here costs one indexed
// aggregate over rows the caller can already see, and it cannot be capped by a
// page size: this counts every unread topic, not the first fifty.
//
// The predicate is the one the client applied (NewRepliesPage):
//
//	last_post_created > max(last_read_at, registration)
//
// with two differences only the server can settle. `last_read_at` comes from a
// per-user read-state table rather than a localStorage map, so the count follows
// the member to another browser; and the category filter is `canViewCategory`,
// so a topic in a category the caller may not read does not merely stay out of
// the list — it does not inflate the badge, which is how a count ends up larger
// than the list it summarises.
//
// Topics whose last post is the caller's own are excluded, matching the client,
// so replying does not make your own topic unread.
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

	// 3. Unread topics, restricted to categories this caller may read.
	unreadTopics, err := countUnreadTopics(e)
	if err != nil {
		// The cause travels with the message on purpose. A bare "failed to count"
		// is unactionable: the difference between a missing table (a migration that
		// did not run) and a bad query (a typo in the SQL) is invisible, and both
		// present to the client as the same 500.
		return internalError("failed to count unread topics: "+err.Error(), err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"unread_notifications":  notifCount.Count,
		"unread_conversations":  dmSummary.UnreadConversations,
		"total_unread_messages": dmSummary.TotalUnreadMessages,
		"unread_topics":         unreadTopics,
		"request_id":            requestIDFrom(e),
	})
}

// countUnreadTopics counts topics with a post newer than the caller's last read,
// in categories they may read.
//
// THE LEFT JOIN IS LOAD-BEARING. A caller who has never read anything has no
// read-state row, and an INNER JOIN would skip their topics entirely — reporting
// a brand-new member as having zero unread topics, the opposite of the truth.
// Their floor is their registration instead: nothing posted before they joined
// can be something they have not seen.
func countUnreadTopics(e *core.RequestEvent) (int, error) {
	acc := AccessFrom(e)

	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return 0, err
	}

	readable := make([]string, 0, len(cats))
	for _, c := range cats {
		allowed, err := canViewCategory(e.App, acc, c.Id)
		if err != nil {
			return 0, err
		}
		if allowed {
			readable = append(readable, c.Id)
		}
	}
	if len(readable) == 0 {
		return 0, nil
	}

	var registered struct {
		Created string `db:"created"`
	}
	_ = e.App.DB().NewQuery("SELECT created FROM " + usersCollectionName + " WHERE id = {:user}").
		Bind(dbx.Params{"user": e.Auth.Id}).One(&registered)

	// The category filter is a generated IN list rather than a bound slice
	// parameter. dbx only expands a slice into `IN (...)` inside a HashExp; a
	// []string bound into raw SQL reaches SQLite as one quoted token, which it
	// rejects with "unrecognized token" rather than matching nothing — so the
	// attempt costs a 500 on an endpoint every member hits.
	//
	// Placeholders are generated rather than the ids interpolated: a category id is
	// data, and this is the difference between a query no row can break and one a
	// row could.
	placeholders := make([]string, 0, len(readable))
	params := dbx.Params{
		"user":       e.Auth.Id,
		"registered": registered.Created,
	}
	for i, id := range readable {
		key := fmt.Sprintf("cat%d", i)
		placeholders = append(placeholders, "{:"+key+"}")
		params[key] = id
	}

	var counter struct {
		Count int `db:"count"`
	}
	err = e.App.DB().NewQuery(`
		SELECT COUNT(*) AS count
		FROM ` + topicsCollectionName + ` t
		LEFT JOIN ` + topicReadStatesCollectionName + ` r
			ON r.topic_id = t.id AND r.user_id = {:user}
		WHERE t.category_id IN (` + strings.Join(placeholders, ", ") + `)
			AND COALESCE(t.last_post_author_id, '') != {:user}
			AND t.last_post_created > COALESCE(
				r.last_read_at,
				CASE WHEN {:registered} = '' THEN t.last_post_created ELSE {:registered} END
			)
	`).
		Bind(params).
		One(&counter)
	if err != nil {
		return 0, err
	}
	return counter.Count, nil
}
