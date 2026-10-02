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

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to create topic", err)
		}

		// 2. Create initial post with sequence = 1
		post := core.NewRecord(postsCol)
		post.Set("topic_id", topic.Id)
		post.Set("author_id", e.Auth.Id)
		post.Set("sequence", 1)
		post.Set("content", content)

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
	if err != nil || topic == nil {
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
		if err != nil || topic == nil {
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
		if err != nil || topic == nil {
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

// deleteTopicHandler HARD-deletes a topic together with every post under it.
//
// This is the operation that destroyed the "Нортбейский мыслефлуд #2" thread on
// 2026-09-30, when deletion cascaded over 21 posts with no backup. That history
// is the reason the delete path is the most heavily guarded code on this branch:
// DELETE /posts/{id} refuses the first post with a 409 so no client path can
// reach this one by accident, and the client judges "first post" by the
// ABSOLUTE post number (isTopicFirstPost), not by index within a page.
//
// Deletion is irreversible here, exactly as it was in the Firestore era and as
// it is in the reference engine (MyBB). The owner's decision: a deleted topic
// is not listed, not counted and not recoverable — the audit log is the only
// surviving record. See 1767700000_drop_deleted_flag.go.
//
// Because the rows are GONE afterwards, the residue question changes shape. Under
// a soft delete the danger was "a counter still points at a row nobody can
// read"; under a hard delete the danger is an ORPHAN: a vote or subscription
// pointing at an id that will never resolve again, which nothing can ever
// reconcile. So every denormalized copy is settled here, inside this
// transaction, and the posts go with the topic.
func deleteTopicHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := e.Request.PathValue("id")
	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		isAuthor := e.Auth != nil && topic.GetString("author_id") == e.Auth.Id
		hasMod := auth.Has(acc.Permissions, auth.PermModerateContent)
		if !isAuthor && !hasMod {
			return 0, nil, forbiddenError("you cannot delete this topic")
		}

		// Everything that must be READ is read here, before a single row is
		// removed. Rule 3 of the incident doc: aggregate before you mutate, and
		// never let a loop early-return out of a decrement because its parent has
		// already gone — that per-post loop is exactly how the original bug left
		// every author's counter untouched.
		if err := purgeTopicResidue(txApp, topic); err != nil {
			return 0, nil, err
		}

		// The topic leaves its author's topic count. Its POSTS go below, and each
		// author's post count moves with them.
		if err := adjustUserTopicCount(txApp, topic.GetString("author_id"), -1); err != nil {
			return 0, nil, err
		}

		// Every delete is logged, not only staff ones: an ordinary player
		// deleting their own topic used to leave no trace, which is precisely the
		// traffic worth being able to review afterwards.
		if err := recordAuditLog(txApp, "topic_delete", e.Auth.Id, map[string]any{
			"topic_id":    topic.Id,
			"topic_title": topic.GetString("title"),
			"category_id": topic.GetString("category_id"),
			"author_id":   topic.GetString("author_id"),
			"by_author":   isAuthor,
		}); err != nil {
			return 0, nil, err
		}

		if err := deleteTopicPosts(txApp, topic); err != nil {
			return 0, nil, err
		}
		if err := txApp.Delete(topic); err != nil {
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

// deleteTopicPosts removes every post under a topic being hard-deleted, and
// moves each author's post count by however many posts they lose there.
//
// The decrement is AGGREGATED PER AUTHOR first and applied once per author.
// A per-post loop that decremented and could bail out mid-way is the exact
// defect the 2026-09-30 incident turned into data loss, and it is also simply
// wrong here: one reply from an author must cost them one post, and a thread
// with twelve of their posts must cost twelve — computed before any row is
// touched, so nothing can read a half-deleted state.
//
// Drafts are deleted with the topic (their topic is gone, so they can never be
// published again) but were never counted, so they move no counter.
func deleteTopicPosts(txApp core.App, topic *core.Record) error {
	type authorCount struct {
		AuthorID string `db:"author_id"`
		Cnt      int    `db:"cnt"`
	}
	var perAuthor []authorCount
	if err := txApp.DB().NewQuery(
		"SELECT author_id, COUNT(*) AS cnt FROM " + postsCollectionName +
			" WHERE topic_id = {:topic} AND (is_draft = false OR is_draft IS NULL)" +
			" GROUP BY author_id",
	).Bind(dbx.Params{"topic": topic.Id}).All(&perAuthor); err != nil {
		return internalError("failed to count a deleted topic's posts", err)
	}

	for _, row := range perAuthor {
		if row.AuthorID == "" {
			continue
		}
		if err := adjustUserPostCount(txApp, row.AuthorID, -row.Cnt); err != nil {
			return err
		}
	}

	// The votes on those posts go with them: purgeTopicResidue has already paid
	// their value back, and a vote whose post row no longer exists is an orphan
	// that sumVotes cannot see and nothing can clean up later.
	if _, err := txApp.DB().NewQuery(
		"DELETE FROM " + reputationVotesCollectionName + " WHERE topic_id = {:topic}",
	).Bind(dbx.Params{"topic": topic.Id}).Execute(); err != nil {
		return internalError("failed to delete votes for a deleted topic", err)
	}

	posts, err := txApp.FindAllRecords(
		postsCollectionName,
		dbx.NewExp("topic_id = {:topic}", dbx.Params{"topic": topic.Id}),
	)
	if err != nil {
		return internalError("failed to read the posts of a deleted topic", err)
	}
	for _, post := range posts {
		if err := txApp.Delete(post); err != nil {
			return internalError("failed to delete a post of a deleted topic", err)
		}
	}
	return nil
}

// purgeTopicResidue settles everything DENORMALIZED around a topic before the
// topic's own rows are removed: the subscriptions, the votes cast on its posts,
// and the reputation those votes paid out.
//
// Under a soft delete this existed to stop a counter from outliving the content
// it described. Under the hard delete it settles a different hazard, an ORPHAN:
// a subscription or vote pointing at an id that will never resolve again. Both
// are the same discipline — rule 1 of markdowns/POST_DELETE_WIPED_TOPIC_INCIDENT.md
// is "a delete is not done when the row is flagged, it is done when nothing
// denormalized still points at the row" — and both demand the same transaction.
//
// The three lessons from the 2026-09-30 incident (main: abed3e8 + be6ca82) are
// each enforced here:
//
//  1. Per-author aggregate, never a per-post loop with early returns. On
//     Firestore the cascade deleted the posts first, so the trigger that owned
//     the per-author decrement returned early ("the topic document is already
//     gone") and nobody decremented anything. Here every figure is summed from
//     the surviving rows before they are touched, so each decrement always has
//     an owner.
//
//  2. Reputation is reverted by removing the votes, not by re-deriving a number.
//     The votes ARE the authority for reputation (the rule RecomputeUserCounters
//     follows too), so removing them and paying back their summed value is the
//     only way the two can agree. Payment is aggregated per target and applied
//     once, which also makes it exactly-once by construction: the votes are gone
//     by the end of this function, so a second pass finds nothing to pay.
//     be6ca82 needed a separate reputation_reverts/{logId} claim on Firestore
//     because Cloud Functions are at-least-once; inside this transaction the
//     deletion itself is the claim.
//
//  3. Cleanup happens in the SAME transaction as the delete. The Firestore
//     version applied them as separate batches, so a failure between them is
//     exactly the half-deleted state be6ca82 had to repair by hand across 2081
//     documents.
func purgeTopicResidue(txApp core.App, topic *core.Record) error {
	// 1. Reputation: sum the topic's votes per target and pay each back.
	//    Summing means a target with many votes is written once instead of once
	//    per vote, and it is the same aggregate be6ca82 had to add on the
	//    Firestore branch after the cascade left every per-author decrement
	//    without an owner.
	//
	//    The vote ROWS are removed by deleteTopicPosts, immediately after this
	//    function returns. Under the old soft delete they were kept so an
	//    un-delete could restore the score; there is no un-delete any more, and a
	//    vote whose post row is gone is an orphan that sumVotes can no longer
	//    attribute to anybody.
	//
	//    The payout is what makes the CACHED column agree with the votes right
	//    now, without waiting for a recompute run. Because it is derived from the
	//    surviving rows and applied inside this transaction, and because the rows
	//    are deleted in the same transaction, a redelivery cannot apply it twice:
	//    there is no separate trigger to replay, and the delete itself is the
	//    claim.
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

	// 2. Subscriptions. A subscription is not content and not recoverable state:
	//    it is a pointer that keeps a topic id alive in a member's list, and once
	//    the topic row is gone the member cannot unsubscribe from it. be6ca82
	//    leaked these on the Firestore branch for the same reason.
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
