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
	"encoding/json"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const forumSettingsCollectionName = "forum_settings"

// forumSettingsID is the fixed id of the single settings row, mirroring the
// migration. A literal, so the read is a primary-key lookup.
const forumSettingsID = "forumsettings01"

// defaultMaxCharsPerPost matches the admin panel's initial maxCharsPerPost and
// the seed value the migration writes. Declared here rather than imported from
// internal/migrations so the platform adapter keeps no dependency on the
// migration package (which would invert the layering migrations themselves
// already point at).
const defaultMaxCharsPerPost = 15000

// forumSettings holds the effective, clamped limits.
type forumSettings struct {
	MaxPostsPerTopic int
	PostsPerPage     int
	// TopicsPerPage governs every LIST OF TOPICS. Separate from PostsPerPage
	// because a topic row and a post row are not the same height, and one shared
	// number would have to be wrong for one of them.
	TopicsPerPage int

	// The fields below arrive with 1768800000, which moved the admin panel's
	// global settings out of each browser's localStorage. They live here rather
	// than in a second struct so there is exactly one read of the settings row:
	// the access guards, the API snapshot and the mail templates all take their
	// answer from this one function.
	RegistrationEnabled   bool
	RequireApproval       bool
	WhitelistMode         bool
	MaintenanceMode       bool
	MaxCharsPerPost       int
	EnableReputation      bool
	ReputationStyle       string
	EnableCharacters      bool
	EnableDice            bool
	AllowGifAvatars       bool
	AllowGifInPosts       bool
	AllowUserCustomDesign bool
	DefaultDesignID       string
	LogoURL               string
	BgLight               string
	BgDark                string
	BgNeutral             string
	BgOpacityLight        float64
	BgOpacityDark         float64
	BgOpacityNeutral      float64

	// DeletedAvatarURL and GuestAvatarURL are the host-agnostic /api/files
	// references to the admin-uploaded placeholder images (migration
	// 1769400000): the avatar shown for a removed account and the one shown for
	// a guest. Empty means "no custom image uploaded", and the frontend falls
	// back to its neutral default (identity.js). They live here rather than in a
	// second struct so the public settings snapshot and the admin panel read the
	// same row the rest of the settings come from.
	DeletedAvatarURL string
	GuestAvatarURL   string

	// EmailTemplates is the raw JSON of forum_settings.email_templates
	// (migration 1769300000): a map of mail type -> {subject, body}. The
	// resolver loadEmailTemplates reads it from here rather than issuing a
	// second query, so every mail path sees the same snapshot of the row as
	// the access guards. Read-only by construction: nothing in this package
	// writes it back, which is what makes an admin's edit survive restarts
	// the same way SMTP settings do.
	EmailTemplates string
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
		TopicsPerPage:    auth.DefaultTopicsPerPage,
		// The defaults below are what the admin panel displayed as its initial
		// state before 1768800000, so an untouched forum behaves identically
		// after the move. Registration and every feature stay ON: defaulting a
		// feature OFF would silently delete it from every deployment that
		// upgraded without anyone opening the panel.
		RegistrationEnabled:   true,
		RequireApproval:       true,
		MaxCharsPerPost:       defaultMaxCharsPerPost,
		EnableReputation:      true,
		ReputationStyle:       "both",
		EnableCharacters:      true,
		EnableDice:            true,
		AllowGifAvatars:       true,
		AllowGifInPosts:       true,
		AllowUserCustomDesign: true,
		BgOpacityLight:        0.5,
		BgOpacityDark:         0.5,
		BgOpacityNeutral:      0.5,
	}

	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		return settings
	}
	settings.MaxPostsPerTopic = auth.ClampMaxPostsPerTopic(record.GetInt("max_posts_per_topic"))
	settings.PostsPerPage = auth.ClampPostsPerPage(record.GetInt("posts_per_page"))
	// GetInt returns 0 for a row written before this field existed, and
	// ClampTopicsPerPage reads 0 as "unset" — so a pre-migration database picks
	// up the default here rather than clamping to a floor of 1.
	settings.TopicsPerPage = auth.ClampTopicsPerPage(record.GetInt("topics_per_page"))

	settings.RegistrationEnabled = record.GetBool("registration_enabled")
	settings.RequireApproval = record.GetBool("require_approval")
	settings.WhitelistMode = record.GetBool("whitelist_mode")
	settings.MaintenanceMode = record.GetBool("maintenance_mode")
	settings.EnableReputation = record.GetBool("enable_reputation")
	settings.EnableCharacters = record.GetBool("enable_characters")
	settings.EnableDice = record.GetBool("enable_dice")
	settings.AllowGifAvatars = record.GetBool("allow_gif_avatars")
	settings.AllowGifInPosts = record.GetBool("allow_gif_in_posts")
	settings.AllowUserCustomDesign = record.GetBool("allow_user_custom_design")
	settings.DefaultDesignID = record.GetString("default_design_id")
	settings.LogoURL = record.GetString("logo_url")
	settings.DeletedAvatarURL = record.GetString("deleted_avatar_url")
	settings.GuestAvatarURL = record.GetString("guest_avatar_url")
	settings.BgLight = record.GetString("bg_light")
	settings.BgDark = record.GetString("bg_dark")
	settings.BgNeutral = record.GetString("bg_neutral")
	if v := record.GetString("reputation_style"); v != "" {
		settings.ReputationStyle = v
	}
	// 0 is a deliberate admin choice meaning "unlimited" — the label the admin
	// panel has always shown ("0 = unlimited") and the value the Firestore
	// legacy export carried. It must survive the read: only an ABSENT column
	// (a schema older than 1768800000) falls back to the default. GetInt reads
	// 0 for both shapes, so the field's presence is what disambiguates them.
	if n := record.GetInt("max_chars_per_post"); n > 0 || unlimitedCharsPerPost(record) {
		settings.MaxCharsPerPost = n
	}
	settings.BgOpacityLight = clampOpacity(record, "bg_opacity_light", 0.5)
	settings.BgOpacityDark = clampOpacity(record, "bg_opacity_dark", 0.5)
	settings.BgOpacityNeutral = clampOpacity(record, "bg_opacity_neutral", 0.5)
	rawTemplates := record.Get("email_templates")
	switch v := rawTemplates.(type) {
	case string:
		settings.EmailTemplates = v
	case types.JSONRaw:
		settings.EmailTemplates = string(v)
	case []byte:
		settings.EmailTemplates = string(v)
	default:
		if v != nil {
			if b, err := json.Marshal(v); err == nil {
				settings.EmailTemplates = string(b)
			}
		}
	}
	return settings
}

// unlimitedCharsPerPost reports whether the row's max_chars_per_post column
// exists and the admin's stored 0 must be honored as "unlimited" rather than
// collapsed into the default. A schema without the column (a pre-1768800000
// database) keeps the default: its 0 means "unset", not a choice.
func unlimitedCharsPerPost(record *core.Record) bool {
	return record.Collection().Fields.GetByName("max_chars_per_post") != nil
}

// clampOpacity reads a CSS alpha.
//
// The column carries Min/Max 0..1, but the value is clamped again here because
// the read path must not depend on the schema being present: a snapshot restored
// from before the field exists reads 0, which would render the forum with a
// fully transparent background — unreadable — instead of falling back.
func clampOpacity(record *core.Record, field string, fallback float64) float64 {
	switch v := record.Get(field).(type) {
	case float64:
		if v <= 0 || v > 1 {
			return fallback
		}
		return v
	case int64:
		if v <= 0 || float64(v) > 1 {
			return fallback
		}
		return float64(v)
	}
	return fallback
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
