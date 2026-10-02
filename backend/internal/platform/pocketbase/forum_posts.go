package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
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

		// Replying into a locked topic is bypassed by `close_topics`, the same
		// key that grants the right to close a topic in the first place: one
		// capability, not two. The post limit is NOT bypassed by it — that is a
		// separate global ceiling checked below.
		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermCloseTopics) {
			return 0, nil, conflictError("topic is locked")
		}

		postsCol, err := txApp.FindCollectionByNameOrId(postsCollectionName)
		if err != nil {
			return 0, nil, internalError("posts collection unavailable", err)
		}

		// The post limit is read from the server-side settings row and clamped to
		// the build's ceiling (auth.HardMaxPostsPerTopic), so the number enforced
		// here is the same one the reader is shown. `close_topics` bypasses a
		// LOCKED topic but NOT this limit: the owner was explicit that the
		// post cap holds even for accounts allowed to write into closed topics.
		limit := effectiveMaxPostsPerTopic(txApp)
		existing, err := countPublishedPosts(txApp, topicID)
		if err != nil {
			return 0, nil, internalError("failed to count topic posts", err)
		}
		if existing >= limit {
			return 0, nil, conflictError("topic has reached the maximum post limit")
		}

		post := core.NewRecord(postsCol)
		post.Set("topic_id", topicID)
		post.Set("author_id", e.Auth.Id)
		post.Set("content", content)

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

// listPostsHandler lists posts in a topic, oldest first.
//
// ORDERING is `created ASC, id ASC` — the legacy contract, verified against the
// Firestore export. `posts.sequence` was an invented per-topic counter and is
// being removed; `created` is the real arrival order, and the id is the
// tie-breaker that makes the order total and therefore the pagination window
// deterministic. Two posts written in the same millisecond must not be able to
// swap places between page loads, which is exactly the "posts appear on two
// pages" drift the incident doc lists as uninvestigated.
//
// PAGE PAGINATION, not cursor. The counter (posts_count) IS the window the
// client paginates against, and a hard delete makes the two agree by
// construction: a post either has a row and is counted, or it does not exist.
func listPostsHandler(e *core.RequestEvent) error {
	topicID := e.Request.PathValue("id")
	settings := loadForumSettings(e.App)
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), settings.PostsPerPage), settings.PostsPerPage)
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}

	topic, err := e.App.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		return notFoundError("topic not found")
	}

	query := e.App.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topicID}).
		// Drafts are private to their author and surfaced through the
		// drafts routes, never in the public post feed.
		AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL")).
		OrderBy("created ASC", "id ASC").
		Limit(int64(limit)).
		Offset(int64((page - 1) * limit))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to list posts", err)
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = postPayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"topic_id":    topicID,
		"posts_count": topic.GetInt("posts_count"),
		"page":        page,
		"per_page":    limit,
		"request_id":  requestIDFrom(e),
	})
}

// getPostHandler returns a single post by its record id.
//
// This is the deep-link route. Posts are addressed by ID, never by a per-topic
// ordinal: `sequence` was an invented column, and a link built from it breaks
// the instant any earlier post is deleted, because every later ordinal shifts.
// The id is stable for the life of the row — and a deleted post's id simply
// stops resolving, which is the honest answer.
//
// A draft is NOT reachable here even by id: it is not in the public feed, and
// this route is public. The author reads their own draft through the drafts
// routes, which are authenticated and owner-scoped.
func getPostHandler(e *core.RequestEvent) error {
	id := e.Request.PathValue("id")
	record, err := e.App.FindRecordById(postsCollectionName, id)
	if err != nil || record == nil || record.GetBool("is_draft") {
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
		// Split permission, not an umbrella: editing and deleting a stranger's
		// post are separately assignable, so a role can be given one without
		// the other. The authorship check above is mandatory either way —
		// `edit_others_posts` widens WHO may act, it never substitutes for the
		// author comparison. `delete_others_posts` is deliberately NOT accepted
		// here: the right to remove a post is not the right to rewrite it.
		canEdit := isAuthor || auth.Has(acc.Permissions, auth.PermEditOthersPosts)
		// A moderator editing a stranger's post is staff activity and is
		// audited; the author editing their own post is not.
		isModerated := !isAuthor && auth.Has(acc.Permissions, auth.PermEditOthersPosts)

		if !canEdit {
			return 0, nil, forbiddenError("you cannot edit this post")
		}

		topic, err := txApp.FindRecordById(topicsCollectionName, post.GetString("topic_id"))
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("parent topic not found")
		}

		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermCloseTopics) {
			return 0, nil, conflictError("topic is locked")
		}

		post.Set("content", content)
		post.Set("edited", types.NowDateTime())
		if isModerated {
			post.Set("editor_id", e.Auth.Id)
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to update post", err)
		}

		if isModerated {
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
		// Same split as editing, and the same asymmetry kept on purpose: the
		// right to delete a stranger's post does not imply the right to edit it.
		byModeration := !isAuthor && auth.Has(acc.Permissions, auth.PermDeleteOthersPosts)

		if !isAuthor && !byModeration {
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
		// The first post of a topic IS the topic. With `sequence` gone it is
		// identified as the EARLIEST `created` in the topic, ties broken by id
		// — the same total order the feed uses, so this can never disagree with
		// what page 1 shows as the opening post.
		isFirstPost, err := isTopicOpeningPost(txApp, topic.Id, post.Id)
		if err != nil {
			return 0, nil, internalError("failed to identify the topic's first post", err)
		}
		if isFirstPost {
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
			"created":     post.GetDateTime("created").String(),
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
				OrderBy("created DESC", "id DESC").
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

		// No sequence renumbering: `created` travels with the post, so a moved
		// post keeps its original arrival time and lands in the target thread at
		// the position that time earned. Renumbering would have been the only
		// reason this handler needed the target's max sequence.
		for _, pid := range form.PostIDs {
			post, err := txApp.FindRecordById(postsCollectionName, pid)
			if err != nil || post == nil || post.GetString("topic_id") != sourceTopicID {
				return 0, nil, validationError(fmt.Sprintf("post %s does not belong to source topic", pid))
			}
			post.Set("topic_id", targetTopic.Id)
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
	// Latest = newest by `created`, id breaking a tie. Same order as the feed,
	// so "the last post" and "the bottom of page N" can never disagree.
	err := txApp.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topic.Id}).
		AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL")).
		OrderBy("created DESC", "id DESC").
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
