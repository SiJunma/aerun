// PublicProfile reads a single account for a profile page. The browser used to
// read it straight off the `users` collection (`pb.collection('users').getOne`),
// which meant a signed-out visitor received the WHOLE auth record — including
// `settings`, where every member's private preferences live (sound volume, which
// notification types are muted, whether DM and topic-reply mail is wanted,
// theme, language) and the PocketBase scaffolding around them
// (`collectionId`, `emailVisibility`, `nickname_normalized`).
//
// This is the same split `/admin/users` already makes for staff, and the same
// pattern `/users/{id}/posts` and `/users/{id}/characters` already follow: the
// command layer assembles a whitelist, so the browser stops reading a table.
//
// Visibility matches those two routes and migration 1768100000: the account must
// exist, and its status is irrelevant — a ban restricts what an account may DO,
// not what others may see of it.
//
//	GET /api/aerun/users/{id}
package pocketbase

import (
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// getUserProfileHandler serves GET /api/aerun/users/{id}.
func getUserProfileHandler(e *core.RequestEvent) error {
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("user identifier is required")
	}

	record, err := e.App.FindRecordById(usersCollectionName, id)
	if err != nil || record == nil {
		return notFoundError("user not found")
	}

	settings, err := decodeSettings(record)
	if err != nil {
		e.App.Logger().Warn("users.settings could not be decoded; serving empty settings",
			"error", err, "userId", record.Id)
		settings = map[string]any{}
	}

	// THE PUBLIC PART OF `settings` is a whitelist of exactly three keys.
	//
	// `signature` belongs here because it is already PUBLIC: forum_authors.go
	// stamps it onto every post as `author_signature` for every reader, so
	// hiding it from a profile page would make the forum contradict itself. It
	// lives inside `settings` only for legacy reasons (see migration
	// 1766900000), which is no reason to ship the rest of the object with it.
	//
	// The two reputation-visibility flags have to be readable by everyone too:
	// ProfilePage evaluates `viewedProfile.settings.rep_show_history === false`
	// to decide whether to hide ANOTHER member's history and vote comments. If
	// the flag were owner-only, turning it off would silently do nothing.
	//
	// Everything else — theme, language, sound volume, which notification types
	// are muted, whether DM and topic-reply mail is wanted — is a private
	// preference of the owner and goes to the owner only.
	publicSettings := map[string]any{
		"signature":         settings["signature"],
		"rep_show_history":  settings["rep_show_history"],
		"rep_show_comments": settings["rep_show_comments"],
	}
	if e.Auth != nil && e.Auth.Id == record.Id {
		publicSettings = settings
	}

	// The EFFECTIVE mask limit for THIS account: the role's own number when
	// the role states one, the forum-wide setting otherwise.
	//
	// It is here because the profile's mask counter has to show the number
	// that will actually be enforced. The forum-wide setting alone would be
	// wrong for every role that states its own limit — and a counter that
	// names the wrong limit is worse than no counter.
	//
	// The key is added ONLY when the limit resolved: a zero would read as
	// "no masks at all" rather than "no answer", and the counter is better
	// absent than wrong.
	payload := map[string]any{
		"id":             record.Id,
		"nickname":       record.GetString("nickname"),
		"role":           profileRole(record),
		"custom_role_id": record.GetString("custom_role_id"),
		"status":         record.GetString("status"),
		"deleted":        isUserDeleted(record),
		"verified":       record.GetBool("verified"),
		"avatar":         record.GetString("avatar"),
		"avatar_url":     record.GetString("avatar_url"),
		"status_line":    record.GetString("status_line"),
		"bio":            record.GetString("bio"),
		"location":       record.GetString("location"),
		"birthday":       record.GetString("birthday"),
		"occupation":     record.GetString("occupation"),
		"interests":      record.GetString("interests"),
		"contacts":       record.GetString("contacts"),
		"posts_count":    record.GetInt("posts_count"),
		"topics_count":   record.GetInt("topics_count"),
		"reputation":     record.GetInt("reputation"),
		// `created_at` IS the account's registration, reduced to a UTC calendar
		// day: "2026-04-17", never "2026-04-17 22:45:57.744Z".
		//
		// It is here for exactly ONE consumer — the unread floor. TopicRow,
		// MainPage, TopicPage and NewRepliesPage all compute
		// max(lastVisit, registration) so a brand-new account is not shown a wall
		// of unread topics that predate it, and all four read `profile.created_at`,
		// which this payload carried no value for at all. A day is enough to
		// ORDER an account against other rows, which is all that comparison uses.
		//
		// `created` and `last_seen` themselves stay ABSENT, and that is the half
		// that matters. At PocketBase's full precision they were a fingerprint
		// rather than a date: a millisecond-exact signup time seats a member
		// inside a signup burst, inside a timezone, and relative to the legacy
		// Firebase migration — and this route answers SIGNED-OUT visitors. A
		// calendar day carries none of that and still orders correctly.
		"created_at": registrationDay(record),
		"settings":   publicSettings,
		"request_id": requestIDFrom(e),
	}
	if limit, err := characterLimitFor(e.App, record.Id); err == nil && limit > 0 {
		payload["character_limit"] = limit
	}
	return e.JSON(http.StatusOK, payload)
}

