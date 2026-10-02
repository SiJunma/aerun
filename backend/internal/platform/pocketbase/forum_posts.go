package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/forum"
)

const maxPostContentBodyBytes = 128 * 1024

type createPostForm struct {
	Content string `json:"content"`
}

type editPostForm struct {
	Content string `json:"content"`
}

type movePostsForm struct {
	TargetTopicID string   `json:"target_topic_id"`
	PostIDs       []string `json:"post_ids"`
}

func postPayload(record *core.Record) map[string]any {
	payload := map[string]any{
		"id":        record.Id,
		"topic_id":  record.GetString("topic_id"),
		"author_id": record.GetString("author_id"),
		"sequence":  record.GetInt("sequence"),
		"created":   record.GetDateTime("created").String(),
		"updated":   record.GetDateTime("updated").String(),
	}

	// No `deleted` key: a deleted post is gone from the database, so the payload
	// has nothing to report. The client cannot be handed a flag for a state the
	// server no longer stores, and an always-false flag is worse than none — it
	// invites a branch that can never be true.
	payload["content"] = record.GetString("content")

	edited := record.GetDateTime("edited")
	if !edited.IsZero() {
		payload["edited"] = edited.String()
	}
	if editorID := record.GetString("editor_id"); editorID != "" {
		payload["editor_id"] = editorID
	}
	return payload
}

// createPostHandler creates a new post inside a topic and advances topic sequence/projections atomically.
func createPostHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	topicID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxPostContentBodyBytes)
	if err != nil {
		return err
	}

	var form createPostForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	content, err := forum.ValidatePostContent(form.Content)
	if err != nil {
		return validationError(err.Error())
	}

	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, topicID)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("topic not found")
		}

		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermModerateContent) {
			return 0, nil, conflictError("topic is locked")
		}

		postsCol, err := txApp.FindCollectionByNameOrId(postsCollectionName)
		if err != nil {
			return 0, nil, internalError("posts collection unavailable", err)
		}

		// Sequence assignment: query max sequence for this topic
		type maxSeqResult struct {
			MaxSeq int `db:"max_seq"`
		}
		var seqRes maxSeqResult
		err = txApp.DB().NewQuery("SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM posts WHERE topic_id = {:topic_id}").
			Bind(dbx.Params{"topic_id": topicID}).
			One(&seqRes)
		if err != nil {
			return 0, nil, internalError("failed to calculate next post sequence", err)
		}

		nextSeq := seqRes.MaxSeq + 1
		if nextSeq > forum.MaxPostsPerTopic {
			return 0, nil, conflictError("topic has reached the maximum post limit")
		}

		post := core.NewRecord(postsCol)
		post.Set("topic_id", topicID)
		post.Set("author_id", e.Auth.Id)
		post.Set("sequence", nextSeq)
		post.Set("content", content)
		post.Set("deleted", false)

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to save post", err)
		}

		// Update topic counters and projection
		topic.Set("posts_count", topic.GetInt("posts_count")+1)
		topic.Set("last_post_id", post.Id)
		topic.Set("last_post_created", post.GetDateTime("created"))
		topic.Set("last_post_author_id", post.GetString("author_id"))

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		// The author's own counter moves in the same transaction, for the same
		// reason: a member list that lags a reply by one is a visible lie.
		if err := adjustUserPostCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
		}

		resp := map[string]any{
			"post":       postPayload(post),
			"request_id": requestIDFrom(e),
		}
		return http.StatusCreated, resp, nil
	})

	return writeCommandResult(e, outcome, err)
}

// listPostsHandler lists posts in a topic with cursor pagination.
func listPostsHandler(e *core.RequestEvent) error {
	topicID := e.Request.PathValue("id")
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), forum.DefaultPageLimit), forum.DefaultPageLimit)
	afterSeq := parseIntParam(e.Request.URL.Query().Get("after_sequence"), 0)

	topic, err := e.App.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		return notFoundError("topic not found")
	}

	query := e.App.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topicID}).
		// Drafts are private to their author and surfaced through the
		// drafts routes, never in the public post feed.
		AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL"))

	if afterSeq > 0 {
		query = query.AndWhere(dbx.NewExp("sequence > {:after_seq}", dbx.Params{"after_seq": afterSeq}))
	}

	query = query.OrderBy("sequence ASC").Limit(int64(limit + 1))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to list posts", err)
	}

	var nextSeq int
	if len(records) > limit {
		nextSeq = records[limit-1].GetInt("sequence")
		records = records[:limit]
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = postPayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":               items,
		"topic_id":            topicID,
		"posts_count":         topic.GetInt("posts_count"),
		"next_after_sequence": nextSeq,
		"request_id":          requestIDFrom(e),
	})
}

