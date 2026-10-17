package pocketbase

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// canViewCategory checks whether the given AccessContext may view a category.
//
// ADR-1: `categories.allowed_roles` is the ONLY visibility input. An empty or
// absent list means root-only — deny by default. A public category names every
// role explicitly, guest included, and the importer/backfill writes exactly that
// list, so "public" is a stored fact rather than a fallback the reader infers.
// The previous "empty = public" default was the showstopper this replaced: with
// the importer writing allowed_roles, every restricted category would have
// silently become world-readable.
//
// ADR-2: membership is tested against users.role only. custom_role_id is NOT
// consulted — a category granted to `player` does not implicitly include a user
// on a custom role derived from `player`; the admin lists the custom role
// explicitly (which is also how the legacy export behaves).
//
// `root` is the only bypass (ADR-1 reversed the pre-audit rule that also let
// `admin` through), and a banned account is refused before the bypass is even
// considered: status outranks authority.
// ADR-3: the inherit marker. A category that stores
// auth.CategoryInheritMarker delegates to the
// caller's own `view_forum` permission instead of naming roles.
//
// This is what makes "follow the global role settings" a LIVE rule rather than
// a snapshot: a role created after the category was saved holds view_forum, so
// its members are allowed immediately, with no re-save. Naming the roles
// instead could only freeze the registry as of the last save.
//
// The consult is still `acc.Role`, never `custom_role_id` (ADR-2 unchanged):
// `acc.Permissions` is derived from users.role and narrowed by status, so a
// banned account is refused by the check above regardless, and a custom role is
// admitted or refused by its OWN id appearing in the registry.
//
// A marker mixed with real ids is ambiguous — inherit would swallow the
// explicit list — so it is treated as inherit and the explicit entries are
// ignored. validateAllowedRoles is what prevents that combination from being
// stored in the first place; this branch only has to stay total.
func canViewCategory(app core.App, acc AccessContext, categoryID string) (bool, error) {
	if categoryID == "" {
		return false, nil
	}
	if acc.Status == auth.StatusBanned {
		return false, nil
	}
	if acc.Role == auth.RoleRoot {
		return true, nil
	}

	category, err := app.FindRecordById(categoriesCollectionName, categoryID)
	if err != nil || category == nil {
		return false, err
	}

	allowedRoles := decodeRoleIDList(category.Get("allowed_roles"))
	if len(allowedRoles) == 0 {
		return false, nil
	}
	if slices.Contains(allowedRoles, auth.CategoryInheritMarker) {
		return auth.Has(acc.Permissions, auth.PermViewForum), nil
	}
	return slices.Contains(allowedRoles, string(acc.Role)), nil
}

// canViewTopic checks whether the given AccessContext has permission to view
// the topic (and its parent category).
func canViewTopic(app core.App, acc AccessContext, topicID string) (bool, *core.Record, error) {
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		return false, nil, err
	}

	allowed, err := canViewCategory(app, acc, topic.GetString("category_id"))
	if err != nil || !allowed {
		return false, topic, err
	}

	return true, topic, nil
}

