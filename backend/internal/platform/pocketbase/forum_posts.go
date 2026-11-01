package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/forum"
)

const maxPostContentBodyBytes = 128 * 1024

type createPostForm struct {
	Content string `json:"content"`
	// Rolls is the result of the dice the author threw: a map keyed by the
	// `[roll=<id>]` reference that processDiceRolls wrote into the body.
	//
	// It was DROPPED on the floor before — createPost destructured only
	// `{ content }` out of processDiceRolls and sent the text alone — so the
	// throw was rendered from the optimistic card and then lost, and every
	// reader after a reload saw the raw `[roll=…]` tag. The tag is a pointer
	// with no payload of its own; this map is the payload.
	Rolls map[string]any `json:"rolls"`
	// CharacterID is the mask the author picked in the reply composer. Empty
	// means "use the one stored on my profile" — see resolveAuthorCharacter,
	// which is what actually decides the value that gets written.
	CharacterID string `json:"character_id"`
	// GuestNickname is the display name a guest picks when posting without an
	// account. Empty for authenticated users.
	GuestNickname string `json:"guest_nickname"`
}

type editPostForm struct {
	Content string `json:"content"`
	// Rolls follows the same reasoning as createPostForm.Rolls. A POINTER for
	// the same reason CharacterID is one: an edit that never touched the dice
	// must leave the stored throws alone, and an absent key is the only way to
	// say "I did not change them". A plain map would make every edit wipe the
	// results of the post it was rewriting.
	Rolls *map[string]any `json:"rolls"`
	// CharacterID re-files the post under a different mask.
	//
	// A POINTER, not a string: the edit form sends this key only when the author
	// actually changed the picker, and an absent key must mean "leave the stored
	// mask alone". A plain string cannot tell "no change" from "post as my
	// account", so every edit would silently strip the mask — the same class of
	// defect as a draft published without its mask.
	CharacterID *string `json:"character_id"`
}

type movePostsForm struct {
	TargetTopicID string   `json:"target_topic_id"`
	PostIDs       []string `json:"post_ids"`
}

