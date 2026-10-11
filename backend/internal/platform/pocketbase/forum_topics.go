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
	// CharacterID is the mask the author picked. Empty means "use the one stored
	// on my profile" — resolveAuthorCharacter decides what is actually written.
	CharacterID string `json:"character_id"`
	// PinFirstPost is the "Pin first post on all pages" checkbox. It applies to
	// the OPENING post only; there is no other post in this transaction that
	// could carry it.
	PinFirstPost bool `json:"pin_first_post"`
	// Rolls is the result of the opening post's dice, keyed by the `[roll=<id>]`
	// reference processDiceRolls wrote into the content. Dropped before, so a
	// new topic with a throw in it showed the raw tag to every reader.
	Rolls map[string]any `json:"rolls"`
}

type updateTopicForm struct {
	Title  *string `json:"title"`
	Locked *bool   `json:"locked"`
	Pinned *bool   `json:"pinned"`
}

type moveTopicForm struct {
	CategoryID string `json:"category_id"`
}

// topicPayload is the topic read model WITHOUT author display fields.
//
// Author decoration is a separate pass (decorateTopicAuthors) because it costs
// a users lookup, and several callers — the create/update/move responses —
// already have the transaction's app and want it, while the pure record shape
// is what the fixtures and tests assert on.
func topicPayload(record *core.Record) map[string]any {
	payload := map[string]any{
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
	// Both mask references are emitted RAW; decorateTopicAuthor resolves and
	// ownership-checks them. They are omitted when empty so a topic written
	// without a mask is indistinguishable from one that never had the option.
	if characterID := record.GetString("author_character_id"); characterID != "" {
		payload["author_character_id"] = characterID
	}
	if characterID := record.GetString("last_post_author_character_id"); characterID != "" {
		payload["last_post_author_character_id"] = characterID
	}
	// TopicPage gates its pinned-post banner on `topic.first_post_pinned &&
	// currentPage > 1`. The flag is derived from the OPENING post's own row rather
	// than stored on the topic, because a second copy would be free to disagree
	// with the post it describes.
	// TopicPage gates its pinned-post banner on `topic.first_post_pinned &&
	// currentPage > 1`, and the topic editor round-trips the same field, so the
	// flag is a first-class part of the topic read model — not something the
	// client should have to infer from whichever posts it happens to have loaded.
	payload["first_post_pinned"] = record.GetBool("first_post_pinned")
	return payload
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

		// Resolved before the first Save so a forbidden mask aborts the whole
		// command rather than leaving a half-written topic behind.
		characterID, err := resolveAuthorCharacter(txApp, e.Auth.Id, form.CharacterID)
		if err != nil {
			return 0, nil, err
		}
		topic.Set("author_character_id", characterID)

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to create topic", err)
		}

		// 2. The opening post. It carries no sequence: ordering is by `created`,
		// and this post is by construction the earliest in the topic.
		post := core.NewRecord(postsCol)
		post.Set("topic_id", topic.Id)
		post.Set("author_id", e.Auth.Id)
		post.Set("content", content)
		// The topic and its opening message are always the same voice, so the
		// mask is resolved ONCE and written to both rows.
		post.Set("author_character_id", characterID)
		// Same for the throws: validated against this body and stored with it,
		// in the transaction that creates the post.
		if err := writeRolls(post, content, form.Rolls); err != nil {
			return 0, nil, validationError(err.Error())
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to create initial post", err)
		}

		// "Pin first post on all pages" lives on the TOPIC (legacy schema,
		// PROJECT_SPEC.md:107), and "the pinned post" is therefore a rule — the
		// earliest post — rather than a flag on some arbitrary message. Storing
		// it per-post would have silently lost the pin on every imported legacy
		// topic and broken the topic editor's round-trip.
		topic.Set("first_post_pinned", form.PinFirstPost)

		// 3. Update topic's last_post projection
		topic.Set("last_post_id", post.Id)
		topic.Set("last_post_created", post.GetDateTime("created"))
		topic.Set("last_post_author_id", post.GetString("author_id"))
		topic.Set("last_post_author_character_id", characterID)

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		// The opening post is a post like any other, so it notifies like any
		// other: subscribers of a brand-new topic (only the author, who is
		// skipped), quoted authors, mentions.
		dispatchPostNotifications(txApp, e.Auth.Id, post, topic.GetString("title"))

		// 4. The author gains one topic AND its opening post. Both counters move
		// here, in the same transaction as the rows that justify them.
		if err := adjustUserPostCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
		}
		if err := adjustUserTopicCount(txApp, e.Auth.Id, 1); err != nil {
			return 0, nil, err
		}

		// The author display fields are resolved BEFORE the transaction commits,
		// so the very first render of a brand-new topic already shows a name
		// instead of a placeholder that only fills in on the next poll. The
		// counters written above are part of the same transaction, so this read
		// cannot observe a half-written author.
		topicOut := topicPayload(topic)
		postOut := postPayload(post)
		decorateTopicAuthors(txApp, []map[string]any{topicOut})
		decoratePostAuthors(txApp, []map[string]any{postOut})
		redactPostRolls([]map[string]any{postOut}, AccessFrom(e))

		resp := map[string]any{
			"topic":      topicOut,
			"first_post": postOut,
			// `post` mirrors `first_post`. The create response had two names for
			// one object and each caller picked a different one, so the topic
			// form read `topicId` (never sent) and the reply path read `postId`
			// (never sent). One canonical name, mirrored for the callers that
			// already speak it.
			"post":       postOut,
			"topic_id":   topic.Id,
			"request_id": requestIDFrom(e),
		}
		return http.StatusCreated, resp, nil
	})

	return writeCommandResult(e, outcome, err)
}