// decodeRoleIDList normalises a JSON value that should be a list of role ids.
//
// PocketBase stores JSON fields as types.JSONRaw, but the same value can reach
// the command layer as a plain []string (what record.Set writes in tests and in
// the importer) or as string-encoded JSON (what an older row may hold), so all
// three shapes are accepted. Anything else — including an object, which is what
// the retired `permissions` map looked like — decodes to no roles, which every
// caller reads as "not granted" (deny by default, ADR-1).
func decodeRoleIDList(raw any) []string {
	switch value := raw.(type) {
	case nil:
		return nil
	case types.JSONRaw:
		if len(value) == 0 {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil
		}
		return decoded
	case string:
		if value == "" || value == "[]" {
			return nil
		}
		var decoded []string
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return nil
		}
		return decoded
	case []string:
		return value
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// categoryForumProjections computes the counters and last-post summary the
// forum index renders, per category.
//
// They are DERIVED, not stored. The Firestore schema kept topics_count,
// posts_count and the whole last_post_* family as columns on the category
// document and maintained them from triggers; this schema has no such columns
// (see the categories schema dump), and adding them back would reintroduce two
// independent copies of the same fact that disagree whenever a write path
// forgets one of them — which is exactly the class of bug the hard-delete
// migration removed.
//
// Three aggregate queries, not one per category: the index has to be correct
// for a member who just posted, and a per-category COUNT loop would both be
// slow and give the numbers a different age depending on iteration order.
//
// A category with no topics reports zero counters and NO last_post_* keys at
// all, rather than empty ones, so the index can tell "never had a post" from
// "has a post with a blank author".
func categoryForumProjections(app core.App) (map[string]map[string]any, error) {
	projections := make(map[string]map[string]any)

	type categoryCount struct {
		CategoryID string `db:"category_id"`
		Topics     int    `db:"topics"`
		Posts      int    `db:"posts"`
	}
	var counts []categoryCount
	// posts_count on the topic is the authority for a topic's size (it is
	// rebuilt by RecomputeUserCounters' sibling pass and by the delete handler),
	// so summing it is both cheaper and more consistent than counting posts
	// again here.
	if err := app.DB().NewQuery(
		"SELECT category_id, COUNT(*) AS topics, COALESCE(SUM(posts_count), 0) AS posts " +
			"FROM " + topicsCollectionName + " GROUP BY category_id",
	).All(&counts); err != nil {
		return nil, err
	}
	for _, row := range counts {
		projections[row.CategoryID] = map[string]any{
			"topics_count": row.Topics,
			"posts_count":  row.Posts,
		}
	}

	// The most recently active topic per category. ROW_NUMBER keeps exactly one
	// row per category even when two topics share a timestamp, which the
	// correlated MAX would have returned twice.
	//
	// last_post_author_character_id is part of this projection and not an
	// optional extra: it is what tells the decorator that the last replier spoke
	// under a MASK. The topic lists load whole topic records and therefore carry
	// it, so the category page rendered "Kyle Haze" while this projection — the
	// one behind the main page — named the ACCOUNT, because the column was never
	// read out of the database here.
	type latestTopic struct {
		CategoryID string `db:"category_id"`
		TopicID    string `db:"topic_id"`
		Title      string `db:"title"`
		Created    string `db:"last_post_created"`
		AuthorID   string `db:"last_post_author_id"`
		// May be NULL/empty, which is correct: the last post may have been
		// written as the account. The column is a text field, so a missing value
		// scans as "" rather than failing the row.
		CharacterID   string `db:"last_post_author_character_id"`
		PostsCount    int    `db:"posts_count"`
		GuestDisplayName string `db:"last_post_guest_display_name"`
	}
	var latest []latestTopic
	// The full query reads `last_post_author_character_id` (1768000000) and
	// `last_post_guest_display_name` (1770000002), both added after the topics table was
	// created. Against a database restored from an older snapshot those columns
	// may not exist yet; fall back to a simplified query that leaves them blank
	// rather than 500-ing the whole forum index.
	fullQuery :=
		"SELECT category_id, id AS topic_id, title, last_post_created, last_post_author_id, " +
			"COALESCE(last_post_author_character_id, '') AS last_post_author_character_id, " +
			"last_post_guest_display_name, COALESCE(posts_count, 0) FROM (" +
			"SELECT category_id, id, title, last_post_created, last_post_author_id, " +
			"last_post_author_character_id, posts_count, last_post_guest_display_name, " +
			"ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY last_post_created DESC, id DESC) AS rn " +
			"FROM " + topicsCollectionName + ") WHERE rn = 1"
	simpleQuery :=
		"SELECT category_id, id AS topic_id, title, last_post_created, last_post_author_id, " +
			"'' AS last_post_author_character_id, " +
			" AS last_post_guest_display_name, COALESCE(posts_count, 0) FROM (" +
			"SELECT category_id, id, title, last_post_created, last_post_author_id, " +
			" AS last_post_author_character_id, posts_count,  AS last_post_guest_display_name, " +
			"ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY last_post_created DESC, id DESC) AS rn " +
			"FROM " + topicsCollectionName + ") WHERE rn = 1"
	if err := app.DB().NewQuery(fullQuery).All(&latest); err != nil && isMissingColumnErr(err) {
		app.Logger().Warn("categoryForumProjections: optional columns missing, using fallback query", "error", err)
		if err := app.DB().NewQuery(simpleQuery).All(&latest); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	for _, row := range latest {
		projection, ok := projections[row.CategoryID]
		if !ok {
			projection = map[string]any{"topics_count": 0, "posts_count": 0}
			projections[row.CategoryID] = projection
		}
		projection["last_post_topic_id"] = row.TopicID
		projection["last_post_topic_title"] = row.Title
		projection["last_post_at"] = row.Created
		projection["last_post_author_id"] = row.AuthorID
		projection["last_post_author_character_id"] = row.CharacterID
		projection["last_post_guest_display_name"] = row.GuestDisplayName

		// Guest posts have empty author_id; keep the guest display name under its
		// own key. The frontend reads last_post_author_name as a fallback in
		// toCategory, so the backend does not need to rename the column.
		if row.AuthorID == "" && row.GuestDisplayName != "" {
			projection["last_post_author_name"] = row.GuestDisplayName
		}
	}

	// One lookup for every last-post author named above, and one for every mask
	// they posted under. The mask lookup is what makes this projection answer
	// "who spoke last" the same way the topic lists do; without it the main page
	// named the account where the category page named the mask.
	var authorPayloads []map[string]any
	for _, projection := range projections {
		authorPayloads = append(authorPayloads, projection)
	}
	if len(authorPayloads) > 0 {
		displays := loadAuthorDisplays(app, collectAuthorIDs(authorPayloads, "last_post_author_id"))
		masks := loadCharacterDisplays(app, collectCharacterIDs(authorPayloads, "last_post_author_character_id"))
		for _, payload := range authorPayloads {
			decorateLastPostAuthor(payload, displays, masks)
		}
	}

	return projections, nil
}

// isMissingColumnErr reports whether err is SQLite saying a column is not
// there. Needed because categoryForumProjections reads optional columns
// (last_post_author_character_id, guest_nickname) that may be absent on a
// database restored from an older snapshot.
func isMissingColumnErr(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "no such column") ||
		strings.Contains(msg, "has no column") ||
		strings.Contains(msg, "no field named")
}

// listForumStatsHandler answers GET /api/aerun/forum-stats.
//
// This exists because ForumStats.jsx reads `forumStats.totalTopics`,
// `totalPosts`, `totalUsers` and `newestUser`, and NOTHING on the server ever
// sent them: fetchSecuredMainPageData returned only categories. The component
// therefore fell through to `categories.reduce(...)`, which summed
// `topics_count` off objects that toCategory had just stripped of that key — so
// the forum index and the stats panel both showed 0 on a forum with content.
//
// EVERY NUMBER HERE IS COUNTED, NOT CACHED. The legacy build kept a
// `forum_stats/global` document maintained by Firestore triggers and mirrored
// it into RTDB; a cached total is a second copy of a fact that already has an
// authoritative source, and the two drift the moment one write path forgets it.
// COUNT(*) is exact and cheap enough for a panel that loads with the index.
//
// These are forum-WIDE totals, deliberately including categories the caller
// cannot see: they are public "this forum has N members" facts, the same ones
// the legacy `getSecuredMainPageData` read from the shared cache without
// filtering. The per-category counters on /categories remain visibility-filtered.
const (
	// dailyActiveWindow is the span the "Visited today" row reports over.
	//
	// It is a DAY, deliberately, and it is not the presence window. The panel
	// prints two different facts side by side — who is connected right now, and
	// who has been seen in the last day — and they were reading from the SAME
	// source: subscribeToDailyActiveUsers was a one-line alias of the online
	// subscription, so the second row restated the first with a different label
	// and the number silently changed meaning.
	dailyActiveWindow = 24 * time.Hour

	// dailyActiveUserLimit bounds how many names travel in the payload. The
	// COUNT below is exact and unbounded, so the headline number stays truthful
	// on a forum larger than the list the panel can render.
	dailyActiveUserLimit = 100
)

// dailyActiveMembers answers "who has been seen in the last day", from the
// durable users.last_seen column rather than from live presence.
//
// The distinction is the whole point of the row. The in-process presence map
// is a 75-second disposable view and is EMPTY after a restart, so it can never
// answer a question about a day; users.last_seen is the persistent visit clock
// that migration 1767300000 exists to maintain, and it survives both the
// departure and the process. It is also written on explicit logout now, so a
// member who signs out still counts as having visited today.
//
// Status is NOT a filter here. A banned or unapproved account is still an
// account: it has a nickname, a post history and a last_seen clock, and the row
// answers "who has been seen in the last day", not "who is a member in good
// standing". Excluding them made the panel disagree with the members table,
// which lists every account.
//
// The predicate is the SAME for the count and for the names below, and both bind
// the SAME `cutoff`, computed once above. A second NowDateTime() could land on
// the far side of a tick between the two queries, and the headline count would
// then disagree with the names printed under it.
//
// String comparison on the date column is exact rather than a fallback:
// PocketBase stores every date column as the same fixed-width UTC layout
// (types.DefaultDateLayout), so the ordering of the stored text IS the
// ordering of the instants.
func dailyActiveMembers(app core.App, now time.Time) ([]map[string]any, int) {
	cutoff := now.Add(-dailyActiveWindow).UTC().Format(types.DefaultDateLayout)

	var count int64
	if err := app.DB().
		NewQuery("SELECT COUNT(*) FROM " + usersCollectionName +
			" WHERE last_seen >= {:cutoff}").
		Bind(dbx.Params{"cutoff": cutoff}).
		Row(&count); err != nil {
		app.Logger().Warn("daily active count unavailable", "error", err)
		return []map[string]any{}, 0
	}

	var records []*core.Record
	if err := app.RecordQuery(usersCollectionName).
		AndWhere(dbx.NewExp(
			"last_seen >= {:cutoff}",
			dbx.Params{"cutoff": cutoff},
		)).
		OrderBy("last_seen DESC", "id DESC").
		Limit(dailyActiveUserLimit).
		All(&records); err != nil {
		app.Logger().Warn("daily active list unavailable", "error", err)
		return []map[string]any{}, int(count)
	}

	users := make([]map[string]any, 0, len(records))
	for _, record := range records {
		users = append(users, map[string]any{
			"id":       record.Id,
			"nickname": record.GetString("nickname"),
			"role_id":  record.GetString("role"),
		})
	}
	return users, int(count)
}

func listForumStatsHandler(e *core.RequestEvent) error {
	topics, err := e.App.CountRecords(topicsCollectionName)
	if err != nil {
		return internalError("failed to count topics", err)
	}

	// Drafts are not posts. The legacy stats counted published messages only,
	// and counting a private draft would inflate the number and leak that
	// somebody has unpublished work.
	posts, err := e.App.CountRecords(postsCollectionName,
		dbx.NewExp("is_draft = false OR is_draft IS NULL"))
	if err != nil {
		return internalError("failed to count posts", err)
	}

	// Members counts EVERY account, whatever its status.
	//
	// A ban and an unapproved registration both describe what an account may DO,
	// not whether it exists. The account keeps its nickname, its post history and
	// its place in the members table, so the headline total that sits next to
	// "N topics / M posts" has to count them too — otherwise the panel quietly
	// reports a smaller forum than the one people are looking at, and the three
	// numbers stop describing the same place.
	//
	// Counted with an explicit query rather than CountRecords(..., exp): the naive
	// predicates are wrong in two different ways. `status != 'pending'` still counts
	// BANNED accounts while excluding unapproved ones, and SQL's three-valued logic
	// drops NULL rows from any `!=` comparison, so an account with no status set
	// would silently vanish. Counting every row avoids both.
	var users int64
	if err := e.App.DB().
		NewQuery("SELECT COUNT(*) FROM " + usersCollectionName).
		Row(&users); err != nil {
		return internalError("failed to count members", err)
	}

	// The newest member by registration. `created DESC, id DESC` mirrors the
	// ordering used everywhere else, so the panel and the members table cannot
	// disagree about who joined last. No status filter: a fresh registration is
	// the newest account precisely because it is pending, so filtering those out
	// would report whoever joined before it. A forum with no members reports null
	// rather than a placeholder object the page would try to link.
	var newest map[string]any
	var newestRecords []*core.Record
	if err := e.App.RecordQuery(usersCollectionName).
		OrderBy("created DESC", "id DESC").
		Limit(1).
		All(&newestRecords); err == nil && len(newestRecords) > 0 {
		newestRecord := newestRecords[0]
		newest = map[string]any{
			"id":       newestRecord.Id,
			"nickname": newestRecord.GetString("nickname"),
			"role_id":  newestRecord.GetString("role"),
		}
	}

	daily, dailyCount := dailyActiveMembers(e.App, time.Now())

	return e.JSON(http.StatusOK, map[string]any{
		"stats": map[string]any{
			// camelCase: these keys are the AuthProvider context shape
			// (forumStats.totalTopics etc.), not the retired snake_case cache.
			"totalTopics": int(topics),
			"totalPosts":  int(posts),
			"totalUsers":  int(users),
			"newestUser":  newest,
			// The names are capped for rendering; the count beside them is the
			// exact number of members seen in the window, so a forum with more
			// daily visitors than the cap still reports a true headline.
			"dailyActiveUsers":     daily,
			"dailyActiveUserCount": dailyCount,
		},
		"request_id": requestIDFrom(e),
	})
}

// listCategoriesHandler returns all categories that the caller is permitted to
// view.
//
// `allowed_roles` is NOT in this payload, and that is a deliberate cut rather
// than an oversight. Its only consumer is the admin board's role picker: every
// other reader renders a category by its name, counters and last post, and none
// of them has a use for "which role ids may see this".
//
// Sending it anyway told every member — including a signed-out guest — the exact
// access rule of every category in the board: which roles exist, which are
// admitted, and by omission which are restricted or root-only. That is the
// permission model of the whole forum handed to whoever asks, on a list endpoint
// that has nothing to do with editing. The board needs it to re-submit a category
// unchanged, so it moved to the admin route (GET /admin/categories), which is
// already gated on PermManageCategories — the caller has to be able to EDIT a
// category to learn how it is gated.
func listCategoriesHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return internalError("failed to query categories", err)
	}

	projections, err := categoryForumProjections(e.App)
	if err != nil {
		return internalError("failed to compute category counters", err)
	}

	items := make([]map[string]any, 0, len(cats))
	for _, c := range cats {
		allowed, err := canViewCategory(e.App, acc, c.Id)
		if err != nil || !allowed {
			continue
		}
		item := map[string]any{
			"id":          c.Id,
			"name":        labelFromRecord(c, "name_i18n", "name"),
			"slug":        c.GetString("slug"),
			"description": labelFromRecord(c, "description_i18n", "description"),
			"group_id":    c.GetString("group_id"),
			"sort_order":  c.GetInt("sort_order"),
			"permissions": decodePermissionsMap(c.Get("permissions")),
		}
		// Counters default to zero so a category that never held a topic still
		// renders "0" rather than a blank cell, while the last_post_* keys stay
		// absent — the index distinguishes them.
		for key, value := range projections[c.Id] {
			item[key] = value
		}
		if _, ok := item["topics_count"]; !ok {
			item["topics_count"] = 0
			item["posts_count"] = 0
		}
		items = append(items, item)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

// listForumIndexHandler serves the forum index as ONE payload.
//
// The index renders categories grouped by their group, so it needs both lists to
// paint anything at all — and it fetched them separately (GET /categories and
// GET /category-groups) on every mount. Two round trips for one screen, raced
// against each other, for data that cannot disagree: a category whose group_id
// names a group the other call has not returned yet is a category rendered in
// the wrong section or in none.
//
// Groups are NOT access-filtered, and deliberately so: they are the folder
// headings of the board, the same for everyone, and a group with no visible
// category inside it simply renders no rows. Filtering them would make the
// heading list depend on the caller, which is a different feature and not one
// this endpoint was asked to be.
func listForumIndexHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)

	// The caller's unread topic set, resolved from the SAME predicate the
	// new-replies feed and the badge counter use (unreadTopicIDs). Resolving it
	// once here is what lets a lit row on the index agree with the feed: a row
	// is unread iff its last-post topic is in this set, so the index can never
	// light more topics than the feed can show. A guest gets a nil set and is
	// handled by the e.Auth != nil guard below.
	var unreadSet map[string]bool
	if e.Auth != nil {
		ids, err := unreadTopicIDs(e)
		if err != nil {
			return internalError("failed to resolve unread topics", err)
		}
		unreadSet = make(map[string]bool, len(ids))
		for _, id := range ids {
			unreadSet[id] = true
		}
	}

	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return internalError("failed to query categories", err)
	}

	projections, err := categoryForumProjections(e.App)
	if err != nil {
		return internalError("failed to compute category counters", err)
	}

	items := make([]map[string]any, 0, len(cats))
	for _, c := range cats {
		allowed, err := canViewCategory(e.App, acc, c.Id)
		if err != nil || !allowed {
			continue
		}
		item := map[string]any{
			"id":          c.Id,
			"name":        labelFromRecord(c, "name_i18n", "name"),
			"slug":        c.GetString("slug"),
			"description": labelFromRecord(c, "description_i18n", "description"),
			"group_id":    c.GetString("group_id"),
			"sort_order":  c.GetInt("sort_order"),
			"permissions": decodePermissionsMap(c.Get("permissions")),
		}
		// Counters default to zero so a category that never held a topic still
		// renders "0" rather than a blank cell, while the last_post_* keys stay
		// absent — the index distinguishes them.
		for key, value := range projections[c.Id] {
			item[key] = value
		}
		if _, ok := item["topics_count"]; !ok {
			item["topics_count"] = 0
			item["posts_count"] = 0
		}
		// Authoritative unread flag for a member (see unreadSet above): the row
		// is lit iff its last-post topic is in the caller's unread set. Left
		// absent for a guest so the client can tell "no server opinion" from
		// "the server says read".
		if e.Auth != nil {
			topicID, _ := item["last_post_topic_id"].(string)
			item["unread"] = topicID != "" && unreadSet[topicID]
		}
		items = append(items, item)
	}

	// A missing collection is the honest-degradation case the standalone route
	// already handles: an empty group list renders the board ungrouped.
	groups := make([]map[string]any, 0)
	available := true
	col, colErr := e.App.FindCachedCollectionByNameOrId(categoryGroupsCollectionName)
	if colErr != nil {
		if errors.Is(colErr, sql.ErrNoRows) || strings.Contains(colErr.Error(), "missing") {
			available = false
		} else {
			return internalError("category_groups lookup failed", colErr)
		}
	} else {
		records, err := e.App.FindRecordsByFilter(col, "", "sort_order", 0, 0)
		if err != nil {
			return internalError("failed to query category_groups", err)
		}
		for _, r := range records {
			groups = append(groups, categoryGroupPayload(r))
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"groups":     groups,
		"available":  available,
		"request_id": requestIDFrom(e),
	})
}

