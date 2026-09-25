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
		if err != nil || topic == nil || topic.GetBool("deleted") {
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

// listUserSubscriptionsHandler returns keyset-paginated subscriptions for the caller.
func listUserSubscriptionsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication is required to view subscriptions")
	}

	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), forum.DefaultPageLimit), forum.DefaultPageLimit)
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))

	query := e.App.RecordQuery(topicSubscriptionsCollectionName).
		AndWhere(dbx.HashExp{"user_id": e.Auth.Id})

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

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = map[string]any{
			"id":       r.Id,
			"topic_id": r.GetString("topic_id"),
			"created":  r.GetDateTime("created").String(),
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}
