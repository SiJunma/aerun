package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/forum"
)

const (
	categoriesCollectionName = "categories"
	topicsCollectionName     = "topics"
	postsCollectionName      = "posts"
	maxTopicBodyBytes        = 128 * 1024
)

type createTopicForm struct {
	CategoryID string `json:"category_id"`
	Title      string `json:"title"`
	Content    string `json:"content"`
}

type updateTopicForm struct {
	Title  *string `json:"title"`
	Locked *bool   `json:"locked"`
	Pinned *bool   `json:"pinned"`
}

type moveTopicForm struct {
	CategoryID string `json:"category_id"`
}

func topicPayload(record *core.Record) map[string]any {
	return map[string]any{
		"id":                  record.Id,
		"category_id":         record.GetString("category_id"),
		"author_id":           record.GetString("author_id"),
		"title":               record.GetString("title"),
		"posts_count":         record.GetInt("posts_count"),
		"locked":              record.GetBool("locked"),
		"pinned":              record.GetBool("pinned"),
		"deleted":             record.GetBool("deleted"),
		"last_post_id":        record.GetString("last_post_id"),
		"last_post_created":   record.GetDateTime("last_post_created").String(),
		"last_post_author_id": record.GetString("last_post_author_id"),
		"created":             record.GetDateTime("created").String(),
		"updated":             record.GetDateTime("updated").String(),
	}
}

// createTopicHandler creates a new topic along with its initial post in one transaction.
func createTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	raw, err := readBodyLimited(e, maxTopicBodyBytes)
	if err != nil {
		return err
	}

	var form createTopicForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	form.CategoryID = strings.TrimSpace(form.CategoryID)
	if form.CategoryID == "" {
		return validationError("category_id is required")
	}

	title, err := forum.ValidateTopicTitle(form.Title)
	if err != nil {
		return validationError(err.Error())
	}

	content, err := forum.ValidatePostContent(form.Content)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		// Verify category exists
		category, err := txApp.FindRecordById(categoriesCollectionName, form.CategoryID)
		if err != nil || category == nil {
			return 0, nil, notFoundError("category not found")
		}

		topicsCol, err := txApp.FindCollectionByNameOrId(topicsCollectionName)
		if err != nil {
			return 0, nil, internalError("topics collection unavailable", err)
		}
		postsCol, err := txApp.FindCollectionByNameOrId(postsCollectionName)
		if err != nil {
			return 0, nil, internalError("posts collection unavailable", err)
		}

		// 1. Create topic record
		topic := core.NewRecord(topicsCol)
		topic.Set("category_id", form.CategoryID)
		topic.Set("author_id", e.Auth.Id)
		topic.Set("title", title)
		topic.Set("posts_count", 1)
		topic.Set("locked", false)
		topic.Set("pinned", false)
		topic.Set("deleted", false)

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to create topic", err)
		}

		// 2. Create initial post with sequence = 1
		post := core.NewRecord(postsCol)
		post.Set("topic_id", topic.Id)
		post.Set("author_id", e.Auth.Id)
		post.Set("sequence", 1)
		post.Set("content", content)
		post.Set("deleted", false)

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to create initial post", err)
		}

		// 3. Update topic's last_post projection
		topic.Set("last_post_id", post.Id)
		topic.Set("last_post_created", post.GetDateTime("created"))
		topic.Set("last_post_author_id", post.GetString("author_id"))

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		resp := map[string]any{
			"topic":      topicPayload(topic),
			"first_post": postPayload(post),
			"request_id": requestIDFrom(e),
		}
		return http.StatusCreated, resp, nil
	})

	return writeCommandResult(e, outcome, err)
}

