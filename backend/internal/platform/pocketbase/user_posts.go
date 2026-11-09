package pocketbase

// GET /api/aerun/users/{id}/posts — the profile's Posts tab.
//
// This route exists because the tab used to read `posts` through the browser
// SDK: `pb.collection('posts').getList(page, n, { filter: 'author_id = "…"' })`.
// Migration 1766100000 locked every forum collection to superusers
// (lockBrowserRules), so that call answered 403 "Only superusers can perform
// this action" for every ordinary member and every guest — the tab rendered
// empty and the error was swallowed into an empty result by the catch in
// fetchUserPosts, so it looked like "this person has written nothing".
//
// The posts are read through the command layer like every other forum read, and
// they carry the SAME shape listPostsHandler serves: the decorated author
// projection and, since 1768200000, the dice rolls. A profile preview renders
// post bodies through BBCode, so a throw shown in a topic must resolve here too
// — otherwise the roll map is present in one reader and missing in the other.
//
// Visibility follows canReadCharactersOf: an account that exists is readable
// regardless of status. A ban limits what the account may DO; it does not
// unpublish what it wrote, and the admin screen depends on being able to read
// it.
//
// Drafts are excluded for the same reason they are excluded from the topic feed:
// a draft is private to its author until it is published.

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

// collectPostTopicIDs gathers the topic ids across a page of post payloads.
func collectPostTopicIDs(payloads []map[string]any) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if id, _ := payload["topic_id"].(string); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// loadTopicTitles resolves topic id -> title for every id given, in ONE query.
//
// A page of posts is usually a handful of topics (a member replying in one
// thread), so the deduplication below turns twenty rows into one lookup, which
// is why this is cheaper than storing the title on every post.
//
// A missing topic is simply ABSENT from the map rather than mapped to an empty
// string: the caller can then leave `topic_title` off the payload entirely
// instead of sending a key whose value is a blank the UI would have to
// distinguish from a real title.
//
// A failed lookup degrades the headline, it does not fail the read — the same
// rule loadAuthorDisplays follows.
func loadTopicTitles(app core.App, topicIDs []string) map[string]string {
	return loadReadableTopicTitles(app, topicIDs, nil)
}

// loadReadableTopicTitles is loadTopicTitles, additionally restricted to the
// given categories. A nil allowedCategoryIDs disables the restriction, so the
// plain lookup stays available to callers that have already established the
// right to see the topics; an empty non-nil list matches nothing.
func loadReadableTopicTitles(app core.App, topicIDs []string, allowedCategoryIDs []string) map[string]string {
	out := make(map[string]string, len(topicIDs))

	ids := make([]string, 0, len(topicIDs))
	seen := make(map[string]bool, len(topicIDs))
	for _, id := range topicIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return out
	}
	if allowedCategoryIDs != nil && len(allowedCategoryIDs) == 0 {
		return out
	}

	var records []*core.Record
	// dbx.In takes []any: a []string is a compile error rather than a silent
	// empty IN (), which would make every lookup "find nothing".
	inArgs := make([]any, len(ids))
	for i, id := range ids {
		inArgs[i] = id
	}
	query := app.RecordQuery(topicsCollectionName).
		AndWhere(dbx.In("id", inArgs...))
	if allowedCategoryIDs != nil {
		catArgs := make([]any, len(allowedCategoryIDs))
		for i, id := range allowedCategoryIDs {
			catArgs[i] = id
		}
		query = query.AndWhere(dbx.In("category_id", catArgs...))
	}
	if err := query.
		Limit(int64(len(ids))).
		All(&records); err != nil {
		return out
	}

	for _, rec := range records {
		out[rec.Id] = rec.GetString("title")
	}
	return out
}

// userPostFilter is the parsed form of the `filter` parameter on this endpoint.
//
// The dropdown offers three axes — everything, the account itself, and one mask
// — and the client used to send the chosen one as a parameter that fetchUserPosts
// dropped on the floor (`_postFilter`), so picking a mask relabelled an
// identical list.
//
// The filter has to be applied HERE rather than in the browser, for the same
// reason the topic title is resolved here: this endpoint is PAGINATED. Filtering
// the rows a client already received cannot renumber the pages, so page 2 of
// "Rough only" would still be page 2 of everything, and `total` would keep
// counting every post the account ever wrote — which is the number the pager
// divides by.
type userPostFilter struct {
	// account restricts the read to posts written without a mask.
	account bool
	// characterID restricts the read to posts written under that one mask.
	characterID string
}

