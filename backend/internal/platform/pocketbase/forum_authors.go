package pocketbase

// Author projections for the forum read model.
//
// The `topics` and `posts` rows store `author_id` and NOTHING else about the
// person. Everything the browser renders next to a message — nickname, avatar,
// status line, signature, post count, reputation, role — lives on the `users`
// row, and it changes whenever the member edits their profile.
//
// The Firestore schema cached those values onto every content row. That copy is
// exactly the drift that made a renamed member keep the old nickname on a
// thousand posts, and it is also why this file exists: the migration dropped the
// cached columns, so the read model has to JOIN users at request time instead.
//
// ONE query per page, not one per row: every loader here takes the whole set of
// author ids and returns a map, and the `decorate*` helpers only read from it.
// A topic list of 20 rows therefore costs one extra round trip, not twenty.
//
// A missing author is not an error. A deleted account leaves posts that must
// still render, so an unknown id simply decorates nothing and the browser falls
// back to its placeholder — failing the request instead would take down a whole
// category because one member was removed.

import (
	"encoding/json"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// authorDisplay is the public projection of one `users` row.
type authorDisplay struct {
	Nickname   string
	AvatarURL  string
	StatusLine string
	Role       string
	Reputation int
	PostsCount int
	Signature  string
}

// loadAuthorDisplays resolves the display projection for every id in userIDs.
//
// Unknown ids are absent from the returned map rather than mapped to a zero
// value, so `decorate*` can tell "no such author" from "an author with no
// avatar" and leave the payload alone in the first case.
func loadAuthorDisplays(app core.App, userIDs []string) map[string]authorDisplay {
	out := make(map[string]authorDisplay, len(userIDs))

	ids := make([]string, 0, len(userIDs))
	seen := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return out
	}

	var records []*core.Record
	// dbx.In takes []any: a []string is a compile error rather than a silent
	// empty IN (), which would make every author lookup "find nobody".
	inArgs := make([]any, len(ids))
	for i, id := range ids {
		inArgs[i] = id
	}
	if err := app.RecordQuery(usersCollectionName).
		AndWhere(dbx.In("id", inArgs...)).
		Limit(int64(len(ids))).
		All(&records); err != nil {
		// A failed author lookup degrades the names, it does not fail the read.
		return out
	}

	for _, rec := range records {
		out[rec.Id] = authorDisplay{
			Nickname:   rec.GetString("nickname"),
			AvatarURL:  rec.GetString("avatar_url"),
			StatusLine: rec.GetString("status_line"),
			Role:       rec.GetString("role"),
			Reputation: rec.GetInt("reputation"),
			PostsCount: rec.GetInt("posts_count"),
			Signature:  signatureFromSettings(rec.Get("settings")),
		}
	}
	return out
}

// characterDisplay is the public projection of one `characters` row.
//
// It mirrors authorDisplay deliberately: a post written under a mask renders
// through the same author_* keys, so a renderer has no second code path for
// "this was a character" — it only reads the same fields and gets a different
// name. The mask is a DISPLAY identity, never an ownership one: the post stays
// attributed to the human account, which is why the payload keeps author_id.
type characterDisplay struct {
	Name       string
	AvatarURL  string
	StatusLine string
	Signature  string
	OwnerID    string
}

// loadCharacterDisplays resolves the mask projection for every id in
// characterIDs, in ONE query.
//
// Unknown ids are absent rather than zero-valued, so the caller can tell "this
// post names a mask that no longer exists" from "this mask has no avatar" —
// the first must fall back to the account identity, the second must keep the
// mask's name.
func loadCharacterDisplays(app core.App, characterIDs []string) map[string]characterDisplay {
	out := make(map[string]characterDisplay, len(characterIDs))

	ids := make([]string, 0, len(characterIDs))
	seen := make(map[string]bool, len(characterIDs))
	for _, id := range characterIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return out
	}

	var records []*core.Record
	inArgs := make([]any, len(ids))
	for i, id := range ids {
		inArgs[i] = id
	}
	if err := app.RecordQuery(charactersCollectionName).
		AndWhere(dbx.In("id", inArgs...)).
		Limit(int64(len(ids))).
		All(&records); err != nil {
		return out
	}

	for _, rec := range records {
		out[rec.Id] = characterDisplay{
			Name:       rec.GetString("name"),
			AvatarURL:  rec.GetString(avatarURLFieldName),
			StatusLine: rec.GetString("status_line"),
			Signature:  rec.GetString("signature"),
			OwnerID:    rec.GetString("owner_id"),
		}
	}
	return out
}

