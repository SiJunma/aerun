package pocketbase

// Server-side forum limits (migration 1767800000).
//
// The admin panel is supposed to control the post limit and the page size, but
// until this existed those values lived only in the browser's localStorage.
// Two consequences made that untenable: an admin's change applied to their own
// browser only, and the server enforced a different number entirely
// (forum.MaxPostsPerTopic) from the one every reader was shown.
//
// So the limits are read from a single-row collection and clamped to the
// ceilings in internal/auth. A missing or unreadable row yields the defaults,
// which is deliberate: a forum whose settings row was lost must still accept
// replies. Failing closed here would turn a data problem into an outage.

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const forumSettingsCollectionName = "forum_settings"

// forumSettingsID is the fixed id of the single settings row, mirroring the
// migration. A literal, so the read is a primary-key lookup.
const forumSettingsID = "forumsettings01"

// forumSettings holds the effective, clamped limits.
type forumSettings struct {
	MaxPostsPerTopic int
	PostsPerPage     int
}

// loadForumSettings reads the singleton row and clamps it.
//
// Both reads are tolerant by design: an absent collection (a database created
// before this migration ran, or a unit test with a partial schema) and an
// absent row are the same condition here — "no configuration" — and both
// produce the defaults. The clamp then guarantees a configured value can never
// escape the build's ceilings, so this is the single place the ceiling is
// enforced on the read path.
func loadForumSettings(app core.App) forumSettings {
	settings := forumSettings{
		MaxPostsPerTopic: auth.DefaultMaxPostsPerTopic,
		PostsPerPage:     auth.DefaultPostsPerPage,
	}

	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return settings
	}
	settings.MaxPostsPerTopic = auth.ClampMaxPostsPerTopic(record.GetInt("max_posts_per_topic"))
	settings.PostsPerPage = auth.ClampPostsPerPage(record.GetInt("posts_per_page"))
	return settings
}

// isTopicOpeningPost reports whether postID is the earliest published post in
// its topic.
//
// The comparison is delegated to SQL with the SAME `ORDER BY` the feed uses —
// `created ASC, id ASC` — rather than being reimplemented in Go. That is the
// whole point: a first-post check that disagreed with the feed's ordering is
// exactly how the 2026-09-30 incident deleted a whole topic, because the client
// and the server each decided "is this the first post?" independently.
//
// Comparing the timestamps in Go instead (as formatted strings) looks
// equivalent and is not: when two posts land in the same millisecond the whole
// decision rests on the id tie-breaker, and a string comparison of timestamps
// that ties or truncates differently from SQL silently promotes a reply to
// "first post" — refusing a legitimate delete with 409, or worse, permitting
// the deletion of a real opening post. One ordering, evaluated once, by the
// database.
//
// Drafts are excluded by the same predicate the feed uses: a draft is not in
// the feed, so it can neither be nor displace the opening post.
func isTopicOpeningPost(app core.App, topicID, postID string) (bool, error) {
	var opening struct {
		ID string `db:"id"`
	}
	err := app.DB().NewQuery(
		"SELECT id FROM " + postsCollectionName +
			" WHERE topic_id = {:topic} AND (is_draft = false OR is_draft IS NULL)" +
			" ORDER BY created ASC, id ASC LIMIT 1",
	).Bind(dbx.Params{"topic": topicID}).One(&opening)
	if err != nil {
		// No published post at all: the caller is looking at a draft, which is
		// not a first post by definition.
		return false, nil
	}
	return opening.ID == postID, nil
}

// countOtherAuthorsInTopic reports how many distinct accounts other than
// `excludeAuthorID` have a PUBLISHED post in the topic.
//
// Drafts are excluded on purpose: an unsent draft is private to its author and
// never renders in the feed, so it must not make a topic look like it has
// participants. A draft is not another member's content.
func countOtherAuthorsInTopic(app core.App, topicID, excludeAuthorID string) (int, error) {
	type row struct {
		Cnt int `db:"cnt"`
	}
	var res row
	err := app.DB().NewQuery(
		"SELECT COUNT(DISTINCT author_id) AS cnt FROM " + postsCollectionName +
			" WHERE topic_id = {:topic_id} AND author_id != {:excluded}" +
			" AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"topic_id": topicID, "excluded": excludeAuthorID}).One(&res)
	return res.Cnt, err
}

// effectiveMaxPostsPerTopic is the limit a write path must enforce.
func effectiveMaxPostsPerTopic(app core.App) int {
	return loadForumSettings(app).MaxPostsPerTopic
}

// CountPublishedPosts returns how many real (non-draft) posts a topic holds.
//
// It replaces the old `MAX(sequence)` read. With sequence removed, the count IS
// the limit input, so the post-limit check and the posts_count projection are
// guaranteed to be derived from the same predicate — a check against one number
// while the UI shows another is precisely the class of bug the 2026-09-30
// incident was about.
func countPublishedPosts(app core.App, topicID string) (int, error) {
	type countResult struct {
		Cnt int `db:"cnt"`
	}
	var res countResult
	err := app.DB().NewQuery(
		"SELECT COUNT(*) AS cnt FROM " + postsCollectionName +
			" WHERE topic_id = {:topic_id} AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"topic_id": topicID}).One(&res)
	return res.Cnt, err
}
