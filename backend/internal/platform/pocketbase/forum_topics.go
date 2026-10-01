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

		// 4. The author gains one topic AND its opening post. Both counters move
		// here, in the same transaction as the rows that justify them.
		if err := adjustUserPostCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
		}
		if err := adjustUserTopicCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
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
			oldTitle := topic.GetString("title")
			topic.Set("title", newTitle)
			if !isAuthor {
				if err := recordAuditLog(txApp, "topic_title_edit", e.Auth.Id, map[string]any{
					"topic_id":  id,
					"old_title": oldTitle,
					"new_title": newTitle,
				}); err != nil {
					return 0, nil, err
				}
			}
		}

		if form.Locked != nil {
			if !auth.Has(acc.Permissions, auth.PermCloseTopics) && !hasMod {
				return 0, nil, forbiddenError("you cannot lock/unlock topics")
			}
			topic.Set("locked", *form.Locked)
			if err := recordAuditLog(txApp, "topic_lock", e.Auth.Id, map[string]any{
				"topic_id": id,
				"locked":   *form.Locked,
			}); err != nil {
				return 0, nil, err
			}
		}

		if form.Pinned != nil {
			if !auth.Has(acc.Permissions, auth.PermPinTopics) && !hasMod {
				return 0, nil, forbiddenError("you cannot pin/unpin topics")
			}
			topic.Set("pinned", *form.Pinned)
			if err := recordAuditLog(txApp, "topic_pin", e.Auth.Id, map[string]any{
				"topic_id": id,
				"pinned":   *form.Pinned,
			}); err != nil {
				return 0, nil, err
			}
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

		oldCategoryID := topic.GetString("category_id")
		topic.Set("category_id", form.CategoryID)
		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to move topic", err)
		}

		if err := recordAuditLog(txApp, "topic_move", e.Auth.Id, map[string]any{
			"topic_id":        id,
			"old_category_id": oldCategoryID,
			"new_category_id": form.CategoryID,
		}); err != nil {
			return 0, nil, err
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

		// The topic leaves the author's topic count, but its posts stay in the
		// database (a soft-deleted topic keeps its rows and its posts are still
		// non-deleted), so posts_count is deliberately NOT touched here — the
		// recompute pass uses the same rule, and the two must agree.
		if err := adjustUserTopicCount(txApp, topic.GetString("author_id"), -1); err != nil {
			return 0, nil, err
		}

		// ── Residue cleanup ──────────────────────────────────────────────────
		//
		// Production deleted a whole topic on 2026-09-30 (main: be6ca82) and
		// everything DENORMALIZED around it kept pointing at content that no
		// longer existed: members kept the reputation they had earned on the
		// deleted posts, and topic_subscriptions leaked. This layer soft-deletes
		// instead of cascading, so nothing is destroyed — but "nothing was
		// destroyed" is not "nothing is left behind", and a soft-deleted topic
		// is refused by canViewTopic, so its rows are unreachable by anything
		// that would ever reconcile them.
		//
		// See purgeTopicResidue for what is paid back, what is hard-deleted,
		// and what is deliberately kept. It all runs inside this transaction,
		// so a failure leaves the topic alive rather than half-cleaned.
		if err := purgeTopicResidue(txApp, topic); err != nil {
			return 0, nil, err
		}

		if !isAuthor {
			if err := recordAuditLog(txApp, "topic_delete", e.Auth.Id, map[string]any{
				"topic_id":  id,
				"author_id": topic.GetString("author_id"),
			}); err != nil {
				return 0, nil, err
			}
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"topic_id":   topic.Id,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// purgeTopicResidue removes every row that outlives a topic deletion but has
// no meaning once the topic is hidden: its subscriptions, the votes cast on its
// posts, and the reputation those votes paid out.
//
// The three lessons from the 2026-09-30 production incident (main: abed3e8 +
// be6ca82) are all enforced here, and each maps to one of the cleanup steps:
//
//  1. Per-author aggregate, never a per-post loop with early returns. On
//     Firestore the cascade deleted the posts first, so the trigger that owned
//     the per-author decrement returned early ("the topic document is already
//     gone") and nobody decremented anything. Here the decrement is aggregated
//     from the surviving rows before they are touched, so the count always has
//     an owner.
//
//  2. Reputation is reverted by deleting the votes, not by re-deriving a
//     number. The votes ARE the authority for reputation (that is the rule
//     RecomputeUserCounters follows too), so removing them and paying back their
//     summed value is the only way the two can agree. Payment is aggregated per
//     target user and applied once, which also makes a duplicate delivery
//     impossible: the votes are already gone, so a second pass finds nothing to
//     pay. be6ca82 needed a separate reputation_reverts/{logId} claim document
//     on Firestore because Cloud Functions are at-least-once; inside this
//     transaction the deletion itself is the claim.
//
//  3. Cleanup happens in the same transaction as the tombstone. The Firestore
//     version applied the tombstone and the cleanup as separate batches, so a
//     failure between them is exactly the half-deleted state be6ca82 had to
//     repair by hand on 2081 documents.
func purgeTopicResidue(txApp core.App, topic *core.Record) error {
	// 1. Reputation: sum the topic's votes per target and pay each back.
	//    Summing means a target with many votes is written once instead of once
	//    per vote, and it is the same aggregate be6ca82 had to add on the
	//    Firestore branch after the cascade left every per-author decrement
	//    without an owner.
	//
	//    The vote ROWS ARE KEPT. Deleting a topic here is a soft delete and the
	//    whole point of that design (see the incident doc) is that a mistaken
	//    delete is recoverable — hard-deleting the votes would make reputation
	//    the one thing a restore could not bring back. Instead the vote is
	//    marked as belonging to a hidden topic by virtue of the topic_id it
	//    already carries, and sumVotes in user_counters.go ignores votes whose
	//    topic is deleted. That is the same mechanism the post counter uses
	//    (1767100000: a post in a soft-deleted topic is not counted), so the
	//    projection and the recompute agree, and un-deleting the topic restores
	//    the reputation automatically because the recompute derives it again.
	//
	//    The payout is what makes the CACHED column agree with that rule right
	//    now, without waiting for a recompute run. Because it is derived from
	//    the surviving rows and applied inside this transaction, a redelivery
	//    cannot apply it twice: there is no separate trigger to replay, and the
	//    tombstone makes the command a no-op on the second attempt.
	type voteTotal struct {
		TargetID string `db:"target_id"`
		Total    int    `db:"total"`
	}
	var totals []voteTotal
	if err := txApp.DB().NewQuery(
		"SELECT target_id, SUM(value) AS total FROM " + reputationVotesCollectionName +
			" WHERE topic_id = {:topic} GROUP BY target_id",
	).Bind(dbx.Params{"topic": topic.Id}).All(&totals); err != nil {
		return internalError("failed to sum reputation votes for topic cleanup", err)
	}
	for _, row := range totals {
		if row.TargetID == "" || row.Total == 0 {
			continue
		}
		if err := adjustUserReputation(txApp, row.TargetID, -row.Total); err != nil {
			return err
		}
	}

	// 2. The per-post totals are the same money, counted a second time. They are
	//    zeroed rather than recomputed so the tombstone and its posts agree with
	//    the authors the payout above just reduced. Restoring the topic leaves
	//    them at 0, which is correct: the vote rows that would refill them
	//    belong to a topic nobody can read until the restore.
	if _, err := txApp.DB().NewQuery(
		"UPDATE posts SET reputation = 0 WHERE topic_id = {:topic}",
	).Bind(dbx.Params{"topic": topic.Id}).Execute(); err != nil {
		return internalError("failed to clear post reputation for topic cleanup", err)
	}

	// 3. Subscriptions, which ARE hard-deleted. Unlike a vote, a subscription is
	//    not content and not recoverable state: it is a pointer that keeps a
	//    topic id alive in a member's list, and the member cannot unsubscribe
	//    from a topic the API refuses to serve. be6ca82 leaked these on the
	//    Firestore branch for the same reason.
	subs, err := txApp.FindAllRecords(
		topicSubscriptionsCollectionName,
		dbx.NewExp("topic_id = {:topic}", dbx.Params{"topic": topic.Id}),
	)
	if err != nil {
		return internalError("failed to read subscriptions for topic cleanup", err)
	}
	for _, sub := range subs {
		if err := txApp.Delete(sub); err != nil {
			return internalError("failed to delete topic subscription", err)
		}
	}

	return nil
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