// getPostBySequenceHandler returns a post by topic ID and sequence number.
func getPostBySequenceHandler(e *core.RequestEvent) error {
	topicID := e.Request.PathValue("id")
	seqStr := e.Request.PathValue("sequence")
	seq, err := strconv.Atoi(seqStr)
	if err != nil || seq <= 0 {
		return validationError("invalid sequence number")
	}

	record, err := e.App.FindFirstRecordByFilter(
		postsCollectionName,
		"topic_id = {:topic_id} && sequence = {:seq} && is_draft = false",
		dbx.Params{"topic_id": topicID, "seq": seq},
	)
	if err != nil || record == nil {
		return notFoundError("post not found")
	}

	return e.JSON(http.StatusOK, map[string]any{
		"post":       postPayload(record),
		"request_id": requestIDFrom(e),
	})
}

// editPostHandler updates a post's content.
func editPostHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	postID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxPostContentBodyBytes)
	if err != nil {
		return err
	}

	var form editPostForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	content, err := forum.ValidatePostContent(form.Content)
	if err != nil {
		return validationError(err.Error())
	}

	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil {
			return 0, nil, notFoundError("post not found")
		}

		isAuthor := e.Auth != nil && post.GetString("author_id") == e.Auth.Id
		hasMod := auth.Has(acc.Permissions, auth.PermModerateContent)

		if !isAuthor && !hasMod {
			return 0, nil, forbiddenError("you cannot edit this post")
		}

		topic, err := txApp.FindRecordById(topicsCollectionName, post.GetString("topic_id"))
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("parent topic not found")
		}

		if topic.GetBool("locked") && !hasMod {
			return 0, nil, conflictError("topic is locked")
		}

		post.Set("content", content)
		post.Set("edited", types.NowDateTime())
		if !isAuthor && hasMod {
			post.Set("editor_id", e.Auth.Id)
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to update post", err)
		}

		if !isAuthor && hasMod {
			if err := recordAuditLog(txApp, "post_edit", e.Auth.Id, map[string]any{
				"post_id":   postID,
				"topic_id":  topic.Id,
				"author_id": post.GetString("author_id"),
			}); err != nil {
				return 0, nil, err
			}
		}

		return http.StatusOK, map[string]any{
			"post":       postPayload(post),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// deletePostHandler HARD-deletes a post and recalculates the topic projections.
//
// Hard delete is the deliberate semantics: a deleted post is not listed, not
// numbered and not counted, exactly as in the Firestore era this branch
// migrates from and as in the reference engine (MyBB). There is no tombstone
// row. See 1767700000_drop_deleted_flag.go, which drops the `deleted` column
// this handler used to set.
//
// Because the row is GONE, "does a counter still point at it" cannot drift: a
// post either exists and counts, or it does not exist. The follow-up risk that
// makes a hard delete dangerous is orphaned denormalized copies — votes,
// subscriptions, projections — so every one of them is settled HERE, in the same
// transaction as the delete. Rules 1-3 of
// markdowns/POST_DELETE_WIPED_TOPIC_INCIDENT.md.
func deletePostHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	postID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil {
			return 0, nil, notFoundError("post not found")
		}

		isAuthor := e.Auth != nil && post.GetString("author_id") == e.Auth.Id
		hasMod := auth.Has(acc.Permissions, auth.PermModerateContent)

		if !isAuthor && !hasMod {
			return 0, nil, forbiddenError("you cannot delete this post")
		}

		topic, err := txApp.FindRecordById(topicsCollectionName, post.GetString("topic_id"))
		if err != nil || topic == nil {
			return 0, nil, notFoundError("parent topic not found")
		}

		// Deleting a post must never take the topic with it. The first post of a
		// topic *is* the topic, so removing it is a topic-level operation and
		// must go through DELETE /topics/{id}. Production lost a whole topic
		// this way: the client decided "is this the first post?" from the post's
		// index within the *current page*, so on page 2+ an ordinary reply was
		// treated as the first post and took the topic-delete branch, which
		// cascaded over every post. Refusing it here makes that class of bug
		// impossible regardless of what the client asks for.
		//
		// posts.sequence is Required and 1-based for published posts (topic
		// creation writes 1 for the opening post); 0 is reserved for drafts,
		// which are removed through the draft commands and never through here.
		if post.GetInt("sequence") <= 1 {
			return 0, nil, conflictError("cannot delete a topic's first post here - delete the topic instead")
		}

		// Everything below reads state that the delete invalidates, so it is
		// captured BEFORE the row goes. Rule 3 of the incident doc: aggregate
		// first, then mutate — a loop that reads after its parent is gone is how
		// the original decrement lost its owner.
		authorID := post.GetString("author_id")

		// Reputation earned on a post that is about to stop existing must be paid
		// back — be6ca82's exact fix, for the same reason: on Firestore the logs
		// outlived the topic and members kept scores for posts nobody could read.
		//
		// The sum comes from the vote rows because the votes are the authority
		// RecomputeUserCounters derives from. The rows are deleted below: with a
		// hard delete there is no reversible state left to keep them for, and an
		// orphaned vote is exactly the residue the incident was about. Removing
		// them also makes the payout exactly-once by construction — a second pass
		// finds no rows left to sum, so no claim document is needed.
		type voteTotal struct {
			Total int `db:"total"`
		}
		var voteSum voteTotal
		if err := txApp.DB().NewQuery(
			"SELECT COALESCE(SUM(value), 0) AS total FROM " + reputationVotesCollectionName +
				" WHERE post_id = {:post}",
		).Bind(dbx.Params{"post": post.Id}).One(&voteSum); err != nil {
			return 0, nil, internalError("failed to sum reputation votes for post deletion", err)
		}
		if voteSum.Total != 0 {
			if err := adjustUserReputation(txApp, authorID, -voteSum.Total); err != nil {
				return 0, nil, err
			}
		}

		// The post's AUTHOR loses a post, not the caller: a moderator deleting
		// someone else's post must not move their own counter. The row is about
		// to stop existing, so the count drops by exactly one.
		if err := adjustUserPostCount(txApp, authorID, -1); err != nil {
			return 0, nil, err
		}

		// The audit row goes in the same transaction and carries the TEXT. The
		// post is about to become unrecoverable, so this is the last place its
		// content can live — the owner asked for exactly that: the admin log is
		// the surviving record of what was said.
		//
		// EVERY delete is logged, not only staff ones. The previous guard
		// (`if !isAuthor`) meant an ordinary player deleting their own post left
		// no trace at all, which is precisely the traffic worth watching.
		if err := recordAuditLog(txApp, "post_delete", e.Auth.Id, map[string]any{
			"post_id":     post.Id,
			"topic_id":    topic.Id,
			"topic_title": topic.GetString("title"),
			"author_id":   authorID,
			"sequence":    post.GetInt("sequence"),
			"by_author":   isAuthor,
			"content":     post.GetString("content"),
		}); err != nil {
			return 0, nil, err
		}

		// Votes out, then the row. The order only matters in that the votes must
		// be gone before anything could read them and pay a second time.
		if _, err := txApp.DB().NewQuery(
			"DELETE FROM " + reputationVotesCollectionName + " WHERE post_id = {:post}",
		).Bind(dbx.Params{"post": post.Id}).Execute(); err != nil {
			return 0, nil, internalError("failed to delete votes for deleted post", err)
		}
		if err := txApp.Delete(post); err != nil {
			return 0, nil, internalError("failed to delete post", err)
		}

		// Recount AFTER the delete, so the projection reflects what is actually
		// there. There is no deleted flag left to filter on, which is exactly why
		// the counter and the feed can no longer disagree.
		type countResult struct {
			Cnt int `db:"cnt"`
		}
		var cRes countResult
		if err := txApp.DB().NewQuery(
			"SELECT COUNT(*) AS cnt FROM " + postsCollectionName +
				" WHERE topic_id = {:topic_id} AND (is_draft = false OR is_draft IS NULL)",
		).Bind(dbx.Params{"topic_id": topic.Id}).One(&cRes); err != nil {
			return 0, nil, internalError("failed to recount topic posts", err)
		}
		topic.Set("posts_count", cRes.Cnt)

		// If this was the last_post_id on topic, find the latest remaining post
		if topic.GetString("last_post_id") == post.Id {
			var latestPosts []*core.Record
			err = txApp.RecordQuery(postsCollectionName).
				AndWhere(dbx.HashExp{"topic_id": topic.Id}).
				AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL")).
				OrderBy("sequence DESC").
				Limit(1).
				All(&latestPosts)
			if err != nil {
				return 0, nil, internalError("failed to find the new last post", err)
			}
			if len(latestPosts) > 0 {
				latest := latestPosts[0]
				topic.Set("last_post_id", latest.Id)
				topic.Set("last_post_created", latest.GetDateTime("created"))
				topic.Set("last_post_author_id", latest.GetString("author_id"))
			} else {
				topic.Set("last_post_id", "")
				topic.Set("last_post_author_id", "")
			}
		}

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic metadata after post deletion", err)
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"post_id":    post.Id,
			"topic_id":   topic.Id,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// movePostsHandler moves posts between topics and recalculates both sequences and projections.
func movePostsHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	sourceTopicID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxPostContentBodyBytes)
	if err != nil {
		return err
	}

	var form movePostsForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	form.TargetTopicID = strings.TrimSpace(form.TargetTopicID)
	if form.TargetTopicID == "" || form.TargetTopicID == sourceTopicID {
		return validationError("valid target_topic_id distinct from source is required")
	}
	if len(form.PostIDs) == 0 {
		return validationError("at least one post_id is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		sourceTopic, err := txApp.FindRecordById(topicsCollectionName, sourceTopicID)
		if err != nil || sourceTopic == nil {
			return 0, nil, notFoundError("source topic not found")
		}

		targetTopic, err := txApp.FindRecordById(topicsCollectionName, form.TargetTopicID)
		if err != nil || targetTopic == nil {
			return 0, nil, notFoundError("target topic not found")
		}

		// Find target topic max sequence
		type maxSeqResult struct {
			MaxSeq int `db:"max_seq"`
		}
		var seqRes maxSeqResult
		err = txApp.DB().NewQuery("SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM posts WHERE topic_id = {:target}").
			Bind(dbx.Params{"target": targetTopic.Id}).
			One(&seqRes)
		if err != nil {
			return 0, nil, internalError("failed to get target max sequence", err)
		}

		currentSeq := seqRes.MaxSeq

		for _, pid := range form.PostIDs {
			post, err := txApp.FindRecordById(postsCollectionName, pid)
			if err != nil || post == nil || post.GetString("topic_id") != sourceTopicID {
				return 0, nil, validationError(fmt.Sprintf("post %s does not belong to source topic", pid))
			}
			currentSeq++
			post.Set("topic_id", targetTopic.Id)
			post.Set("sequence", currentSeq)
			if err := txApp.Save(post); err != nil {
				return 0, nil, internalError("failed to move post", err)
			}

			// The votes travel with the post. `reputation_votes.topic_id` is a
			// denormalised copy of the post's topic, and leaving it behind is
			// not cosmetic: purgeTopicResidue pays reputation back by summing
			// the votes of the topic being deleted, so a vote still pointing at
			// the SOURCE would make deleting the source pay out for a post that
			// now lives in the target — and would keep counting against the
			// target in `sumVotes`, which resolves visibility through
			// post.topic_id, not through the vote's own copy.
			postVotes, err := txApp.FindAllRecords(
				reputationVotesCollectionName,
				dbx.NewExp("post_id = {:post}", dbx.Params{"post": pid}),
			)
			if err != nil {
				return 0, nil, internalError("failed to read reputation votes for moved post", err)
			}
			for _, vote := range postVotes {
				vote.Set("topic_id", targetTopic.Id)
				if err := txApp.Save(vote); err != nil {
					return 0, nil, internalError("failed to move post's reputation votes", err)
				}
			}
		}

		// Recalculate projections for both source and target
		recalcTopicProjection(txApp, sourceTopic)
		recalcTopicProjection(txApp, targetTopic)

		if err := recordAuditLog(txApp, "posts_move", e.Auth.Id, map[string]any{
			"source_topic_id": sourceTopic.Id,
			"target_topic_id": targetTopic.Id,
			"post_ids":        form.PostIDs,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"moved_count": len(form.PostIDs),
			"source_id":   sourceTopic.Id,
			"target_id":   targetTopic.Id,
			"request_id":  requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

func recalcTopicProjection(txApp core.App, topic *core.Record) {
	type countResult struct {
		Cnt int `db:"cnt"`
	}
	var cRes countResult
	// No deleted filter: a deleted post has no row. Drafts are excluded because
	// they are authored-but-unpublished and never occupy a slot in the feed.
	_ = txApp.DB().NewQuery(
		"SELECT COUNT(*) AS cnt FROM " + postsCollectionName +
			" WHERE topic_id = {:topic_id} AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"topic_id": topic.Id}).One(&cRes)
	topic.Set("posts_count", cRes.Cnt)

	var latestPosts []*core.Record
	err := txApp.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topic.Id}).
		AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL")).
		OrderBy("sequence DESC").
		Limit(1).
		All(&latestPosts)
	if err == nil && len(latestPosts) > 0 {
		latest := latestPosts[0]
		topic.Set("last_post_id", latest.Id)
		topic.Set("last_post_created", latest.GetDateTime("created"))
		topic.Set("last_post_author_id", latest.GetString("author_id"))
	} else {
		topic.Set("last_post_id", "")
		topic.Set("last_post_author_id", "")
	}
	_ = txApp.Save(topic)
}
