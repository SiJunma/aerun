package pocketbase

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

const topicSubscriptionsCollectionName = "topic_subscriptions"

// subscribeTopicHandler subscribes the authenticated user to a topic.
// It is strictly idempotent: re-subscribing is a no-op and cannot create duplicate rows.
func subscribeTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	if e.Auth == nil {
		return forbiddenError("authentication is required to subscribe to topics")
	}

	topicID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, topicID)
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		allowed, err := canViewCategory(txApp, acc, topic.GetString("category_id"))
		if err != nil || !allowed {
			return 0, nil, forbiddenError("you do not have permission to view this category")
		}

		// Check if subscription already exists
		existing, err := txApp.FindFirstRecordByFilter(
			topicSubscriptionsCollectionName,
			"topic_id = {:topic} && user_id = {:user}",
			dbx.Params{"topic": topicID, "user": e.Auth.Id},
		)
		if err == nil && existing != nil {
			return http.StatusOK, map[string]any{
				"subscribed": true,
				"topic_id":   topicID,
				"request_id": requestIDFrom(e),
			}, nil
		}

		col, err := txApp.FindCollectionByNameOrId(topicSubscriptionsCollectionName)
		if err != nil {
			return 0, nil, internalError("topic_subscriptions collection unavailable", err)
		}

		rec := core.NewRecord(col)
		rec.Set("topic_id", topicID)
		rec.Set("user_id", e.Auth.Id)

		if err := txApp.Save(rec); err != nil {
			errStr := err.Error()
			if strings.Contains(errStr, "UNIQUE constraint failed") ||
				strings.Contains(errStr, "validation_not_unique") ||
				strings.Contains(errStr, "must be unique") {
				return http.StatusOK, map[string]any{
					"subscribed": true,
					"topic_id":   topicID,
					"request_id": requestIDFrom(e),
				}, nil
			}
			return 0, nil, internalError("failed to create subscription", err)
		}

		return http.StatusOK, map[string]any{
			"subscribed": true,
			"topic_id":   topicID,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// unsubscribeTopicHandler unsubscribes the authenticated user from a topic.
// It is strictly idempotent: unsubscribing when not subscribed is a clean no-op.
func unsubscribeTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	if e.Auth == nil {
		return forbiddenError("authentication is required to unsubscribe from topics")
	}

	topicID := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		existing, err := txApp.FindFirstRecordByFilter(
			topicSubscriptionsCollectionName,
			"topic_id = {:topic} && user_id = {:user}",
			dbx.Params{"topic": topicID, "user": e.Auth.Id},
		)
		if err == nil && existing != nil {
			if err := txApp.Delete(existing); err != nil {
				return 0, nil, internalError("failed to remove subscription", err)
			}
		}

		return http.StatusOK, map[string]any{
			"subscribed": false,
			"topic_id":   topicID,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// getTopicSubscriptionStatusHandler checks if the caller is subscribed to a topic.
func getTopicSubscriptionStatusHandler(e *core.RequestEvent) error {
	topicID := e.Request.PathValue("id")
	if e.Auth == nil {
		return e.JSON(http.StatusOK, map[string]any{
			"subscribed": false,
			"topic_id":   topicID,
			"request_id": requestIDFrom(e),
		})
	}

	existing, err := e.App.FindFirstRecordByFilter(
		topicSubscriptionsCollectionName,
		"topic_id = {:topic} && user_id = {:user}",
		dbx.Params{"topic": topicID, "user": e.Auth.Id},
	)
	isSubscribed := err == nil && existing != nil

	return e.JSON(http.StatusOK, map[string]any{
		"subscribed": isSubscribed,
		"topic_id":   topicID,
		"request_id": requestIDFrom(e),
	})
}

// listUserSubscriptionsHandler returns keyset-paginated subscriptions for the
// caller.
//
// It also EMBEDS each subscribed topic, and this is the point of the handler as
// it stands: the browser used to receive bare `topic_id`s and then issue one
// `GET /api/aerun/topics/:id` PER SUBSCRIPTION to render the list. A member with
// 30 subscriptions spent 31 requests to draw one page, which is why opening
// /subscriptions was the single heaviest read in the app.
//
// The topics are fetched in ONE query and filtered by the caller's own access,
// which canViewCategory decides per topic's category. A subscription the caller
// may no longer see is returned WITHOUT a topic rather than with it: the row is
// still theirs (a stale subscription outliving a permission change is not an
// error), but the topic it points at is not theirs to read.
func listUserSubscriptionsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication is required to view subscriptions")
	}

	// Page size defaults to the SAME "topics per page" setting the category and
	// feed lists use, so /subscriptions paginates at the same density as every
	// other topic list. This is the page SIZE, never a cap on how many
	// subscriptions are reachable: the pager still spans the full `total` below
	// (every subscription the member holds), so nothing is cut off — the setting
	// only decides how many share a page. A caller-supplied `limit` still wins;
	// ClampLimit only guards the MaxPageLimit ceiling.
	settings := loadForumSettings(e.App)
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), settings.TopicsPerPage), settings.TopicsPerPage)
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)

	query := e.App.RecordQuery(topicSubscriptionsCollectionName).
		AndWhere(dbx.HashExp{"user_id": e.Auth.Id})

	// Counted BEFORE the cursor narrows the window, and only when the caller
	// asked for a numbered page.
	//
	// Counting after would report the rows left BELOW the cursor, which is not
	// what a numbered pager divides by. Counting always would tax every cursor
	// consumer — and any future infinite-scroll caller — with a full COUNT for a
	// number it never reads.
	var total int
	if cursor == "" {
		count, err := e.App.CountRecords(topicSubscriptionsCollectionName,
			dbx.HashExp{"user_id": e.Auth.Id})
		if err != nil {
			return internalError("failed to count subscriptions", err)
		}
		total = int(count)
	}

	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			created := parts[0]
			id := parts[1]
			query = query.AndWhere(dbx.NewExp(
				"(created < {:created}) OR (created = {:created} AND id < {:id})",
				dbx.Params{
					"created": created,
					"id":      id,
				},
			))
		}
	} else {
		// Offset only on the numbered path: layering an offset on top of a
		// cursor skips rows the cursor did not name.
		if page > 1 {
			query = query.Offset(int64((page - 1) * limit))
		}
	}

	query = query.OrderBy("created DESC", "id DESC").
		Limit(int64(limit + 1))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to query subscriptions", err)
	}

	var nextCursor string
	if len(records) > limit {
		lastRec := records[limit-1]
		records = records[:limit]
		nextCursor = fmt.Sprintf("%s|%s", lastRec.GetDateTime("created").String(), lastRec.Id)
	}

	acc := AccessFrom(e)
	topics := loadVisibleTopics(e.App, acc, subscriptionTopicIDs(records))

	items := make([]map[string]any, len(records))
	for i, r := range records {
		topicID := r.GetString("topic_id")
		item := map[string]any{
			"id":       r.Id,
			"topic_id": topicID,
			"created":  r.GetDateTime("created").String(),
		}
		// Absent, not null, when the topic is gone or out of reach — the client
		// drops the row either way and must not render a stub.
		if topic, ok := topics[topicID]; ok {
			item["topic"] = topic
		}
		items[i] = item
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"total":       total,
		"page":        page,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}