func postPayload(record *core.Record) map[string]any {
	payload := map[string]any{
		"id":       record.Id,
		"topic_id": record.GetString("topic_id"),
		"created":  record.GetDateTime("created").String(),
		"updated":  record.GetDateTime("updated").String(),
	}
	// Nested AuthorRef DTO (ADR contract) is the single source of truth for
	// the post author. New readers must use payload["author"].
	payload["author"] = authorDTOFromRecord(record)

	// `rolls` is the RESULT of the post's dice throws, and it is what turns
	// `[roll=roll_…]` back into a number. It travels with the payload because
	// without it every reader — guest included — sees the raw tag: BBCode's
	// roll branch falls back to printing `[roll=<id>]` when the id is not in
	// the map it was given.
	//
	// The column is projected here RAW; per-reader redaction of master dice is
	// a separate pass (redactPostRolls) for the same reason `author_character_id`
	// is raw here and resolved by decoratePostAuthor — the shape a record has
	// and what one reader may see of it are different questions.
	if rolls, err := decodeRolls(record.Get("rolls")); err == nil && len(rolls) > 0 {
		payload["rolls"] = rolls
	}

	// `author_character_id` travels RAW and unresolved on purpose. The read
	// model resolves the display through decoratePostAuthor, which is also where
	// ownership is checked — a payload must never hand the browser a mask name
	// the server has not confirmed belongs to this author.
	if characterID := record.GetString("author_character_id"); characterID != "" {
		payload["author_character_id"] = characterID
	}

	// No `deleted` key: a deleted post is gone from the database, so the payload
	// has nothing to report. The client cannot be handed a flag for a state the
	// server no longer stores, and an always-false flag is worse than none — it
	// invites a branch that can never be true.
	payload["content"] = record.GetString("content")

	// `karma` is the post's vote score (the JSON field is named `karma` — NOT
	// `reputation` — because `reputation` on a profile is the member's aggregate
	// score, and the two were constantly confused on the wire). The command layer
	// keeps posts.reputation in step with every cast, replace and withdrawal
	// (reputation.go), so the column is authoritative — but until it is projected
	// here the topic page had no way to see it: its karma badge renders
	// `post.karma || 0` and gates the "view who evaluated" eye on
	// `(post.karma || 0) !== 0`, so a post that plainly carried votes rendered
	// "0" and the eye never appeared. `GetInt` yields 0 for a row that predates
	// the column, which is exactly the correct empty score.
	payload["karma"] = record.GetInt("reputation")

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
	// The unverified-write-rights architecture (plan PLAN_UNVERIFIED_WRITE_RIGHTS_2026-10-21)
	// delegates the write decision to categoryWriteAllowed, which correctly
	// permits guest-zone posting for pending/unverified accounts and refuses
	// them elsewhere. No requireVerified gate here anymore.
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		topic, err := txApp.FindRecordById(topicsCollectionName, topicID)
		// `topic == nil` is the whole "not there" test. There is no `deleted`
		// flag to check: migration 1767700000 made deletion hard, so a deleted
		// topic is a missing row. The check that used to sit here silently read
		// false forever — PocketBase returns the zero value for an unknown
		// field — which is the exact illusion .agents/AGENTS.md warns about.
		if err != nil || topic == nil {
			return 0, nil, notFoundError("topic not found")
		}

		// A category-level override can GRANT `post_reply` to a role that lacks
		// it globally; an explicit role list that excludes the caller denies it.
		allowed, err := categoryWriteAllowed(txApp, acc, topic.GetString("category_id"), auth.PermPostReply)
		if err != nil {
			return 0, nil, internalError("failed to resolve category permission", err)
		}
		if !allowed {
			return 0, nil, forbiddenError("you cannot post in this category")
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
		if e.Auth != nil {
			setAccountAuthorRef(post, e.Auth.Id)
		} else {
			// Guest display name is immutable content data stored on the
			// AuthorRef columns (guest_display_name).
			guestNickname, err := forum.ValidateGuestNickname(form.GuestNickname)
			if err != nil {
				return 0, nil, validationError(err.Error())
			}
			setGuestAuthorRef(post, guestNickname)
			post.Set("guest_principal_id", guestPrincipalIDFromRequest(e))
		}
		post.Set("content", content)

		// The dice results are validated against the body that references them
		// and stored in the same transaction as the post, so a throw can never
		// outlive the tag that points at it or vice versa.
		if err := writeRolls(post, content, form.Rolls); err != nil {
			return 0, nil, validationError(err.Error())
		}

		// The mask is resolved HERE, inside the transaction, so the post and the
		// profile it was chosen from cannot disagree. A reply never carries a
		// pinned flag: pinning is a property of a topic's opening message, and
		// letting it ride on an arbitrary reply would produce a second banner
		// that the unique index then rejects as a 500.
		var characterID string
		if e.Auth != nil {
			characterID, err = resolveAuthorCharacter(txApp, e.Auth.Id, form.CharacterID)
			if err != nil {
				return 0, nil, err
			}
		}
		post.Set("author_character_id", characterID)

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to save post", err)
		}

		// Update topic counters and projection through the single writer, so a
		// topic LIST row renders "who spoke last" from the same columns the
		// rebuild produces. The mask rides along because the column exists for
		// exactly this denormalisation, written in the same transaction.
		topic.Set("posts_count", topic.GetInt("posts_count")+1)
		setLastPostProjection(topic, post)

		if err := txApp.Save(topic); err != nil {
			return 0, nil, internalError("failed to update topic projection", err)
		}

		// The author's own counter moves in the same transaction, for the same
		// reason: a member list that lags a reply by one is a visible lie.
		// Guests have no account counter.
		if e.Auth != nil {
			if err := adjustUserPostCount(txApp, e.Auth.Id, 1); err != nil {
				return 0, nil, err
			}
		}

		// Notifications are a CONSEQUENCE of the post, written in the same
		// transaction: topic subscribers, quoted authors and mentions. A
		// notification that cannot be delivered must not cost somebody their
		// reply, so the dispatcher reports nothing and the post stands.
		// For guest authors (e.Auth == nil), actorID is empty.
		var actorID string
		if e.Auth != nil {
			actorID = e.Auth.Id
		}
		dispatchPostNotifications(txApp, actorID, post, topic.GetString("title"))

		// The nudge for the topic itself, in the same transaction as the reply.
		// PublishTopicSignal decides the audience against the GUEST baseline,
		// so a reply in a restricted category announces nothing to the forum
		// and its readers simply keep polling.
		publishTopicSignal(txApp, topic)

		// The author's display fields ride along with the reply itself. The
		// caller's post count was written just above in this same transaction,
		// so the value sent back is the post's own new count — the reply renders
		// with its author's real name and score instead of a placeholder that
		// only fills in on the next poll.
		postOut := postPayload(post)
		decoratePostAuthors(txApp, []map[string]any{postOut})
		redactPostRolls([]map[string]any{postOut}, acc)

		resp := map[string]any{
			"post": postOut,
			// `post_id` is the bare id under its own name. The reply path asked
			// for `postId`, which no route has ever sent, so the page navigated
			// without a target and the reader never saw their own reply.
			"post_id":    post.Id,
			"topic_id":   topicID,
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
	acc := AccessFrom(e)
	allowed, topic, err := canViewTopic(e.App, acc, topicID)
	if err != nil || !allowed || topic == nil {
		// Deleted / missing topic answers 200 with a deleted flag instead of
		// a cascade of 404s: the client gets one successful response.
		return e.JSON(http.StatusOK, map[string]any{
			"deleted":    true,
			"topic_id":   topicID,
			"items":      []map[string]any{},
			"request_id": requestIDFrom(e),
		})
	}

	settings := loadForumSettings(e.App)
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), settings.PostsPerPage), settings.PostsPerPage)
	resolution := resolveListPage(e, topicID, limit)
	page := resolution.page
	if page < 1 {
		page = 1
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
	decoratePostAuthors(e.App, items)
	// After the author pass, because redaction is the LAST thing that touches
	// the payload: a master throw's value must not survive into a guest's
	// response, and this is the route guests read the forum through.
	redactPostRolls(items, AccessFrom(e))

	// The pinned first post rides ALONGSIDE the page rather than inside it. It is
	// the topic's EARLIEST post, so on page 1 it is already in `items` and
	// echoing it here would render it twice; from page 2 on it is the only way
	// the reader can see it, which is the entire point of the checkbox.
	//
	// Gated on the topic's own `first_post_pinned` flag, matching the retired
	// callable (`topicData.first_post_pinned && resolvedPage > 1`). Only page
	// >= 2 queries it, so the common case costs nothing extra.
	var pinnedPost map[string]any
	if page > 1 && topic.GetBool("first_post_pinned") {
		pinnedPost = loadTopicFirstPost(e.App, topicID, AccessFrom(e))
	}

	resp := map[string]any{
		"items":       items,
		"topic_id":    topicID,
		"posts_count": topic.GetInt("posts_count"),
		"page":        page,
		"per_page":    limit,
		"request_id":  requestIDFrom(e),
	}
	// `pinned_post` is ADDED ONLY when there is one, rather than set to null.
	//
	// This matters because TopicPage destructures it: `const { posts, pinnedPost,
	// lastPost } = await fetchSecuredPosts(...)` and then
	// `topic.first_post_pinned && currentPage > 1 && pinnedFirstPost`. A JSON
	// `null` arrives as a present-but-null value, which is a third state nobody
	// branches on. Emitting the key only when it carries a post keeps the
	// contract "absent means no pinned post" true on the wire, not just in Go.
	if pinnedPost != nil {
		resp["pinned_post"] = pinnedPost
	}
	// Echoed only in the goLast modes: the instant the resolved page was
	// computed against. The client uses it to aim the scroll at the first
	// unread post without consulting any browser-localStorage read map.
	if resolution.readCutoff != "" {
		resp["read_cutoff"] = resolution.readCutoff
	}
	if resolution.targetPostID != "" {
		resp["target_post_id"] = resolution.targetPostID
	}
	if resolution.targetFound != nil {
		resp["target_found"] = *resolution.targetFound
	}
	if resolution.movedToTopicID != "" {
		resp["moved_to_topic_id"] = resolution.movedToTopicID
	}
	return e.JSON(http.StatusOK, resp)
}