// parseUserPostFilter validates the raw `filter` parameter.
//
// An unrecognised value is a 400 rather than a silent "everything": a filter
// that quietly ignores what it was asked to do is how this endpoint already
// failed once, with the answer looking identical to a working one.
func parseUserPostFilter(raw string) (userPostFilter, error) {
	raw = strings.TrimSpace(raw)
	switch {
	case raw == "" || raw == "all":
		return userPostFilter{}, nil
	case raw == "account":
		return userPostFilter{account: true}, nil
	case strings.HasPrefix(raw, "char_"):
		id := strings.TrimSpace(strings.TrimPrefix(raw, "char_"))
		// isValidDerivedID is this package's record-id shape check (exactly 15
		// characters of [a-z0-9]). Rejecting anything else keeps a malformed
		// value from reaching the query at all.
		if !isValidDerivedID(id) {
			return userPostFilter{}, validationError("character filter must name a character id")
		}
		return userPostFilter{characterID: id}, nil
	default:
		return userPostFilter{}, validationError("unknown post filter")
	}
}

// expr renders the filter as SQL, or nil when nothing is being filtered.
//
// Ownership is deliberately NOT checked here, and needs no check: the read is
// already scoped to `author_id`, and author_character_id only ever holds a mask
// the author owns, because resolveAuthorCharacter refuses to store anybody
// else's at write time. Naming another member's mask therefore matches nothing
// on this profile — an empty list, which discloses less than a 404 would, and
// cannot be turned into a probe for whether that mask exists.
func (f userPostFilter) expr() dbx.Expression {
	switch {
	case f.characterID != "":
		return dbx.HashExp{"author_character_id": f.characterID}
	case f.account:
		// An unmasked post stores the empty string (resolveAuthorCharacter
		// returns "" rather than null), but rows imported from Firestore can
		// carry a real NULL, so both spellings are excluded here — the same
		// reason is_draft is matched twice below.
		return dbx.NewExp("(author_character_id = '' OR author_character_id IS NULL)")
	default:
		return nil
	}
}