// collectCharacterIDs gathers the mask ids across a page of payloads.
func collectCharacterIDs(payloads []map[string]any, field string) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if id, _ := payload[field].(string); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// findCharacter loads one mask, returning (nil, nil) when it simply does not
// exist — an absent row is a legitimate state, not an error to propagate.
func findCharacter(app core.App, id string) (*characterDisplay, error) {
	rec, err := app.FindRecordById(charactersCollectionName, id)
	if err != nil || rec == nil {
		return nil, nil
	}
	return &characterDisplay{
		Name:       rec.GetString("name"),
		AvatarURL:  rec.GetString(avatarURLFieldName),
		StatusLine: rec.GetString("status_line"),
		Signature:  rec.GetString("signature"),
		OwnerID:    rec.GetString("owner_id"),
	}, nil
}

// resolveAuthorCharacter resolves the mask a post is written under.
//
// THE SERVER OWNS THIS. The client sends the id it wants; the server answers
// with the id it is willing to accept, which is either the requested mask (when
// the caller actually owns it) or the caller's stored
// `users.last_selected_character_id` (when the request names nothing).
//
// That fallback is what makes the reply form work at all: the picker writes
// `last_selected_character_id` on selection, and a reply sends no id of its
// own. Trusting the client's id unchecked would let any member post under any
// other member's mask, which is impersonation.
//
// A requested mask that does not resolve, or is owned by somebody else, falls
// through to the stored one rather than failing the post: a mask is a display
// choice, and refusing to publish somebody's message over a stale picker would
// be a worse outcome than publishing it under their own account.
func resolveAuthorCharacter(app core.App, ownerID string, requested string) (string, error) {
	requested = strings.TrimSpace(requested)

	if requested != "" {
		display, err := findCharacter(app, requested)
		if err != nil {
			return "", err
		}
		if display != nil {
			if display.OwnerID != ownerID {
				return "", forbiddenError("you cannot post as this character")
			}
			return requested, nil
		}
	}

	owner, err := app.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return "", nil
	}
	stored := strings.TrimSpace(owner.GetString("last_selected_character_id"))
	if stored == "" {
		return "", nil
	}
	// The stored reference is validated too, for the same reason: characters.go
	// refuses to delete a mask that is the owner's current selection, but a row
	// imported from a partial export can still name a character that is absent.
	display, err := findCharacter(app, stored)
	if err != nil || display == nil || display.OwnerID != ownerID {
		return "", nil
	}
	return stored, nil
}