// listTopicsHandler lists topics with keyset pagination.
//
// It filters nothing: since 1767700000 a deleted topic is a GONE row, so
// there is no flag left to filter on and no "non-deleted" qualifier to apply.
func listTopicsHandler(e *core.RequestEvent) error {
	settings := loadForumSettings(e.App)
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), settings.TopicsPerPage), settings.TopicsPerPage)
	categoryID := strings.TrimSpace(e.Request.URL.Query().Get("category_id"))

	// Pinned-first ranking is a CATEGORY-PAGE guarantee, and it is requested
	// EXPLICITLY, never inferred. The one screen that renders a category's topic
	// table (CategoryPage → fetchSecuredTopics) sends `pinned_first=1`; every
	// other reader of this endpoint wants pure recency — the global /active-topics
	// and /new-replies feeds, AND subscribeToTopics / subscribeToLastTopicInCategory,
	// which read a category's topics for index and last-post cards while still
	// expecting "newest first". Inferring the pin from the mere presence of a
	// category_id handed those callers a pinned block they never asked for; an
	// explicit flag keeps the guarantee exactly where it belongs.
	pinPriority := parseIntParam(e.Request.URL.Query().Get("pinned_first"), 0) == 1

	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}
	// `unread=1` narrows the list to the caller's topics with replies they have
	// not seen. It is a FILTER, not a different endpoint: the same ordering, the
	// same paging and the same `total` apply, which is why the client can page an
	// unread feed without a second code path.
	unreadOnly := parseIntParam(e.Request.URL.Query().Get("unread"), 0) == 1

	// No `deleted` filter here.
	//
	// Migration 1767700000 dropped that column when deletion became HARD: a
	// deleted topic is removed, not flagged. The filter outlived the column, so
	// SQLite rejected the whole statement ("no such column: deleted") and the
	// handler answered 500 — for EVERY category, whether or not it had topics,
	// because the query never got far enough to look at the data.
	//
	// Nothing caught it because no test exercised this route: the topic suite
	// only ever POSTed. See TestListTopicsRunsAgainstLiveSchema.
	query := e.App.RecordQuery(topicsCollectionName)

	var where []dbx.Expression
	if categoryID != "" {
		where = append(where, dbx.HashExp{"category_id": categoryID})
		query = query.AndWhere(dbx.HashExp{"category_id": categoryID})
	}

	// The unread filter resolves the caller's unread topic ids first and pins the
	// main query to them.
	//
	// Pinning by id rather than re-expressing the join is deliberate: the
	// predicate lives in ONE place (`unreadTopicsPredicate`) and is shared with the
	// unread badge counter, so the feed and the number in the tab title cannot drift
	// apart. Two copies of "what counts as unread" is how a member ends up with a
	// badge reading 40 and a feed that can only ever show 20.
	if unreadOnly {
		ids, err := unreadTopicIDs(e)
		if err != nil {
			return internalError("failed to resolve unread topics", err)
		}
		if len(ids) == 0 {
			// Nothing unread. Answered as an empty page rather than as a filter that
			// matched nothing, because `dbx.In` with an empty slice produces invalid
			// SQL — and an unread feed is a legitimate empty state, not a reason to
			// 500 the tab the member just clicked.
			return e.JSON(http.StatusOK, map[string]any{
				"items":       []map[string]any{},
				"total":       0,
				"page":        page,
				"per_page":    limit,
				"next_cursor": "",
				"request_id":  requestIDFrom(e),
			})
		}
		inArgs := make([]any, len(ids))
		for i, id := range ids {
			inArgs[i] = id
		}
		where = append(where, dbx.In("id", inArgs...))
		query = query.AndWhere(dbx.In("id", inArgs...))
	}

	// Keyset pagination cursor. The cursor shape mirrors the ordering, and the
	// ordering is pin-aware ONLY when pinned_first was requested (pinPriority).
	// Encoding the pin for a recency feed — where pinned topics are NOT ranked
	// first — would make the predicate jump to a rank the list never used, so the
	// two cursor shapes stay distinct:
	//
	//   pinned_first=1  → `pinned|last_post_created|id`  (pinned DESC first)
	//   everything else → `last_post_created|id`          (recency only)
	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if pinPriority && len(parts) == 3 {
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
		} else if !pinPriority && len(parts) == 2 {
			lastPostCreated := parts[0]
			lastID := parts[1]

			// Keyset predicate for (last_post_created DESC, id DESC)
			query = query.AndWhere(dbx.NewExp(
				"(last_post_created < {:created}) OR (last_post_created = {:created} AND id < {:id})",
				dbx.Params{
					"created": lastPostCreated,
					"id":      lastID,
				},
			))
		}
	}

	// Pinned-first ranking is a CATEGORY-PAGE guarantee, requested via
	// pinned_first=1. Everywhere else — the global /active-topics and /new-replies
	// feeds, and the category reads that back the index cards (subscribeToTopics,
	// subscribeToLastTopicInCategory) — a pinned topic must NOT outrank a fresher
	// one: a member scanning "latest activity" expects pure recency, with the pin
	// acting only as a row icon. Ordering those lists by pin would strand an old
	// pinned announcement above every recent reply.
	if pinPriority {
		query = query.OrderBy("pinned DESC", "last_post_created DESC", "id DESC")
	} else {
		query = query.OrderBy("last_post_created DESC", "id DESC")
	}
	query = query.Limit(int64(limit + 1))

	// Page pagination, offset-based, for the CATEGORY VIEW. It applies only when
	// no cursor was supplied: a keyset cursor already encodes the position, and
	// adding an offset on top of it would skip rows the cursor did not name.
	//
	// The category page paginates by number ("page 2 of 5"), which is what the
	// legacy Firestore query did with .startAfter(lastDoc) fed by a running
	// offset — so without this the view could only ever show page 1 no matter
	// which page the member asked for.
	if cursor == "" && page > 1 {
		query = query.Offset(int64((page - 1) * limit))
	}

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to list topics", err)
	}

	var nextCursor string
	if len(records) > limit {
		lastRec := records[limit-1]
		records = records[:limit]
		lastPostCreated := lastRec.GetDateTime("last_post_created").String()
		if pinPriority {
			// pinned_first request: encode the pin so the cursor can resume after
			// the pinned-first block (pinned|last_post_created|id).
			pinnedFlag := "0"
			if lastRec.GetBool("pinned") {
				pinnedFlag = "1"
			}
			nextCursor = fmt.Sprintf("%s|%s|%s", pinnedFlag, lastPostCreated, lastRec.Id)
		} else {
			// Recency feeds: no pin in the ordering, so none in the cursor
			// (last_post_created|id).
			nextCursor = fmt.Sprintf("%s|%s", lastPostCreated, lastRec.Id)
		}
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = topicPayload(r)
	}
	decorateTopicAuthors(e.App, items)

	// Per-row unread flag, resolved SERVER-side against the SAME predicate the
	// badge and the /new-replies feed use (unreadTopicIDs → unreadTopicsPredicate).
	//
	// The row indicators on the category page and the main index still derive
	// "unread" from a per-device localStorage readMap, which the PocketBase
	// migration left behind from the Firestore era. That map can disagree with the
	// server's read state — a topic read server-side but stale locally keeps its
	// dot forever, and "mark all read" cannot reach it because it is absent from
	// the server's own unread list. Emitting the authoritative flag here gives
	// every row renderer one source of truth; a guest (no e.Auth) keeps the
	// existing behaviour with the field simply absent.
	//
	// TODO(sprint): reuse the ids already resolved above when unreadOnly, and add
	// the same flag to the main-index last-post projection (category_access.go).
	if e.Auth != nil {
		if ids, err := unreadTopicIDs(e); err == nil {
			unreadSet := make(map[string]bool, len(ids))
			for _, id := range ids {
				unreadSet[id] = true
			}
			for i, r := range records {
				items[i]["unread"] = unreadSet[r.Id]
			}
		}
	}

	// `total` is what the client paginates against. It is counted over the same
	// filter as the page, so a category with 45 topics reports 45 on every page
	// rather than the 20 that happen to be in this response.
	total, err := e.App.CountRecords(topicsCollectionName, where...)
	if err != nil {
		return internalError("failed to count topics", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"total":       int(total),
		"page":        page,
		"per_page":    limit,
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

	payload := topicPayload(topic)
	decorateTopicAuthors(e.App, []map[string]any{payload})

	return e.JSON(http.StatusOK, map[string]any{
		"topic":      payload,
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
	if err := requireNotBanned(acc, "edit a topic"); err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		isAuthor := e.Auth != nil && topic.GetString("author_id") == e.Auth.Id
		// Editing and deleting a stranger's topic are separately assignable, and
		// the delete key deliberately does not imply the edit key. `hasMod` is
		// kept for the three unrelated settings below (lock/pin/move) that are
		// gated by their own dedicated keys OR the legacy umbrella.
		//
		// `edit_self_topic` is enforced here for the first time — authorship alone
		// used to be sufficient, so the key was granted by the matrix, shown in
		// the admin panel, and read by nothing.
		canEditOthers := !isAuthor && auth.Has(acc.Permissions, auth.PermEditOthersTopics)
		canEdit := canEditOthers ||
			(isAuthor && auth.Has(acc.Permissions, auth.PermEditSelfTopic))
		hasMod := canEdit || auth.Has(acc.Permissions, auth.PermDeleteOthersTopics)

		if form.Title != nil {
			if !canEdit {
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
	if err := requireNotBanned(acc, "delete a topic"); err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, id)
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		isAuthor := e.Auth != nil && topic.GetString("author_id") == e.Auth.Id
		// `delete_others_topics` is the only way to remove a topic belonging to
		// another account. It is granted to admins and root, and deliberately
		// NOT to moderators.
		if !isAuthor && !auth.Has(acc.Permissions, auth.PermDeleteOthersTopics) {
			return 0, nil, forbiddenError("you cannot delete this topic")
		}

		// Deleting your OWN topic has two cases, and the difference is whether
		// anybody else's words are in it:
		//
		//  1. Nothing but your own opening post. Allowed with NO permission.
		//     There is no other member's content to destroy, so the delete costs
		//     nobody anything — and the author must always have a way to remove
		//     a thread that did not take off.
		//  2. Replies from other members present. Refused unless the account
		//     holds `delete_own_topic_with_replies`, the MyBB-shaped cascade
		//     right. It is granted to no built-in role on purpose, so this power
		//     is handed out per custom role instead of being inherited from
		//     "can create a topic".
		//
		// A player, moderator and root are all subject to case 2 equally. The
		// asymmetry that would otherwise exist (staff can, members cannot) is
		// deliberate and was checked: the staff escape hatch is
		// `delete_others_topics`, which admins and root hold.
		needsCascadeRight := false
		if isAuthor && !auth.Has(acc.Permissions, auth.PermDeleteOthersTopics) {
			others, err := countOtherAuthorsInTopic(txApp, topic.Id, e.Auth.Id)
			if err != nil {
				return 0, nil, internalError("failed to check topic participants", err)
			}
			needsCascadeRight = others > 0
		}
		if needsCascadeRight && !auth.Has(acc.Permissions, auth.PermDeleteOwnTopicWithReplies) {
			return 0, nil, conflictError(
				"this topic has replies from other members; removing it would delete their posts too",
			)
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
// DRAFTS SURVIVE, and they were never counted anyway — an unsent draft moves no
// counter, so the per-author aggregation above (which counts only published
// posts) is unaffected by leaving them behind.
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

	// Only PUBLISHED posts are removed. Drafts SURVIVE the deletion of their
	// topic, and that is the point of the `orphan` flag the drafts feed already
	// carries: an author must not lose unsent text because somebody removed the
	// thread. The previous code deleted every row in the topic, which made the
	// orphan branch of listMyDraftsHandler unreachable in practice — the state
	// it exists to present could only arise from a corrupted database.
	//
	// A surviving draft cannot be published: publishDraftHandler resolves the
	// topic first and answers 409 when it is gone, and the drafts feed shows it
	// under "orphans" with copy-forward and delete as the only actions.
	posts, err := txApp.FindAllRecords(
		postsCollectionName,
		dbx.NewExp("topic_id = {:topic}", dbx.Params{"topic": topic.Id}),
	)
	if err != nil {
		return internalError("failed to read the posts of a deleted topic", err)
	}
	for _, post := range posts {
		// A draft is the author's unsent work, not forum content. Deleting the
		// topic is not consent to delete it.
		if post.GetBool("is_draft") {
			continue
		}
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