// listTopicsHandler lists non-deleted topics with keyset pagination.
func listTopicsHandler(e *core.RequestEvent) error {
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), forum.DefaultPageLimit), forum.DefaultPageLimit)
	categoryID := strings.TrimSpace(e.Request.URL.Query().Get("category_id"))
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))

	query := e.App.RecordQuery(topicsCollectionName).
		AndWhere(dbx.HashExp{"deleted": false})

	if categoryID != "" {
		query = query.AndWhere(dbx.HashExp{"category_id": categoryID})
	}

	// Keyset pagination cursor: pinned DESC, last_post_created DESC, id DESC
	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 3 {
			pinned := parts[0] == "1"
			lastPostCreated := parts[1]
			lastID := parts[2]

			// Keyset predicate for (pinned DESC, last_post_created DESC, id DESC)
			query = query.AndWhere(dbx.NewExp(
				"(pinned < {:pinned}) OR (pinned = {:pinned} AND last_post_created < {:created}) OR (pinned = {:pinned} AND last_post_created = {:created} AND id < {:id})",
				dbx.Params{
					"pinned":  pinned,
					"created": lastPostCreated,
					"id":      lastID,
				},
			))
		}
	}

	query = query.OrderBy("pinned DESC", "last_post_created DESC", "id DESC").
		Limit(int64(limit + 1))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to list topics", err)
	}

	var nextCursor string
	if len(records) > limit {
		lastRec := records[limit-1]
		records = records[:limit]
		pinnedFlag := "0"
		if lastRec.GetBool("pinned") {
			pinnedFlag = "1"
		}
		nextCursor = fmt.Sprintf("%s|%s|%s", pinnedFlag, lastRec.GetDateTime("last_post_created").String(), lastRec.Id)
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = topicPayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}

// getTopicHandler returns a single topic by ID.
func getTopicHandler(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	topic, err := e.App.FindRecordById(topicsCollectionName, id)
	if err != nil || topic == nil || topic.GetBool("deleted") {
		return notFoundError("topic not found")
	}

	return e.JSON(http.StatusOK, map[string]any{
		"topic":      topicPayload(topic),
		"request_id": requestIDFrom(e),
	})
}

// updateTopicHandler updates topic title, locked, or pinned state.
func updateTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxTopicBodyBytes)
	if err != nil {
		return err
	}

	var form updateTopicForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("topic not found")
		}

		isAuthor := e.Auth != nil && topic.GetString("author_id") == e.Auth.Id
		hasMod := auth.Has(acc.Permissions, auth.PermModerateContent)

		if form.Title != nil {
			if !isAuthor && !hasMod {
				return 0, nil, forbiddenError("you cannot change this topic's title")
			}
			newTitle, err := forum.ValidateTopicTitle(*form.Title)
			if err != nil {
				return 0, nil, validationError(err.Error())
			}
			topic.Set("title", newTitle)
		}

		if form.Locked != nil {
			if !auth.Has(acc.Permissions, auth.PermCloseTopics) && !hasMod {
				return 0, nil, forbiddenError("you cannot lock/unlock topics")
			}
			topic.Set("locked", *form.Locked)
		}

		if form.Pinned != nil {
			if !auth.Has(acc.Permissions, auth.PermPinTopics) && !hasMod {
				return 0, nil, forbiddenError("you cannot pin/unpin topics")
			}
			topic.Set("pinned", *form.Pinned)
		}

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic", err)
		}

		return http.StatusOK, map[string]any{
			"topic":      topicPayload(topic),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// moveTopicHandler moves a topic to a different category.
func moveTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxTopicBodyBytes)
	if err != nil {
		return err
	}

	var form moveTopicForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	form.CategoryID = strings.TrimSpace(form.CategoryID)
	if form.CategoryID == "" {
		return validationError("category_id is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("topic not found")
		}

		category, err := txApp.FindRecordById(categoriesCollectionName, form.CategoryID)
		if err != nil || category == nil {
			return 0, nil, notFoundError("target category not found")
		}

		topic.Set("category_id", form.CategoryID)
		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to move topic", err)
		}

		return http.StatusOK, map[string]any{
			"topic":      topicPayload(topic),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// deleteTopicHandler soft-deletes a topic.
func deleteTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("topic not found")
		}

		isAuthor := e.Auth != nil && topic.GetString("author_id") == e.Auth.Id
		hasMod := auth.Has(acc.Permissions, auth.PermModerateContent)
		if !isAuthor && !hasMod {
			return 0, nil, forbiddenError("you cannot delete this topic")
		}

		topic.Set("deleted", true)
		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to delete topic", err)
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"topic_id":   topic.Id,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

func parseIntParam(val string, defaultVal int) int {
	if val == "" {
		return defaultVal
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		return defaultVal
	}
	return n
}