// collectAuthorIDs returns the non-empty values of idField across payloads,
// which is the input loadAuthorDisplays wants. loadAuthorDisplays deduplicates.
func collectAuthorIDs(payloads []map[string]any, idField string) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if id, _ := payload[idField].(string); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// decoratePostAuthor adds the author_* fields a post card renders.
//
// These are the legacy flat names the page components already read, so no
// render site has to learn a second vocabulary for the same data.
// applyMask swaps the DISPLAY fields for a mask's, when the payload names one
// the author actually owns.
//
// A mask whose row is gone, or one owned by somebody else, is IGNORED: the
// account identity already written stands. loadCharacterDisplays only resolves
// rows that exist, and the owner check is against the same author_id the
// payload was decorated with, so a payload can never borrow another member's
// mask.
func applyMask(payload map[string]any, field string, authorID string, masks map[string]characterDisplay) {
	id, _ := payload[field].(string)
	if id == "" {
		return
	}
	mask, ok := masks[id]
	if !ok || mask.OwnerID != authorID {
		return
	}

	// The ACCOUNT nickname is captured here, before the mask takes the display
	// name, because that is the moment it exists in the payload at all: on a
	// masked post `author_name` is the mask's name, so without this key the
	// person behind the character is not named anywhere in the response.
	//
	// It is what the "Player: …" tooltip on the Character badge reads. That
	// tooltip silently rendered for your own posts and for nobody else's,
	// because the page could only fill it from its own `profile.nickname` or
	// from `authorStats[uid].nickname`, which no hydration path ever writes —
	// and from a guest session there is no local profile either, so the badge
	// came out bare.
	//
	// `owner_name` is the name the legacy Firestore document used, so the
	// tooltip's existing lookup starts working again with no client change.
	// It discloses nothing new: the profile link already points at this very
	// account (author_profile_id) and the post's counters are already stamped
	// with it. A mask is a display layer over an identity the forum already
	// publishes, not an anonymity feature.
	if accountName, _ := payload["author_name"].(string); accountName != "" {
		payload["owner_name"] = accountName
	}

	payload["is_character"] = true
	payload["author_name"] = mask.Name
	payload["author_avatar"] = mask.AvatarURL
	payload["author_status_line"] = mask.StatusLine
	if mask.Signature != "" {
		payload["author_signature"] = mask.Signature
	}
	// The card links the name to a profile. A mask has no profile page, so the
	// account stays the link target while the LABEL is the mask's name.
	payload["author_profile_id"] = authorID
}

// decoratePostAuthor adds the author_* fields a post card renders.
//
// These are the legacy flat names the page components already read, so no
// render site has to learn a second vocabulary for the same data.
//
// A MASK REPLACES THE DISPLAY ONLY. When the post names a character, the
// character supplies name/avatar/status/signature and `is_character` is set, so
// the card renders "Rough" with Rough's avatar — while author_id, the role and
// the reputation counters stay the human's. Ownership and credit are not
// display settings, and letting a mask shadow them would let a member take
// credit, or blame, for something the account did not write.
func decoratePostAuthor(payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	id, _ := payload["author_id"].(string)
	display, ok := displays[id]
	if !ok {
		return
	}
	payload["author_name"] = display.Nickname
	payload["author_avatar"] = display.AvatarURL
	payload["author_status_line"] = display.StatusLine
	payload["author_role_id"] = display.Role
	payload["author_reputation"] = display.Reputation
	payload["author_posts_count"] = display.PostsCount
	payload["author_signature"] = display.Signature

	applyMask(payload, "author_character_id", id, masks)
}

// decoratePostAuthors resolves and applies the author projection to a page of
// post payloads.
func decoratePostAuthors(app core.App, payloads []map[string]any) {
	if len(payloads) == 0 {
		return
	}
	displays := loadAuthorDisplays(app, collectAuthorIDs(payloads, "author_id"))
	masks := loadCharacterDisplays(app, collectCharacterIDs(payloads, "author_character_id"))
	for _, payload := range payloads {
		decoratePostAuthor(payload, displays, masks)
	}
}