// subscriptionTopicIDs extracts the distinct topic ids from subscription rows.
func subscriptionTopicIDs(records []*core.Record) []string {
	ids := make([]string, 0, len(records))
	seen := make(map[string]bool, len(records))
	for _, r := range records {
		id := r.GetString("topic_id")
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

// loadVisibleTopics reads the requested topics in ONE query and keeps only the
// ones this caller may see, returning their normal payloads.
//
// The access check is per topic's CATEGORY, and it is applied AFTER the batch
// read on purpose: one query plus N cheap in-memory checks replaces N separate
// `GET /topics/:id` round trips. A category that cannot be viewed simply
// contributes no topics here.
//
// A missing topic (deleted) and an unreadable one (permission revoked) are both
// absent from the map. They are the same thing to the caller: there is nothing
// there to render.
func loadVisibleTopics(app core.App, acc AccessContext, topicIDs []string) map[string]map[string]any {
	out := make(map[string]map[string]any, len(topicIDs))
	if len(topicIDs) == 0 {
		return out
	}

	// dbx.In takes []any: a []string is a compile error rather than a silent
	// empty IN (), which would make every lookup "find nothing".
	inArgs := make([]any, len(topicIDs))
	for i, id := range topicIDs {
		inArgs[i] = id
	}

	var records []*core.Record
	if err := app.RecordQuery(topicsCollectionName).
		AndWhere(dbx.In("id", inArgs...)).
		All(&records); err != nil {
		// A failed batch degrades the page to id-only, exactly as it behaved
		// before this existed — never to an error.
		return out
	}

	payloads := make([]map[string]any, 0, len(records))
	visible := make([]*core.Record, 0, len(records))
	for _, rec := range records {
		allowed, err := canViewCategory(app, acc, rec.GetString("category_id"))
		if err != nil || !allowed {
			continue
		}
		payloads = append(payloads, topicPayload(rec))
		visible = append(visible, rec)
	}
	// One decoration pass for the whole page rather than one per topic.
	decorateTopicAuthors(app, payloads)

	for i, payload := range payloads {
		out[visible[i].Id] = payload
	}
	return out
}
