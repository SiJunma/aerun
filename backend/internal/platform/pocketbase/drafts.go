package pocketbase

// Draft posts (2026-09-26): a draft is a post row with is_draft=true,
// sequence 0 and no effect on topic projections until published. The legacy
// contract "one draft per user per topic" is enforced by the partial unique
// index added in 1766700000, so the upsert below can rely on it.
//
// Routes (registered in run.go):
//
//	GET    /api/aerun/me/drafts           — drafts page feed (orphans first)
//	GET    /api/aerun/topics/{id}/draft   — the caller's draft in a topic
//	PUT    /api/aerun/topics/{id}/draft   — create or update (upsert)
//	DELETE /api/aerun/drafts/{id}         — remove a draft (hard delete)
//	POST   /api/aerun/drafts/{id}/publish — become a real post atomically
//
// An "orphan" draft references a topic that is missing or deleted: it can be
// copied (the client re-saves the content into another topic) or deleted, but
// never published — the publish command refuses a dead topic.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// draftPayload renders a draft row for the drafts page. Topic fields are
// attached by the caller when the topic is alive.
func draftPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":       r.Id,
		"topic_id": r.GetString("topic_id"),
		"content":  r.GetString("content"),
		"is_draft": true,
		"created":  r.GetDateTime("created").String(),
		"updated":  r.GetDateTime("updated").String(),
	}
}

// validateDraftContent validates draft text. A draft may be empty (the user
// opens the editor and saves a placeholder), but never oversized.
func validateDraftContent(content string) (string, error) {
	content = strings.TrimSpace(content)
	if len(content) > 65536 {
		return "", errDraftTooLarge
	}
	return content, nil
}

// upsertDraftHandler creates or updates the caller's draft in a topic.
// Idempotent by the (author, topic) unique index: re-saving overwrites.
func upsertDraftHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	topicID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxPostContentBodyBytes)
	if err != nil {
		return err
	}
	var form struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	content, err := validateDraftContent(form.Content)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, topicID)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, notFoundError("topic not found")
		}

		existing, _ := txApp.FindFirstRecordByFilter(
			postsCollectionName,
			"topic_id = {:topic} && author_id = {:author} && is_draft = true",
			dbx.Params{"topic": topicID, "author": e.Auth.Id},
		)

		var post *core.Record
		if existing != nil {
			post = existing
		} else {
			postsCol, err := txApp.FindCollectionByNameOrId(postsCollectionName)
			if err != nil {
				return 0, nil, internalError("posts collection unavailable", err)
			}
			post = core.NewRecord(postsCol)
			post.Set("topic_id", topicID)
			post.Set("author_id", e.Auth.Id)
			post.Set("sequence", 0)
			post.Set("deleted", false)
		}
		post.Set("is_draft", true)
		post.Set("content", content)

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to save draft", err)
		}
		return http.StatusOK, map[string]any{
			"draft":      draftPayload(post),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// errDraftTooLarge is the oversized-draft validation error.
var errDraftTooLarge = &fieldError{"content", "draft content exceeds the size limit"}

// fieldError is a minimal validation error carrying a field name.
type fieldError struct{ field, message string }

func (f *fieldError) Error() string { return f.field + ": " + f.message }

// getDraftHandler returns the caller's draft in a topic, or {"draft": null}.
func getDraftHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication is required to view drafts")
	}
	topicID := e.Request.PathValue("id")
	post, _ := e.App.FindFirstRecordByFilter(
		postsCollectionName,
		"topic_id = {:topic} && author_id = {:author} && is_draft = true",
		dbx.Params{"topic": topicID, "author": e.Auth.Id},
	)
	var payload any
	if post != nil {
		payload = draftPayload(post)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"draft":      payload,
		"request_id": requestIDFrom(e),
	})
}

