package pocketbase

import (
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Stored author variants. These strings are kept in sync with migration
// 1770000000_author_ref_schema; only this package owns their runtime writes.
const (
	authorKindField       = "author_kind"
	guestDisplayNameField = "guest_display_name"
	authorKindAccount     = "account"
	authorKindGuest       = "guest"
	// Last-post projection carries its own AuthorRef variant: the topic row
	// stores who spoke last independently of the opener columns above.
	lastPostAuthorKindField         = "last_post_author_kind"
	lastPostGuestDisplayNameField   = "last_post_guest_display_name"
)

func setAccountAuthorRef(record *core.Record, userID string) {
	record.Set("author_id", userID)
	record.Set(authorKindField, authorKindAccount)
	record.Set(guestDisplayNameField, "")
}

func setGuestAuthorRef(record *core.Record, displayName string) {
	record.Set("author_id", "")
	record.Set(authorKindField, authorKindGuest)
	record.Set(guestDisplayNameField, displayName)
}

// AuthorRef is the single domain shape for "who wrote this content".
//
// It mirrors the ADR contract: account carries a user id and no display name,
// guest carries a display name and no user id, and a mask is account-only.
// The zero value is deliberately invalid — there is no "unknown author" ref,
// because labelling damaged legacy data as a guest would invent an identity.
type AuthorRef struct {
	Kind        string
	UserID      string
	DisplayName string
	CharacterID string
}

// authorRefFromRecord reads the stored AuthorRef variant of a posts/topics
// row. It reports the truth as stored, including legacy rows that predate the
// variant column: those read back as unclassified (Kind == "") rather than
// as a silent guest.
func authorRefFromRecord(record *core.Record) AuthorRef {
	return AuthorRef{
		Kind:        record.GetString(authorKindField),
		UserID:      record.GetString("author_id"),
		DisplayName: record.GetString(guestDisplayNameField),
		CharacterID: record.GetString("author_character_id"),
	}
}

// lastPostRefFromRecord reads the stored last-post AuthorRef variant of a
// topics row. Same unclassified rule as authorRefFromRecord: a missing
// variant is a missing fact, never an implied guest.
func lastPostRefFromRecord(record *core.Record) AuthorRef {
	return AuthorRef{
		Kind:        record.GetString(lastPostAuthorKindField),
		UserID:      record.GetString("last_post_author_id"),
		DisplayName: record.GetString(lastPostGuestDisplayNameField),
		CharacterID: record.GetString("last_post_author_character_id"),
	}
}

// authorDTOFromRecord builds the nested public AuthorRef DTO for a posts or
// topics row from its STORED variant columns. This is the single adapter that
// turns storage into the ADR public shape: account => user_id, guest =>
// display name, unclassified => explicit null (never an invented guest).
// The flat author_id is still emitted by the payload builders for compatibility,
// but it is derived from the same record — never re-resolved from another source.
func authorDTOFromRecord(record *core.Record) map[string]any {
	return authorRefDTO(authorRefFromRecord(record))
}

// lastPostDTOFromRecord builds the nested public AuthorRef DTO for a topic's
// last-post projection. A topic with no last post (empty last_post_id)
// carries an explicit null; an unclassified projection is also null rather
// than an invented identity.
func lastPostDTOFromRecord(record *core.Record) map[string]any {
	if record.GetString("last_post_id") == "" {
		return nil
	}
	return authorRefDTO(lastPostRefFromRecord(record))
}

// authorRefDTO is the one place a stored AuthorRef becomes the public nested
// shape. An account keeps its user id and profile link (a mask renames the
// display but never the ownership), a guest keeps only its display name, and
// an unclassified legacy row resolves to explicit nulls — never an invented
// identity.
func authorRefDTO(ref AuthorRef) map[string]any {
	switch ref.Kind {
	case authorKindAccount:
		dto := map[string]any{
			"kind":         authorKindAccount,
			"user_id":      ref.UserID,
			"profile_id":   ref.UserID,
			"display_name": nil,
		}
		if ref.CharacterID != "" {
			dto["character_id"] = ref.CharacterID
		} else {
			dto["character_id"] = nil
		}
		return dto
	case authorKindGuest:
		return map[string]any{
			"kind":         authorKindGuest,
			"user_id":      nil,
			"profile_id":   nil,
			"display_name": ref.DisplayName,
			"character_id": nil,
		}
	default:
		return map[string]any{
			"kind":         nil,
			"user_id":      nil,
			"profile_id":   nil,
			"display_name": nil,
			"character_id": nil,
		}
	}
}

// setTopicOpener copies the opening post's stored AuthorRef onto the topic
// opener columns. The topic and its opening message are always the same
// voice, so the opener is a projection of the post row — never a separately
// validated nickname.
func setTopicOpener(topic, post *core.Record) {
	ref := authorRefFromRecord(post)
	switch ref.Kind {
	case authorKindAccount:
		setAccountAuthorRef(topic, ref.UserID)
	case authorKindGuest:
		setGuestAuthorRef(topic, ref.DisplayName)
	default:
		// Legacy unclassified opening post: do not invent an identity. The
		// row stays unclassified and the backfill report owns it.
		topic.Set("author_id", post.GetString("author_id"))
		topic.Set(authorKindField, "")
		topic.Set(guestDisplayNameField, "")
	}
	topic.Set("author_character_id", ref.CharacterID)
}

// setLastPostProjection copies a post row's stored AuthorRef onto the topic's
// last-post projection columns. It is the ONLY writer for the last-post
// author identity: every call site that advances last_post_id must go through
// it, so the id, timestamp, kind, account id, guest name and mask can never
// disagree again.
func setLastPostProjection(topic, post *core.Record) {
	topic.Set("last_post_id", post.Id)
	topic.Set("last_post_created", post.GetDateTime("created"))
	ref := authorRefFromRecord(post)
	switch ref.Kind {
	case authorKindAccount:
		topic.Set("last_post_author_id", ref.UserID)
		topic.Set(lastPostAuthorKindField, authorKindAccount)
		topic.Set(lastPostGuestDisplayNameField, "")
	case authorKindGuest:
		topic.Set("last_post_author_id", "")
		topic.Set(lastPostAuthorKindField, authorKindGuest)
		topic.Set(lastPostGuestDisplayNameField, ref.DisplayName)
	default:
		topic.Set("last_post_author_id", post.GetString("author_id"))
		topic.Set(lastPostAuthorKindField, "")
		topic.Set(lastPostGuestDisplayNameField, "")
	}
	topic.Set("last_post_author_character_id", ref.CharacterID)
}

// clearLastPostProjection empties the last-post projection of a topic that
// has no visible posts left. Every column goes — a half-cleared row is how a
// deleted mask keeps rendering in the "last post" column.
func clearLastPostProjection(topic *core.Record) {
	topic.Set("last_post_id", "")
	topic.Set("last_post_author_id", "")
	topic.Set(lastPostAuthorKindField, "")
	topic.Set(lastPostGuestDisplayNameField, "")
	topic.Set("last_post_author_character_id", "")
}

// rebuildTopicProjection recomputes a topic's posts_count and its full
// last-post projection from the visible post rows. It returns an error —
// callers must fail the whole delete/move when the rebuild fails, because a
// moved/deleted post with the old projection still pointing at it is a
// corrupted read model, not a partial success.
func rebuildTopicProjection(txApp core.App, topic *core.Record) error {
	type countResult struct {
		Cnt int `db:"cnt"`
	}
	var cRes countResult
	if err := txApp.DB().NewQuery(
		"SELECT COUNT(*) AS cnt FROM "+postsCollectionName+
			" WHERE topic_id = {:topic_id} AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"topic_id": topic.Id}).One(&cRes); err != nil {
		return fmt.Errorf("count topic posts: %w", err)
	}
	topic.Set("posts_count", cRes.Cnt)

	var latestPosts []*core.Record
	if err := txApp.RecordQuery(postsCollectionName).
		AndWhere(dbx.HashExp{"topic_id": topic.Id}).
		AndWhere(dbx.NewExp("is_draft = false OR is_draft IS NULL")).
		OrderBy("created DESC", "id DESC").
		Limit(1).
		All(&latestPosts); err != nil {
		return fmt.Errorf("find the new last post: %w", err)
	}
	if len(latestPosts) > 0 {
		setLastPostProjection(topic, latestPosts[0])
	} else {
		clearLastPostProjection(topic)
	}
	if err := txApp.Save(topic); err != nil {
		return fmt.Errorf("save rebuilt topic projection: %w", err)
	}
	return nil
}

// verifyAuthorRefSchema asserts at boot that every mandatory AuthorRef column
// actually exists.
//
// It exists because the same silent failure this audit removes keeps coming
// back through restores: PocketBase's Record.Set on a missing field is a
// SILENT no-op, so a database restored from a snapshot taken before migration
// 1769800000/1770000000 — while the migration tracker still records them as
// applied — would never re-run the migration on restart. Every guest write
// would then drop its nickname/display name without an error, and the forum
// index would render "Deleted user" for every guest.
//
// apis.Serve applies every migration before OnServe runs, so reaching this
// hook with a column missing is not a race and not a first-boot condition —
// it means the binary and the data directory disagree, and continuing would
// serve a forum whose guest authorship is quietly wrong. Refusing to start is
// the honest outcome: the fix is to run the migrations, which any restart of
// a current binary does automatically. A one-off snapshot repair lives in an
// explicit operator migration with a report, never in silent runtime code.
func verifyAuthorRefSchema(app core.App) error {
	required := map[string][]string{
		postsCollectionName:             {"author_id", authorKindField, guestDisplayNameField, "guest_principal_id"},
		topicsCollectionName:            {"author_id", authorKindField, guestDisplayNameField, lastPostAuthorKindField, lastPostGuestDisplayNameField, "guest_principal_id"},
		guestPrincipalsCollectionName:   {"guest_id", "capability_hash", "last_used_at"},
	}
	for _, collectionName := range []string{postsCollectionName, topicsCollectionName, guestPrincipalsCollectionName} {
		collection, err := app.FindCachedCollectionByNameOrId(collectionName)
		if err != nil {
			return fmt.Errorf("%s collection unavailable: %w", collectionName, err)
		}
		for _, field := range required[collectionName] {
			if collection.Fields.GetByName(field) == nil {
				return fmt.Errorf(
					"%s.%s is missing: this binary and the data directory are out of sync "+
						"(migrations run automatically on start -- if you are seeing this, the "+
						"process is running a build from before migration 1770000000, and every "+
						"guest write would silently drop its author identity)",
					collectionName, field)
			}
		}
	}
	return nil
}