// profileRole reports the role a profile response carries. A soft-deleted
// account reads as "Deleted" regardless of the stored role value: the baked
// role is staff history, not a badge the forum should keep painting.
func profileRole(record *core.Record) string {
	if isUserDeleted(record) {
		return "Deleted"
	}
	return record.GetString("role")
}

// getPeerCardHandler serves GET /api/aerun/peers/{id}.
//
// THE MINIMUM A CONVERSATION NEEDS, and nothing else.
//
// The DM thread used to answer two questions about the person on the other side
// — what to call them, and may I still write to them — by reading the FULL
// profile DTO, twice, for the same account. That route is a profile PAGE: it
// carries bio, birthday, occupation, interests, contacts, three counters, the
// registration day and a `settings` object. A chat header renders a nickname and
// an avatar. The composer renders one boolean.
//
// So every thread open pulled a member's private preferences — sound volume,
// muted notification types, mail preferences, theme, language — into a component
// that displays none of them. The DTO already narrows `settings` to three keys
// for anyone but the owner, so this was never a stranger's settings on purpose.
// But this is not a profile page at all, and asking it a question it does not
// need is exactly how a payload grows a field nobody chose to send.
//
// Visibility matches getUserProfileHandler: the account must exist, and a ban
// restricts what an account may DO, not what others may see of it. `status`
// rides along precisely so the composer can disable itself.
func getPeerCardHandler(e *core.RequestEvent) error {
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("peer identifier is required")
	}

	record, err := e.App.FindRecordById(usersCollectionName, id)
	if err != nil || record == nil {
		return notFoundError("user not found")
	}

	return e.JSON(http.StatusOK, map[string]any{
		"id":         record.Id,
		"nickname":   record.GetString("nickname"),
		"avatar":     record.GetString("avatar"),
		"avatar_url": record.GetString("avatar_url"),
		"status":     record.GetString("status"),
		"deleted":    isUserDeleted(record),
		"request_id": requestIDFrom(e),
	})
}

// registrationDay reduces an account's creation instant to a UTC calendar day.
//
// MIDNIGHT UTC IS DELIBERATE, and the direction is the point. Every consumer
// takes max(lastVisit, registration), so a COARSER registration value can only
// move that floor EARLIER — which over-counts unread on the signup day and
// hides nothing. Rounding the day UP to its end, or serving the true instant
// with milliseconds, would swallow every topic posted on the day the account was
// created.
//
// An empty string, not "0001-01-01": a zero timestamp formatted as a date parses
// as a real instant about two thousand years ago, which would read as "registered
// at the beginning of time" rather than "unknown".
func registrationDay(record *core.Record) string {
	created := record.GetDateTime("created").Time()
	if created.IsZero() {
		return ""
	}
	return created.UTC().Format(time.DateOnly)
}