// listUserPostsHandler serves GET /api/aerun/users/{id}/posts.
func listUserPostsHandler(e *core.RequestEvent) error {
	authorID := strings.TrimSpace(e.Request.PathValue("id"))
	if authorID == "" {
		return validationError("user identifier is required")
	}

	// Same gate as the Characters tab: an unknown account is a 404, and a
	// known one is readable whatever its status.
	owner, err := e.App.FindRecordById(usersCollectionName, authorID)
	if err != nil || owner == nil {
		return notFoundError("user not found")
	}

	settings := loadForumSettings(e.App)
	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), settings.PostsPerPage), settings.PostsPerPage)
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}

	filter, err := parseUserPostFilter(e.Request.URL.Query().Get("filter"))
	if err != nil {
		return err
	}

	// The caller's readable categories, resolved through the same predicate the
	// topic feed uses (SEC-01 / BOLA). Without this the profile's Posts tab
	// handed a signed-out visitor every public post the account ever wrote —
	// including posts in categories they may not view, plus the title of the
	// private topic each one sits in. Visibility is resolved in Go and passed
	// as bound ids: allowed_roles is a JSON list with an inherit marker, so it
	// cannot be re-expressed as SQL without a second copy of the rule.
	allowedCategoryIDs, err := resolveAllowedCategoryIDs(e.App, AccessFrom(e))
	if err != nil {
		return internalError("failed to resolve readable categories", err)
	}
	if len(allowedCategoryIDs) == 0 {
		return e.JSON(http.StatusOK, map[string]any{
			"items":       []map[string]any{},
			"author_id":   authorID,
			"total":       int64(0),
			"page":        page,
			"per_page":    limit,
			"total_pages": int64(0),
			"request_id":  requestIDFrom(e),
		})
	}

	// The WHERE clause is built ONCE and handed to both the page query and the
	// count. Re-deriving it in two places is how a filtered read ends up
	// paginating against an unfiltered total.
	//
	// The category restriction is expressed as a topic-id subquery over the
	// BOUND id list, not by interpolating ids into the string. dbx only
	// expands a slice into `IN (...)` inside a HashExp, so a []string bound
	// into raw SQL reaches SQLite as one quoted token and 500s (the same
	// lesson unreadTopicsPredicate documents); inlining the ids would keep the
	// query working but make every category id a SQL injection point.
	//
	// The placeholders are named per id (cat0, cat1, …) rather than bound as
	// one slice param: PocketBase's dbx does NOT expand a slice bound inside
	// a raw NewExp — it interpolates the slice's Go-syntax text into the
	// statement, which SQLite rejects with "unrecognized token". The same
	// construction unreadTopicsPredicate uses for its category list.
	//
	// `params` also reaches the `(is_draft = {:no} …)` expression, which is why
	// the keys live on one map rather than on the subquery: dbx merges the
	// params of every expression in the chain, and an unbound placeholder
	// would fail the query before SQLite ever saw it.
	placeholders := make([]string, 0, len(allowedCategoryIDs))
	params := dbx.Params{"no": false}
	for i, id := range allowedCategoryIDs {
		key := "cat" + strconv.Itoa(i)
		placeholders = append(placeholders, "{:"+key+"}")
		params[key] = id
	}
	scope := []dbx.Expression{
		dbx.HashExp{"author_id": authorID},
		dbx.NewExp("(is_draft = {:no} OR is_draft IS NULL)", params),
		dbx.NewExp(
			"topic_id IN (SELECT id FROM " + topicsCollectionName + " WHERE category_id IN (" + strings.Join(placeholders, ", ") + "))",
		),
	}
	if filterExpr := filter.expr(); filterExpr != nil {
		scope = append(scope, filterExpr)
	}

	query := e.App.RecordQuery(postsCollectionName)
	for _, cond := range scope {
		query = query.AndWhere(cond)
	}
	query = query.
		// Newest first, unlike the topic feed: a profile is a reverse
		// chronological list of what somebody wrote, which is what the
		// `-created` sort in the retired client call asked for.
		OrderBy("created DESC", "id ASC").
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
	// Same per-reader redaction the topic feed applies — a master throw must not
	// be readable through a profile just because it sits behind a different URL.
	redactPostRolls(items, AccessFrom(e))

	// THE TOPIC TITLE, which the card links to.
	//
	// ProfilePage renders `post.topic_title` as the headline of every row and
	// falls back to the literal "..." when it is absent — so without this the
	// whole Posts tab reads as a list of ellipses while the link itself still
	// works (it uses topic_id). The Firestore era denormalised the title onto
	// every post document; this is the same trade, resolved in the read model
	// instead of at write time, so a renamed topic can never leave stale
	// headlines behind on every reply.
	//
	// One lookup per page, not per post: the page is already bounded by
	// posts_per_page, and a profile can span 5000 posts across pages. The
	// lookup is scoped to the categories the caller may view, holding the same
	// line as the post query above: a private topic's title must not reach a
	// reader the post itself was withheld from.
	titles := loadReadableTopicTitles(e.App, collectPostTopicIDs(items), allowedCategoryIDs)
	for _, item := range items {
		if title, ok := titles[item["topic_id"].(string)]; ok && title != "" {
			item["topic_title"] = title
		}
	}

	// THE SAME SCOPE, so the pager agrees with the rows. Counting every post the
	// account ever wrote would make "Rough only" offer a page 3 that 404s into
	// an empty list, and a one-mask profile would show a pager over a single row.
	total, err := e.App.CountRecords(postsCollectionName, scope...)
	if err != nil {
		return internalError("failed to count posts", err)
	}

	// CountRecords answers int64 and ClampLimit answers int, so the page count
	// is computed in int64 rather than converting the total down and back.
	perPage := int64(limit)
	totalPages := int64(0)
	if total > 0 {
		totalPages = (total + perPage - 1) / perPage
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"author_id":   authorID,
		"total":       total,
		"page":        page,
		"per_page":    limit,
		"total_pages": totalPages,
		"request_id":  requestIDFrom(e),
	})
}