// decorateTopicAuthor adds the author_* and last_post_author_* fields a topic
// row and the forum index render.
//
// The last-post author is resolved from the SAME map as the topic author: a
// page of topics usually names a handful of accounts, so the second lookup is
// a map hit rather than a query.
// decorateTopicAuthor adds the author_* and last_post_author_* fields a topic
// row and the forum index render.
//
// The last-post author is resolved from the SAME maps as the topic author: a
// page of topics usually names a handful of accounts and a couple of masks, so
// the second lookup is a map hit rather than a query. Both may be masks — the
// topic opener and the last replier picked their masks independently, and the
// list row renders both names.
func decorateTopicAuthor(payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	if id, _ := payload["author_id"].(string); id != "" {
		if display, ok := displays[id]; ok {
			payload["author_name"] = display.Nickname
			payload["author_avatar"] = display.AvatarURL
			payload["author_status_line"] = display.StatusLine
			payload["author_role_id"] = display.Role
			payload["author_reputation"] = display.Reputation
			payload["author_posts_count"] = display.PostsCount
			payload["author_signature"] = display.Signature

			applyMask(payload, "author_character_id", id, masks)
		}
	}

	lastID, _ := payload["last_post_author_id"].(string)
	if lastID == "" {
		return
	}
	display, ok := displays[lastID]
	if !ok {
		return
	}
	payload["last_post_author"] = display.Nickname
	payload["last_post_author_avatar"] = display.AvatarURL
	// Same rule as the topic author, and the same implementation: the mask
	// renames the LAST POSTER only, and the unread dot and reputation stay the
	// account's.
	applyLastPostMask(payload, lastID, masks)
}

// decorateTopicAuthors resolves and applies the author projection to a page of
// topic payloads, including the author of each topic's most recent post.
func decorateTopicAuthors(app core.App, payloads []map[string]any) {
	if len(payloads) == 0 {
		return
	}
	ids := collectAuthorIDs(payloads, "author_id")
	ids = append(ids, collectAuthorIDs(payloads, "last_post_author_id")...)
	displays := loadAuthorDisplays(app, ids)

	maskIDs := collectCharacterIDs(payloads, "author_character_id")
	maskIDs = append(maskIDs, collectCharacterIDs(payloads, "last_post_author_character_id")...)
	masks := loadCharacterDisplays(app, maskIDs)

	for _, payload := range payloads {
		decorateTopicAuthor(payload, displays, masks)
	}
}

// applyLastPostMask renames the LAST POSTER to their mask, if they posted under
// one.
//
// It is the single implementation of that rule, shared by the topic lists and
// the category index. Both used to answer the same question differently — the
// topic rows resolved the mask, the category projection named the account — and
// the divergence was invisible because only the column differed between the
// two sources.
//
// The owner check is not decoration: a payload must never borrow another
// member's mask, so the mask must belong to the same account that authored the
// post. A deleted mask leaves the account identity standing.
func applyLastPostMask(payload map[string]any, authorID string, masks map[string]characterDisplay) {
	maskID, _ := payload["last_post_author_character_id"].(string)
	if maskID == "" || authorID == "" {
		return
	}
	mask, ok := masks[maskID]
	if !ok || mask.OwnerID != authorID {
		return
	}
	// The mask renames the LAST POSTER only. The unread dot and the reputation
	// stay the account's.
	payload["last_post_author"] = mask.Name
	payload["last_post_author_avatar"] = mask.AvatarURL
	payload["last_post_is_character"] = true
}

// decorateLastPostAuthor applies only the last_post_author_* pair, for the
// category index whose payload names a last-post author but no topic author.
func decorateLastPostAuthor(payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	id, _ := payload["last_post_author_id"].(string)
	if id == "" {
		return
	}
	if display, ok := displays[id]; ok {
		payload["last_post_author"] = display.Nickname
		payload["last_post_author_avatar"] = display.AvatarURL
	}
	applyLastPostMask(payload, id, masks)
}

// signatureFromSettings reads users.settings.signature.
//
// The column is JSON and PocketBase round-trips it through three shapes
// depending on who wrote it: a JSON field, a decoded map (what the importer
// writes), or a string-encoded object (an older row). All three are accepted
// here; anything else is simply no signature, which is what an unknown shape
// must degrade to rather than take the page down.
func signatureFromSettings(raw any) string {
	var decoded map[string]any
	switch value := raw.(type) {
	case types.JSONRaw:
		if len(value) == 0 {
			return ""
		}
		if err := json.Unmarshal(value, &decoded); err != nil {
			return ""
		}
	case map[string]any:
		decoded = value
	case string:
		if value == "" {
			return ""
		}
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return ""
		}
	default:
		return ""
	}

	signature, _ := decoded["signature"].(string)
	return signature
}