// listMyDraftsHandler is the drafts page feed: orphan drafts (topic missing or
// deleted) come first, then the live ones, newest edit first.
func listMyDraftsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication is required to view drafts")
	}

	records, err := e.App.FindAllRecords(
		postsCollectionName,
		dbx.HashExp{"author_id": e.Auth.Id, "is_draft": true},
	)
	if err != nil {
		return internalError("failed to query drafts", err)
	}

	type item = draftItem
	items := make([]item, 0, len(records))
	for _, r := range records {
		it := item{payload: draftPayload(r), orphan: true, updated: r.GetDateTime("updated").String()}
		topic, err := e.App.FindRecordById(topicsCollectionName, r.GetString("topic_id"))
		if err == nil && topic != nil && !topic.GetBool("deleted") {
			it.orphan = false
			it.payload["topic_title"] = topic.GetString("title")
			it.payload["category_id"] = topic.GetString("category_id")
		}
		items = append(items, it)
	}
	// Two-pass partition keeps the feed deterministic: orphans first, then
	// live drafts, each group newest-edit first.
	sortDraftItems(items)
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		it.payload["orphan"] = it.orphan
		out = append(out, it.payload)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"items":      out,
		"request_id": requestIDFrom(e),
	})
}

// draftItem is one entry of the drafts feed before rendering.
type draftItem struct {
	payload map[string]any
	orphan  bool
	updated string
}

// sortDraftItems orders the feed: orphans first, then newest edit first,
// ties broken by id. Insertion sort over a small slice — a drafts page
// never holds thousands of rows.
func sortDraftItems(items []draftItem) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0; j-- {
			if draftBefore(items[j-1], items[j]) {
				break
			}
			items[j-1], items[j] = items[j], items[j-1]
		}
	}
}

// draftBefore reports whether a already precedes b in the feed order:
// orphans first, then newest edit first, ties broken by id.
func draftBefore(a, b draftItem) bool {
	if a.orphan != b.orphan {
		return a.orphan // orphan goes first
	}
	if a.updated != b.updated {
		return a.updated > b.updated
	}
	pa, _ := a.payload["id"].(string)
	pb, _ := b.payload["id"].(string)
	return pa < pb
}

// deleteDraftHandler hard-deletes the caller's own draft.
func deleteDraftHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	id := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, id)
		if err != nil || post == nil || !post.GetBool("is_draft") {
			return 0, nil, notFoundError("draft not found")
		}
		if post.GetString("author_id") != e.Auth.Id && !auth.Has(AccessFrom(e).Permissions, auth.PermModerateContent) {
			return 0, nil, forbiddenError("only the author may delete a draft")
		}
		if err := txApp.Delete(post); err != nil {
			return 0, nil, internalError("failed to delete draft", err)
		}
		return http.StatusOK, map[string]any{
			"deleted":    true,
			"id":         id,
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// forumMaxPostsPerTopic mirrors the compiled forum ceiling used by
// createPostHandler (forum.MaxPostsPerTopic); drafts obey it on publish.
const forumMaxPostsPerTopic = 2000

// publishDraftHandler atomically turns a draft into a real post: assigns the
// next per-topic sequence, clears is_draft and advances the topic projections
// in one transaction. An orphan draft can never be published.
func publishDraftHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	id := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, id)
		if err != nil || post == nil || !post.GetBool("is_draft") {
			return 0, nil, notFoundError("draft not found")
		}
		if post.GetString("author_id") != e.Auth.Id {
			return 0, nil, forbiddenError("only the author may publish a draft")
		}

		topicID := post.GetString("topic_id")
		topic, err := txApp.FindRecordById(topicsCollectionName, topicID)
		if err != nil || topic == nil || topic.GetBool("deleted") {
			return 0, nil, conflictError("draft is orphaned: its topic no longer exists")
		}
		acc := AccessFrom(e)
		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermModerateContent) {
			return 0, nil, conflictError("topic is locked")
		}

		type maxSeqResult struct {
			MaxSeq int `db:"max_seq"`
		}
		var seqRes maxSeqResult
		if err := txApp.DB().NewQuery("SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM posts WHERE topic_id = {:topic_id}").
			Bind(dbx.Params{"topic_id": topicID}).
			One(&seqRes); err != nil {
			return 0, nil, internalError("failed to calculate next post sequence", err)
		}
		nextSeq := seqRes.MaxSeq + 1
		if nextSeq > forumMaxPostsPerTopic {
			return 0, nil, conflictError("topic has reached the maximum post limit")
		}

		post.Set("is_draft", false)
		post.Set("sequence", nextSeq)
		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to publish draft", err)
		}

		topic.Set("posts_count", topic.GetInt("posts_count")+1)
		topic.Set("last_post_id", post.Id)
		topic.Set("last_post_created", post.GetDateTime("created"))
		topic.Set("last_post_author_id", post.GetString("author_id"))
		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		return http.StatusOK, map[string]any{
			"post":       postPayload(post),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