type listPageResolution struct {
	page           int
	readCutoff     string
	targetPostID   string
	targetFound    *bool
	movedToTopicID string
}

// resolveListPage turns the `page` or `post` query parameter into a page number and
// reports the read cutoff or target post resolution details.
//
// MODES:
//  1. Target post (?post=<id> or ?post_id=<id>): locates the page holding that post
//     using an optimized SQL COUNT of preceding posts in the topic. Echoes target_post_id
//     and target_found (plus moved_to_topic_id if the post was re-filed elsewhere).
//  2. goLast contract (?page=last|latest|unread): resolves the page holding the FIRST
//     unread post against topic_read_states (or last_visit fallback), or the last page.
//  3. Numeric page (?page=N): standard 1-based page number.
func resolveListPage(e *core.RequestEvent, topicID string, limit int) listPageResolution {
	targetPostID := strings.TrimSpace(e.Request.URL.Query().Get("post"))
	if targetPostID == "" {
		targetPostID = strings.TrimSpace(e.Request.URL.Query().Get("post_id"))
	}

	if targetPostID != "" {
		targetFoundFalse := false
		targetFoundTrue := true
		fallbackPage := parseIntParam(e.Request.URL.Query().Get("page"), 1)
		if fallbackPage < 1 {
			fallbackPage = 1
		}

		post, err := e.App.FindRecordById(postsCollectionName, targetPostID)
		if err != nil || post == nil {
			return listPageResolution{
				page:         fallbackPage,
				targetPostID: targetPostID,
				targetFound:  &targetFoundFalse,
			}
		}

		postTopicID := post.GetString("topic_id")
		if postTopicID != topicID {
			return listPageResolution{
				page:           fallbackPage,
				targetPostID:   targetPostID,
				targetFound:    &targetFoundFalse,
				movedToTopicID: postTopicID,
			}
		}

		// Drafts are private to their author and cannot be publicly located.
		if post.GetBool("is_draft") {
			return listPageResolution{
				page:         fallbackPage,
				targetPostID: targetPostID,
				targetFound:  &targetFoundFalse,
			}
		}

		// Count how many published posts precede or equal this post in the canonical order (created ASC, id ASC).
		targetCreated := post.GetString("created")
		draftVisible := dbx.NewExp("is_draft = false OR is_draft IS NULL")
		countBefore, err := e.App.CountRecords(postsCollectionName,
			dbx.HashExp{"topic_id": topicID},
			draftVisible,
			dbx.NewExp("(created < {:cut}) OR (created = {:cut} AND id <= {:pid})",
				dbx.Params{"cut": targetCreated, "pid": post.Id}))
		if err != nil || countBefore < 1 {
			countBefore = 1
		}

		resolved := int((countBefore-1)/int64(limit)) + 1
		if resolved < 1 {
			resolved = 1
		}

		return listPageResolution{
			page:         resolved,
			targetPostID: targetPostID,
			targetFound:  &targetFoundTrue,
		}
	}

	pageRaw := strings.TrimSpace(e.Request.URL.Query().Get("page"))
	switch pageRaw {
	case "last", "latest", "unread":
	default:
		p := parseIntParam(pageRaw, 1)
		if p < 1 {
			p = 1
		}
		return listPageResolution{page: p}
	}

	draftVisible := dbx.NewExp("is_draft = false OR is_draft IS NULL")
	total, err := e.App.CountRecords(postsCollectionName,
		dbx.HashExp{"topic_id": topicID},
		draftVisible)
	if err != nil {
		return listPageResolution{page: 1}
	}
	resolved := int((total + int64(limit) - 1) / int64(limit))
	if resolved < 1 {
		resolved = 1
	}

	// Server-side read state first (ADR-12); the query param is the fallback.
	// Read cursor is (created, id): find the first post AFTER the reader's
	// cursor, then compute its page.
	var cutoffCreated, cutoffPostID string
	cutoffEcho := ""
	if e.Auth != nil {
		state, err := e.App.FindFirstRecordByFilter(topicReadStatesCollectionName,
			"user_id = {:user} && topic_id = {:topic}",
			dbx.Params{"user": e.Auth.Id, "topic": topicID},
		)
		if err == nil && state != nil {
			cutoffCreated = state.GetString("last_read_created")
			cutoffPostID = state.GetString("last_read_post_id")
			// Backfill: old rows only have last_read_at (timestamp lower bound).
			if cutoffCreated == "" {
				if dt, perr := types.ParseDateTime(state.GetString("last_read_at")); perr == nil && !dt.IsZero() {
					cutoffCreated = dt.String()
				}
			}
			if cutoffCreated != "" {
				cutoffEcho = cutoffCreated
			}
		}
	}
	if cutoffEcho == "" {
		if paramCut, ok := parseVisitCutoff(e.Request.URL.Query().Get("last_visit")); ok {
			cutoffCreated = paramCut.UTC().Format("2006-01-02 15:04:05.000Z")
			cutoffEcho = cutoffCreated
		}
	}
	if cutoffEcho == "" {
		return listPageResolution{page: resolved}
	}

	// Count posts at or before the read cursor: created < cut
	// OR (created = cut AND id <= pid). The legacy fallback (no post id, only a
	// timestamp bound) treats every post in that instant as read.
	countBefore, err := e.App.CountRecords(postsCollectionName,
		dbx.HashExp{"topic_id": topicID},
		draftVisible,
		dbx.NewExp("(created < {:cut}) OR (created = {:cut} AND ({:pid} = '' OR id <= {:pid}))",
			dbx.Params{"cut": cutoffCreated, "pid": cutoffPostID}))
	if err != nil {
		return listPageResolution{page: resolved, readCutoff: cutoffEcho}
	}
	if countBefore < total {
		// Zero-based index of the first unread post is `countBefore`; its page
		// is that index divided by the page size, plus one.
		resolved = int(countBefore/int64(limit)) + 1
	}
	return listPageResolution{page: resolved, readCutoff: cutoffEcho}
}