// GET /api/aerun/users — the public member board, the LIST counterpart of the
// profile DTO above.
//
// It existed before as `pb.collection('users').getFullList({ sort: 'nickname' })`,
// which serialised the whole auth record for every account and sent it to
// SIGNED-OUT visitors. Naming `fields` closed the immediate leak but kept the
// browser reading a table directly, which means the whitelist would have to be
// maintained in two languages forever — and PocketBase's `fields` cannot narrow
// a JSON column, so `settings` could only have been dropped by dropping the
// whole object. Assembling it here is the only place that can actually express
// "these keys and not those".
//
// The response envelope is deliberately IDENTICAL to /api/aerun/admin/users
// (items/totalPages/page/perPage), so the client walks both with one loop. That
// is not cosmetic: two envelopes mean two paginators, and two paginators drift.
//
// NOT IN THE WHITELIST, unlike the staff DTO:
//   - `settings`, in any part. The members table reads none of it, and on the
//     profile DTO the only public keys are the signature and the two reputation
//     visibility flags — none of which this screen renders either.
//   - `email`, for the reason given in admin_users.go. Neither does the table.
//
// `status` and `verified` ARE here, because MembersPage paints both and they
// were already public through the SDK read this replaces.
func listUsersHandler(e *core.RequestEvent) error {
	query := e.Request.URL.Query()
	page, perPage := parseAdminPagination(query.Get("page"), query.Get("perPage"))

	// The members board lists living members. A soft-deleted account keeps its
	// row for its profile page and its posts, but the board is a directory of
	// people you can meet — a baked nickname with no one behind it does not
	// belong there.
	records := make([]*core.Record, 0, perPage)
	if err := e.App.RecordQuery(usersCollectionName).
		AndWhere(notDeletedUsersExpr()).
		OrderBy("nickname ASC", "id ASC").
		Limit(int64(perPage)).
		Offset(int64((page - 1) * perPage)).
		All(&records); err != nil {
		return internalError("failed to query accounts", err)
	}

	total, err := e.App.CountRecords(usersCollectionName, notDeletedUsersExpr())
	if err != nil {
		return internalError("failed to count accounts", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		if isUserDeleted(record) {
			continue
		}
		items = append(items, map[string]any{
			"id":           record.Id,
			"nickname":     record.GetString("nickname"),
			"avatar_url":   record.GetString("avatar_url"),
			"role":         record.GetString("role"),
			"status":       record.GetString("status"),
			"status_line":  record.GetString("status_line"),
			"verified":     record.GetBool("verified"),
			"posts_count":  record.GetInt("posts_count"),
			"topics_count": record.GetInt("topics_count"),
			"reputation":   record.GetInt("reputation"),
			"created":      record.GetDateTime("created"),
			"last_seen":    lastSeenOrCreated(record),
		})
	}

	totalItems := int(total)
	return e.JSON(http.StatusOK, map[string]any{
		"page":       page,
		"perPage":    perPage,
		"totalItems": totalItems,
		"totalPages": (totalItems + perPage - 1) / perPage,
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

// ── Nickname availability and member search ──────────────────────────────────
//
// Both of these used to be `pb.collection('users').getList(…)` calls from the
// browser, which is the same mistake as the profile read, twice more:
//
//   - the availability pre-check fetched a WHOLE auth record and answered a
//     yes/no question with it, so typing a nickname during registration handed
//     the registering guest a stranger's `settings` and email;
//   - the mention picker fetched five WHOLE auth records per keystroke, so a
//     search box leaked the private preferences of up to five accounts.
//
// The answers are booleans and tiny identity lists. Neither needs an auth
// record, and the UNIQUE index on nickname_normalized stays the real
// enforcement — this only moves the pre-check onto the same normaliser the
// server uses, so the form can no longer disagree with the database.

// GET /api/aerun/nicknames/check?nickname=…&exclude=…
func checkNicknameHandler(e *core.RequestEvent) error {
	query := e.Request.URL.Query()
	raw := strings.TrimSpace(query.Get("nickname"))
	if raw == "" {
		return validationError("nickname is required")
	}

	// Normalised SERVER-SIDE, by the same function that fills the indexed
	// column. The client used to normalise in JavaScript, which is how "Ａ"
	// and "a" could disagree between the form and the database.
	key := auth.NormalizeNickname(raw)

	var found []*core.Record
	if err := e.App.RecordQuery(usersCollectionName).
		AndWhere(dbx.HashExp{"nickname_normalized": key}).
		AndWhere(notDeletedUsersExpr()).
		Limit(1).
		All(&found); err != nil {
		return internalError("failed to check nickname", err)
	}

	available := len(found) == 0
	// Renaming to the name you already hold is not a conflict, which is the
	// case the profile form hits on every save that does not change the name.
	exclude := strings.TrimSpace(query.Get("exclude"))
	if !available && exclude != "" && found[0].Id == exclude {
		available = true
	}

	return e.JSON(http.StatusOK, map[string]any{
		"available":  available,
		"request_id": requestIDFrom(e),
	})
}

// GET /api/aerun/users/search?q=…
//
// The mention picker's backing read. A SUBSTRING match on nickname, capped at
// five rows, carrying three columns. The cap matters as much as the whitelist:
// this is an unauthenticated-friendly endpoint, so an unbounded one would turn
// the member board into a directory dump.
func searchUsersHandler(e *core.RequestEvent) error {
	raw := strings.TrimSpace(e.Request.URL.Query().Get("q"))
	if len([]rune(raw)) < 2 {
		return e.JSON(http.StatusOK, map[string]any{
			"items":      []map[string]any{},
			"request_id": requestIDFrom(e),
		})
	}

	limit := 5
	records := make([]*core.Record, 0, limit)
	// The needle is BOUND, never interpolated: a nickname may contain `"`, `%`
	// and `_`, and a LIKE built by concatenation is both an injection point and a
	// way to match every account. `dbx.Like` renders `%?%` with the value bound.
	//
	// Soft-deleted accounts are excluded: their baked nickname must not be
	// offered by the mention picker as a living member.
	if err := e.App.RecordQuery(usersCollectionName).
		AndWhere(dbx.Like("nickname", raw)).
		AndWhere(notDeletedUsersExpr()).
		OrderBy("nickname ASC", "id ASC").
		Limit(int64(limit)).
		All(&records); err != nil {
		return internalError("failed to search accounts", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		if isUserDeleted(record) {
			continue
		}
		items = append(items, map[string]any{
			"id":         record.Id,
			"nickname":   record.GetString("nickname"),
			"avatar_url": record.GetString("avatar_url"),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}
