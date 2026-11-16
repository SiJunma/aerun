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
	"fmt"
	"net/http"
	"strings"

	"github.com/SiJunma/aerun/backend/internal/forum"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// draftPayload renders a draft row for the drafts page. Topic fields are
// attached by the caller when the topic is alive.
func draftPayload(r *core.Record) map[string]any {
	payload := map[string]any{
		"id":       r.Id,
		"topic_id": r.GetString("topic_id"),
		"content":  r.GetString("content"),
		"is_draft": true,
		"created":  r.GetDateTime("created").String(),
		"updated":  r.GetDateTime("updated").String(),
	}
	// The mask the draft is filed under, so a client can render the draft card
	// with the identity the text was written in. It travels raw exactly like it
	// does on postPayload: the owner check already happened in the command.
	if characterID := r.GetString("author_character_id"); characterID != "" {
		payload["author_character_id"] = characterID
	}
	// The throws a draft carries. A draft is private to its author, so there is
	// no reader to redact for here — the publish response is where that applies.
	if rolls, err := decodeRolls(r.Get("rolls")); err == nil && len(rolls) > 0 {
		payload["rolls"] = rolls
	}
	return payload
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
		// CharacterID is the mask the reply was picked in. It is stored ON THE
		// DRAFT, not reconstructed at publish time: publishing has to reproduce
		// the identity the text was written under, and by then the author may
		// have switched masks in the composer.
		CharacterID string `json:"character_id"`
		// Rolls travels with the text for the same reason it does on a post:
		// the `[roll=<id>]` reference in the body is meaningless without it.
		// A draft is published by promoting the row verbatim, so a throw lost
		// here is a throw lost for good.
		Rolls map[string]any `json:"rolls"`
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
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		// The unverified-write-rights architecture (plan PLAN_UNVERIFIED_WRITE_RIGHTS_2026-10-21):
		// categoryWriteAllowed decides whether this account may write in this
		// category — guest-zone override lets pending/unverified through, and
		// everything else refuses them. This closes the old loophole where a
		// draft saved in a guest topic could be published into a closed one.
		acc := AccessFrom(e)
		allowed, err := categoryWriteAllowed(txApp, acc, topic.GetString("category_id"), auth.PermPostReply)
		if err != nil {
			return 0, nil, internalError("failed to resolve category permission", err)
		}
		if !allowed {
			return 0, nil, forbiddenError("you cannot write in this category")
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
			setAccountAuthorRef(post, e.Auth.Id)
		}
		post.Set("is_draft", true)
		post.Set("content", content)
		// A draft holds its dice tags RAW — the throw happens at
		// publication (publishDraftHandler → RollDraftDice), exactly
		// as before. The client-supplied map is ignored here: it was
		// provisional (optimistic card), and the server decides each
		// value at publication with crypto/rand.
		if err := writeRolls(post, content, nil); err != nil {
			return 0, nil, validationError(err.Error())
		}
		// The client names the mask it wants and the server answers with
		// the one it will accept (403 on a borrowed mask).
		//
		// An explicit empty string means "draft as my account", not "whatever
		// mask was last selected in the composer". `resolveAuthorCharacter`
		// treats empty as "fall back to last_selected_character_id", which is
		// right for a fresh reply but wrong for a draft that may be edited
		// back onto the account while the composer still holds a mask.
		var characterID string
		if strings.TrimSpace(form.CharacterID) != "" {
			resolved, err := resolveAuthorCharacter(txApp, e.Auth.Id, form.CharacterID)
			if err != nil {
				return 0, nil, err
			}
			characterID = resolved
		}
		post.Set("author_character_id", characterID)

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
		if err == nil && topic != nil {
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

// deleteDraftHandler hard-deletes a draft.
//
// AUTHOR ONLY, with no permission that widens it. The owner was explicit:
// "nobody can see anyone else's drafts except the owner, in principle", and
// a moderator deleting someone's draft is therefore not a capability at all.
// This handler previously accepted `moderate_content` for foreign drafts,
// which contradicted both that rule and the drafts page itself (whose feed is
// scoped to `author_id = caller`) — the one place in the product where a
// stranger's draft was readable and destroyable.
//
// Consequence: a draft whose author is gone is unreachable, not auto-purgeable.
// Orphan cleanup is deliberately absent rather than a staff backdoor.
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
		if post.GetString("author_id") != e.Auth.Id {
			// 403, not 404: the caller proved the row exists by naming a
			// draft id, and a draft is not secret state in the way a password
			// is — but the id is never resolved to its content or author here.
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

// publishDraftHandler atomically turns a draft into a real post: clears
// is_draft and advances the topic projections in one transaction. An orphan
// draft can never be published.
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
		if err != nil || topic == nil {
			return 0, nil, conflictError("draft is orphaned: its topic no longer exists")
		}
		acc := AccessFrom(e)
		// The unverified-write-rights architecture (plan PLAN_UNVERIFIED_WRITE_RIGHTS_2026-10-21):
		// publishing a draft is a write into the topic's category, so the same
		// categoryWriteAllowed gate applies. A draft saved in a guest zone may not
		// be promoted into a closed category.
		allowed, err := categoryWriteAllowed(txApp, acc, topic.GetString("category_id"), auth.PermPostReply)
		if err != nil {
			return 0, nil, internalError("failed to resolve category permission", err)
		}
		if !allowed {
			return 0, nil, forbiddenError("you cannot write in this category")
		}
		// Same rule as createPostHandler: `close_topics` bypasses the lock, and
		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermCloseTopics) {
			return 0, nil, conflictError("topic is locked")
		}

		// The same settings-backed limit as createPostHandler, and the same
		// asymmetry: `close_topics` got past the lock above, but the post cap is
		// not bypassable. A draft saved before a limit was lowered cannot be
		// published into a topic that is already full.
		limit := effectiveMaxPostsPerTopic(txApp)
		existing, err := countPublishedPosts(txApp, topicID)
		if err != nil {
			return 0, nil, internalError("failed to count topic posts", err)
		}
		if existing >= limit {
			return 0, nil, conflictError("topic has reached the maximum post limit")
		}

		post.Set("is_draft", false)
		// THE THROW FREEZES HERE. A draft stores its dice tags RAW
		// ([dice=N type=T]) for as long as it is editable — the throw happens
		// at publication, server-side, exactly once. Promoting the row
		// verbatim without this pass would publish a post whose
		// [dice=...] tags render as "pending" forever.
		if content := post.GetString("content"); forum.DiceTagPattern.MatchString(content) {
			rolledContent, freshRolls := forum.RollDraftDice(content)
			// The draft body may also carry INHERITED [roll=<id>] references (a
			// draft saved under the older roll-at-save semantics, or a throw moved
			// between drafts). Their entries live in the stored map — merge the
			// freshly generated throws with them instead of replacing the map,
			// or the inherited tags would lose their throws and render raw.
			storedRolls, err := decodeRolls(post.Get("rolls"))
			if err != nil {
				storedRolls = map[string]any{}
			}
			mergedRolls := map[string]any{}
			for rollID, rollEntry := range storedRolls {
				mergedRolls[rollID] = rollEntry
			}
			for rollID, rollEntry := range freshRolls {
				mergedRolls[rollID] = rollEntry
			}
			if rolledContent == "" {
				// crypto/rand failure surface — refuse rather than publish
				// unresolved tags.
				return 0, nil, internalError("dice generation failed", fmt.Errorf("entropy source failed"))
			}
			post.Set("content", rolledContent)
			if err := writeRolls(post, rolledContent, mergedRolls); err != nil {
				return 0, nil, validationError(err.Error())
			}
		}
		// The mask lives on the draft row, so publishing keeps the identity the
		// text was written under. It is NOT re-read from the profile here: the
		// author may have switched masks since saving, and a post that silently
		// changed its author identity on publication is exactly the bug that made
		// "publish my draft" drop the mask. setLastPostProjection below copies
		// the mask from the post row, so no local copy is needed here.
		// Published post must stamped with the publication moment, not the draft's
		// original creation time. `created` is an AutodateField(onCreate: true), so
		// a plain Set is overwritten on save — SetRaw is the only way to make it
		// survive.
		now := types.NowDateTime()
		post.SetRaw("created", now)
		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to publish draft", err)
		}

		topic.Set("posts_count", topic.GetInt("posts_count")+1)
		// Same denormalisation createPostHandler writes, through the same
		// single writer: a topic list row renders "who spoke last" without
		// loading the post, so leaving this out made the published mask show
		// in the topic but not in the list.
		setLastPostProjection(topic, post)
		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		// A published draft IS a post, so it notifies like one. Omitting this would
		// make the drafts feature a way to post without anybody being told.
		dispatchPostNotifications(txApp, e.Auth.Id, post, topic.GetString("title"))

		// Publishing turns a draft into a real post, so the author's post count
		// moves now — the draft was deliberately not counted before this.
		if err := adjustUserPostCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
		}

		// The published post rides back DECORATED, exactly like a createPost
		// answer. The raw payload carries no author_name/is_character — the read
		// model resolves those — so an undecorated response made the client
		// re-render the fresh post with the account name and the mask appeared to
		// vanish the moment the draft was published.
		postOut := postPayload(post)
		decoratePostAuthors(txApp, []map[string]any{postOut})
		// Publishing turns a private row into forum content, so this is the first
		// moment the answer needs the same per-reader redaction the list route
		// applies — the stored throws are promoted verbatim, master dice included.
		redactPostRolls([]map[string]any{postOut}, AccessFrom(e))

		return http.StatusOK, map[string]any{
			"post":    postOut,
			"post_id": post.Id,
			// The ROLLED body travels back so the optimistic
			// row (showing the raw [dice=N] placeholder) can
			// reconcile onto the thrown post without a reload.
			"content":    post.GetString("content"),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
