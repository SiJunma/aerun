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
		"deleted":   record.GetBool("deleted"),
		"created":   record.GetDateTime("created").String(),
		"updated":   record.GetDateTime("updated").String(),
	}

	if record.GetBool("deleted") {
		payload["content"] = ""
	} else {
		payload["content"] = record.GetString("content")
	}

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
	if err != nil || topic == nil || topic.GetBool("deleted") {
		return notFoundError("topic not found")
	}

	query := e.App.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topicID})

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
		"topic_id = {:topic_id} && sequence = {:seq}",
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
		if err != nil || post == nil || post.GetBool("deleted") {
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

// deletePostHandler soft-deletes a post and recalculates topic projections if needed.
func deletePostHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	postID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil || post.GetBool("deleted") {
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

		post.Set("deleted", true)
		post.Set("content", "")
		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to delete post", err)
		}

		// Update topic: recalculate visible posts count
		type countResult struct {
			Cnt int `db:"cnt"`
		}
		var cRes countResult
		err = txApp.DB().NewQuery("SELECT COUNT(*) AS cnt FROM posts WHERE topic_id = {:topic_id} AND deleted = false").
			Bind(dbx.Params{"topic_id": topic.Id}).
			One(&cRes)
		if err == nil {
			topic.Set("posts_count", cRes.Cnt)
		}

		// If this was the last_post_id on topic, find the latest active post
		if topic.GetString("last_post_id") == post.Id {
			var latestPosts []*core.Record
			err = txApp.RecordQuery(postsCollectionName).
				AndWhere(dbx.HashExp{"topic_id": topic.Id, "deleted": false}).
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
		}

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic metadata after post deletion", err)
		}

		if !isAuthor {
			if err := recordAuditLog(txApp, "post_delete", e.Auth.Id, map[string]any{
				"post_id":   post.Id,
				"topic_id":  topic.Id,
				"author_id": post.GetString("author_id"),
			}); err != nil {
				return 0, nil, err
			}
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
		if err != nil || sourceTopic == nil || sourceTopic.GetBool("deleted") {
			return 0, nil, notFoundError("source topic not found")
		}

		targetTopic, err := txApp.FindRecordById(topicsCollectionName, form.TargetTopicID)
		if err != nil || targetTopic == nil || targetTopic.GetBool("deleted") {
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
	_ = txApp.DB().NewQuery("SELECT COUNT(*) AS cnt FROM posts WHERE topic_id = {:topic_id} AND deleted = false").
		Bind(dbx.Params{"topic_id": topic.Id}).
		One(&cRes)
	topic.Set("posts_count", cRes.Cnt)

	var latestPosts []*core.Record
	err := txApp.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topic.Id, "deleted": false}).
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