// listAdminCategoriesHandler is the category list the admin board edits from, and
// the ONLY place `allowed_roles` is served.
//
// It is a separate route rather than a flag on the public one because the two
// have genuinely different contracts: the public list answers "what may this
// caller see", the admin list answers "what is stored, so I can change it". A
// caller who cannot edit a category has no business being told how it is gated,
// and a single endpoint with an opt-in query parameter is one forgotten flag away
// from leaking the whole permission model to every member again.
func listAdminCategoriesHandler(e *core.RequestEvent) error {
	cats, err := e.App.FindAllRecords(categoriesCollectionName, nil)
	if err != nil {
		return internalError("failed to query categories", err)
	}

	// The board lists every row, including ones the editor cannot preview: hiding
	// a category from its own editor would make it unfixable.
	projections, err := categoryForumProjections(e.App)
	if err != nil {
		return internalError("failed to compute category counters", err)
	}

	items := make([]map[string]any, 0, len(cats))
	for _, c := range cats {
		roles := decodeRoleIDList(c.Get("allowed_roles"))
		if roles == nil {
			roles = []string{}
		}
		item := map[string]any{
			"id":            c.Id,
			"name":          labelFromRecord(c, "name_i18n", "name"),
			"slug":          c.GetString("slug"),
			"description":   labelFromRecord(c, "description_i18n", "description"),
			"group_id":      c.GetString("group_id"),
			"sort_order":    c.GetInt("sort_order"),
			"allowed_roles": roles,
			"permissions":   decodePermissionsMap(c.Get("permissions")),
			"created":       c.GetDateTime("created").String(),
			"updated":       c.GetDateTime("updated").String(),
		}
		for key, value := range projections[c.Id] {
			item[key] = value
		}
		items = append(items, item)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

// categoryWriteAllowed reports whether the caller may perform `perm` inside
// `categoryID`. A category-level override is the decisive factor:
//   - an explicit role list GRANTS access to its members even without the
//     global permission (the whole point of per-category overrides), and
//   - an explicit role list DENIES access to anyone not in it — even when the
//     caller holds the global permission — except root, who bypasses.
//
// If the category carries no override for `perm` at all (key absent, or the
// inherit marker), the caller falls back to their global permission.
// Resolution order:
//   1. root is always allowed; banned is always denied.
//   2. an explicit category role list: membership grants, non-membership denies.
//   3. absent key or inherit marker → fall back to the global permission.
func categoryWriteAllowed(app core.App, acc AccessContext, categoryID string, perm auth.Permission) (bool, error) {
	if acc.Role == auth.RoleRoot {
		return true, nil
	}
	if acc.Status == auth.StatusBanned {
		return false, nil
	}
	if categoryID == "" {
		return false, nil
	}

	category, err := app.FindRecordById(categoriesCollectionName, categoryID)
	if err != nil || category == nil {
		return false, err
	}

	perms := decodePermissionsMap(category.Get("permissions"))
	override, hasOverride := perms[string(perm)]
	if !hasOverride {
		// No override for this permission at all → fall back to the global right.
		return auth.Has(acc.Permissions, perm), nil
	}

	if len(override) == 0 {
		// Explicit empty list → root-only (ADR-1): nobody but root may act here.
		return false, nil
	}
	if slices.Contains(override, auth.CategoryInheritMarker) {
		// Inherit → follow the caller's global permission for this action.
		return auth.Has(acc.Permissions, perm), nil
	}
	return slices.Contains(override, string(acc.Role)), nil
}