// parseVisitCutoff accepts the client's last-visit instant as unix milliseconds
// or as any date string PocketBase can parse, and reports whether a cutoff
// should be applied at all.
func parseVisitCutoff(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if ms, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return time.UnixMilli(ms), true
	}
	if dt, err := types.ParseDateTime(raw); err == nil && !dt.IsZero() {
		return dt.Time(), true
	}
	return time.Time{}, false
}

// loadTopicFirstPost returns the topic's earliest post, or nil.
//
// "The pinned post" is a RULE, not a per-post flag (migration 1768000000): the
// flag lives on the topic and this picks the post it refers to. `created ASC`
// with `id ASC` as the tie-breaker mirrors the list ordering exactly, so two
// posts written in the same millisecond cannot make the banner jump between
// page loads.
//
// Drafts are excluded for the same reason listPostsHandler excludes them: a
// draft is private to its author and must never surface in the public feed.
//
// The predicate is built with dbx rather than a FindRecordsByFilter string on
// purpose. The string form would need `is_draft = false || is_draft IS NULL`,
// which mixes the PocketBase filter language with raw SQL in one expression;
// PocketBase has no `IS NULL` in that language, so the filter matches nothing
// and the banner silently never appears. dbx emits plain SQL and says exactly
// what it means — `IS NULL` included, which is the case that actually occurs
// for every post written before the draft column existed.
//
// `acc` is the READER, and it is threaded in rather than left to a default
// because the pinned post is served on the same public route as the page: a
// master throw in the opening message would otherwise be one banner away from
// reaching a guest unredacted.
func loadTopicFirstPost(app core.App, topicID string, acc AccessContext) map[string]any {
	var records []*core.Record
	err := app.RecordQuery(postsCollectionName).
		AndWhere(dbx.NewExp("topic_id = {:topic}", dbx.Params{"topic": topicID})).
		AndWhere(dbx.NewExp("(is_draft = {:no} OR is_draft IS NULL)", dbx.Params{"no": false})).
		OrderBy("created ASC", "id ASC").
		Limit(1).
		All(&records)
	if err != nil || len(records) == 0 {
		return nil
	}
	payload := postPayload(records[0])
	decoratePostAuthors(app, []map[string]any{payload})
	redactPostRolls([]map[string]any{payload}, acc)
	return payload
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
	payload := postPayload(record)
	// This is a PUBLIC deep-link route, so the single-post answer redacts too:
	// a permalink to a post with a master throw must not be the way around it.
	redactPostRolls([]map[string]any{payload}, AccessFrom(e))
	return e.JSON(http.StatusOK, map[string]any{
		"post":       payload,
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
	if err := requireNotBanned(acc, "edit a post"); err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil {
			return 0, nil, notFoundError("post not found")
		}

		isAuthor := e.Auth != nil && post.GetString("author_id") == e.Auth.Id
		// Split permission, not an umbrella: editing and deleting a stranger's
		// post are separately assignable, so a role can be given one without
		// the other.
		//
		// THE AUTHOR'S OWN KEY IS NOW ENFORCED, and that is the change. This used
		// to read `isAuthor || Has(edit_others_posts)` — authorship alone was
		// sufficient, which made `edit_self_post` and `delete_self_post` dead
		// strings: granted by the matrix, backfilled by migration, offered in the
		// admin panel, and read by nothing. A role could not be denied the right
		// to edit its own posts, because no check consulted the key.
		//
		// Both arms now consult a permission. `_others_` never substitutes for
		// the author comparison — it widens WHO may act on a row that is not
		// yours — and `_self_` is the separate grant for your own row.
		canEditOthers := !isAuthor && auth.Has(acc.Permissions, auth.PermEditOthersPosts)
		canEdit := canEditOthers ||
			(isAuthor && auth.Has(acc.Permissions, auth.PermEditSelfPost))
		// A moderator editing a stranger's post is staff activity and is
		// audited; the author editing their own post is not.
		isModerated := canEditOthers

		if !canEdit {
			return 0, nil, forbiddenError("you cannot edit this post")
		}

		topic, err := txApp.FindRecordById(topicsCollectionName, post.GetString("topic_id"))
		// As above: a deleted topic is a missing row, so the flag test is gone.
		if err != nil || topic == nil {
			return 0, nil, notFoundError("parent topic not found")
		}

		if topic.GetBool("locked") && !auth.Has(acc.Permissions, auth.PermCloseTopics) {
			return 0, nil, conflictError("topic is locked")
		}

		post.Set("content", content)
		post.Set("edited", types.NowDateTime())

		// Rolls are re-validated against the NEW body whenever the request
		// carries them, so an edit cannot leave a stored throw pointing at a tag
		// that is no longer there. An absent key means "the dice were not part of
		// this edit" and the stored results are left exactly as they were —
		// which is the common case, since the edit form only re-rolls when the
		// author typed a fresh `[dice=…]`.
		if form.Rolls != nil {
			if err := writeRolls(post, content, *form.Rolls); err != nil {
				return 0, nil, validationError(err.Error())
			}
		}
		if isModerated {
			post.Set("editor_id", e.Auth.Id)
		}

		// A mask change is the AUTHOR's decision, and only when the request
		// actually carries one. `edit_others_posts` widens who may rewrite the
		// text; it must never let a moderator re-file somebody else's post under
		// a mask, so the branch is gated on isAuthor rather than on canEdit.
		if form.CharacterID != nil && isAuthor {
			// Same server-owned resolution as create: the client names a mask and
			// the server answers with the one it accepts (403 on a borrowed one).
			//
			// An EXPLICIT empty string means "post as my account", not "whatever is
			// stored": resolveAuthorCharacter treats empty as "fall back to
			// last_selected_character_id", which is right for a fresh reply (the
			// composer clears that key when the author picks their own account) but
			// wrong here, because the edit form never touches the profile. Reading
			// the stored mask back would silently ignore the author's own choice.
			var characterID string
			if strings.TrimSpace(*form.CharacterID) == "" {
				characterID = ""
			} else {
				resolved, err := resolveAuthorCharacter(txApp, e.Auth.Id, *form.CharacterID)
				if err != nil {
					return 0, nil, err
				}
				characterID = resolved
			}
			post.Set("author_character_id", characterID)

			// The post may also be the topic's last post, and that row is
			// denormalised. Leaving it stale is what makes a topic list disagree
			// with the topic page about who spoke last. The mask is copied from
			// the edited post row through the single writer, so the kind and
			// the legacy copies stay consistent with the new mask.
			if topic.GetString("last_post_id") == postID {
				setLastPostProjection(topic, post)
				if err := txApp.Save(topic); err != nil {
					return 0, nil, internalError("failed to update topic projection", err)
				}
			}
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to update post", err)
		}

		if isModerated {
			if err := recordAuditLog(txApp, "post_edit", e.Auth.Id, map[string]any{
				"post_id":   postID,
				"topic_id":  topic.Id,
				"author_id": post.GetString("author_id"),
				// A guest post's author_id is empty BY DESIGN; the kind and the
				// display name are what keep a moderated guest edit attributable.
				"author_kind":        post.GetString(authorKindField),
				"guest_display_name": post.GetString(guestDisplayNameField),
			}); err != nil {
				return 0, nil, err
			}
		}

		// Decorated for the same reason publishDraftHandler's is: TopicPage renders
		// the edited card from this answer, and a raw payload has no
		// author_name/is_character, so a mask change would appear to do nothing
		// until a reload.
		postOut := postPayload(post)
		decoratePostAuthors(txApp, []map[string]any{postOut})
		// The edited card is rendered straight from this answer, so the rolls it
		// carries are the ones the page will show — and they go through the same
		// redaction as the list route.
		redactPostRolls([]map[string]any{postOut}, acc)

		return http.StatusOK, map[string]any{
			"post":       postOut,
			"post_id":    post.Id,
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
	if err := requireNotBanned(acc, "delete a post"); err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil {
			return 0, nil, notFoundError("post not found")
		}

		isAuthor := e.Auth != nil && post.GetString("author_id") == e.Auth.Id
		// Same split as editing, and the same asymmetry kept on purpose: the
		// right to delete a stranger's post does not imply the right to edit it.
		//
		// `delete_self_post` is enforced here for the first time — authorship
		// alone used to be enough, so the key was decorative.
		byModeration := !isAuthor && auth.Has(acc.Permissions, auth.PermDeleteOthersPosts)
		byAuthorship := isAuthor && auth.Has(acc.Permissions, auth.PermDeleteSelfPost)

		if !byModeration && !byAuthorship {
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
		// The author's ACCOUNT counters move only for an account author. A
		// guest has no users row, and the ADR makes the account-level no-op a
		// decision by author — author_id != "" marks an account post (including
		// legacy rows whose author_kind variant column has not been backfilled
		// yet); author_id == "" marks a guest post.
		isAccountAuthor := post.GetString("author_id") != ""

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
		//
		// A guest post's votes still die with the post (post-level reputation has
		// no account to pay back to), which is the owner ruling: post-level
		// reputation exists, account-level aggregation for guests does not.
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
		if voteSum.Total != 0 && isAccountAuthor {
			if err := adjustUserReputation(txApp, authorID, -voteSum.Total); err != nil {
				return 0, nil, err
			}
		}

		// The post's AUTHOR loses a post, not the caller: a moderator deleting
		// someone else's post must not move their own counter. The row is about
		// to stop existing, so the count drops by exactly one.
		if isAccountAuthor {
			if err := adjustUserPostCount(txApp, authorID, -1); err != nil {
				return 0, nil, err
			}
		}

		// The audit row goes in the same transaction and carries the TEXT. The
		// post is about to become unrecoverable, so this is the last place its
		// content can live — the owner asked for exactly that: the admin log is
		// the surviving record of what was said.
		//
		// EVERY delete is logged, not only staff ones. The previous guard
		// (`if !isAuthor`) meant an ordinary player deleting their own post left
		// no trace at all, which is precisely the traffic worth watching.
		//
		// The stored AuthorRef rides along: a guest post's author_id is empty BY
		// DESIGN, so an audit entry keyed on it alone would record "nobody wrote
		// this" — the kind and the display name are what make a moderation act
		// on guest content attributable after the row is gone.
		if err := recordAuditLog(txApp, "post_delete", e.Auth.Id, map[string]any{
			"post_id":            post.Id,
			"topic_id":           topic.Id,
			"topic_title":        topic.GetString("title"),
			"author_id":          authorID,
			"author_kind":        post.GetString(authorKindField),
			"guest_display_name": post.GetString(guestDisplayNameField),
			"created":            post.GetDateTime("created").String(),
			"by_author":          isAuthor,
			"content":            post.GetString("content"),
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
		// the counter and the feed can no longer disagree. The single rebuild
		// recomputes posts_count AND the full last-post AuthorRef — a failed
		// rebuild fails the whole delete, because a deleted post with the old
		// projection still pointing at it is corruption, not a partial success.
		if err := rebuildTopicProjection(txApp, topic); err != nil {
			return 0, nil, internalError("failed to rebuild topic projection after post deletion", err)
		}

		// Nudge every open reader of the topic. A hard delete changes the page
		// (post gone, counters moved) and — unlike create and move — nothing
		// else would wake the connected readers: their stats poll is SUSPENDED
		// while the signal stream is healthy, so without this nudge a deletion
		// stayed invisible until the stream dropped. Same transaction as the
		// rebuild, same guest-baseline audience decision as create/move.
		publishTopicSignal(txApp, topic)

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

		// Recalculate projections for both source and target through the single
		// rebuild: posts_count AND the full last-post AuthorRef. A failed
		// rebuild fails the whole move — a moved post with the old projection
		// still pointing at it is corruption, not a partial success.
		// The OPENER is re-filed first: moving the opening post does NOT delete
		// the topic (owner ruling 2026-11-01) — the next earliest post becomes
		// the opener, and a stale opener naming the author of a moved-away post
		// is the same corruption class as a stale last-post projection.
		// refileTopicOpener is idempotent, so a move that never touched the
		// opening post rewrites identical values.
		if err := refileTopicOpener(txApp, sourceTopic); err != nil {
			return 0, nil, internalError("failed to re-file source topic opener", err)
		}
		if err := refileTopicOpener(txApp, targetTopic); err != nil {
			return 0, nil, internalError("failed to re-file target topic opener", err)
		}
		if err := rebuildTopicProjection(txApp, sourceTopic); err != nil {
			return 0, nil, internalError("failed to rebuild source topic projection", err)
		}
		if err := rebuildTopicProjection(txApp, targetTopic); err != nil {
			return 0, nil, internalError("failed to rebuild target topic projection", err)
		}

		if err := recordAuditLog(txApp, "posts_move", e.Auth.Id, map[string]any{
			"source_topic_id": sourceTopic.Id,
			"target_topic_id": targetTopic.Id,
			"post_ids":        form.PostIDs,
		}); err != nil {
			return 0, nil, err
		}

		// Nudge every open reader of BOTH topics: a moved post changes the
		// page (post gone / post arrived) AND — since the opener re-file —
		// possibly the topic's opener author. Without this a connected
		// reader waited out the 15s poll; a poll-only reader still gets the
		// same facts one interval later.
		publishTopicSignal(txApp, sourceTopic)
		publishTopicSignal(txApp, targetTopic)

		return http.StatusOK, map[string]any{
			"moved_count": len(form.PostIDs),
			"source_id":   sourceTopic.Id,
			"target_id":   targetTopic.Id,
			"request_id":  requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}
