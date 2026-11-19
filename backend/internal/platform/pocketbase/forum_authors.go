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
	// IsDeleted marks a soft-deleted account: the row survives with its baked
	// nickname/avatar/counters, the role badge reads "Deleted", and the
	// account may no longer act. Its MASKS still render: they are baked with
	// the posts that used them (see decoratePostAuthor).
	IsDeleted bool
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
		role := rec.GetString("role")
		deleted := isUserDeleted(rec)
		if deleted {
			role = "Deleted"
		}
		out[rec.Id] = authorDisplay{
			Nickname:   rec.GetString("nickname"),
			AvatarURL:  rec.GetString("avatar_url"),
			StatusLine: rec.GetString("status_line"),
			Role:       role,
			Reputation: rec.GetInt("reputation"),
			PostsCount: rec.GetInt("posts_count"),
			Signature:  signatureFromSettings(rec.Get("settings")),
			IsDeleted:  deleted,
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
		if dto, ok := payload["author"].(map[string]any); ok && dto != nil {
			if id, _ := dto["character_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
			if id, _ := dto["character_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if field != "" {
			if id, _ := payload[field].(string); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}

// collectLastPostCharacterIDs returns the non-empty character_id values of the
// nested last_post_author_ref DTO or flat field across payloads.
func collectLastPostCharacterIDs(payloads []map[string]any, field string) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
			if id, _ := dto["character_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if field != "" {
			if id, _ := payload[field].(string); id != "" {
				out = append(out, id)
			}
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
//
// THE SWITCHED-OFF CASE IS DIFFERENT, and it is the one that must not fall
// through. While the forum's mask system is disabled, the answer is no mask
// at all: the post goes out under the account. This is not the "stale picker"
// case above — there, the member meant to post under a mask and the server
// only failed to match the id; here, the feature is switched off, and honouring
// the stored selection would keep the feature alive through the back door
// while the admin panel says it is off.
func resolveAuthorCharacter(app core.App, ownerID string, requested string) (string, error) {
	if !loadForumSettings(app).EnableCharacters {
		return "", nil
	}

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

// collectAuthorIDs returns the non-empty user_id values of the nested
// AuthorRef DTO across payloads, which is the input loadAuthorDisplays wants.
// loadAuthorDisplays deduplicates.
func collectAuthorIDs(payloads []map[string]any, idField string) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if dto, ok := payload["author"].(map[string]any); ok && dto != nil {
			if id, _ := dto["user_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
			if id, _ := dto["user_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if idField != "" {
			if id, _ := payload[idField].(string); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}

// collectLastPostAuthorIDs returns the non-empty user_id values of the nested
// last_post_author_ref DTO across payloads.
func collectLastPostAuthorIDs(payloads []map[string]any, idField string) []string {
	out := make([]string, 0, len(payloads))
	for _, payload := range payloads {
		if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
			if id, _ := dto["user_id"].(string); id != "" {
				out = append(out, id)
			}
		}
		if idField != "" {
			if id, _ := payload[idField].(string); id != "" {
				out = append(out, id)
			}
		}
	}
	return out
}

// applyMask swaps the DISPLAY fields of a payload's nested AuthorRef DTO
// for a mask's, when the DTO names a character the author actually owns.
//
// The mask id comes from the DTO itself (authorDTOFromRecord builds it from
// the record) — there is no top-level `author_character_id` on the payload
// any more (F-21), and no top-level `is_character` either: the DTO carries
// both, and every reader takes them from there.
//
// A mask whose row is gone, or one owned by somebody else, is IGNORED: the
// account identity already written stands. loadCharacterDisplays only resolves
// rows that exist, and the owner check is against the same author_id the
// payload was decorated with, so a payload can never borrow another member's
// mask.
func applyMask(payload map[string]any, authorID string, masks map[string]characterDisplay) {
	id := ""
	if dto, ok := payload["author"].(map[string]any); ok && dto != nil {
		id, _ = dto["character_id"].(string)
	}
	if id == "" || authorID == "" {
		return
	}
	mask, ok := masks[id]
	if !ok || mask.OwnerID != authorID {
		return
	}

	// Update AuthorRef DTO directly so the DTO is the complete single source of truth.
	accountName := ""
	if dto, ok := payload["author"].(map[string]any); ok && dto != nil {
		accountName, _ = dto["display_name"].(string)
		dto["display_name"] = mask.Name
		dto["avatar_url"] = mask.AvatarURL
		dto["is_character"] = true
		dto["character_id"] = id
		// Status/signature come from the mask record itself — NOT from the
		// account's record: a mask with no signature of its own renders
		// NO signature (the account's must not leak under the mask's name).
		dto["status_line"] = mask.StatusLine
		dto["signature"] = mask.Signature
		// The account nickname is the name behind the mask: the Character
		// badge's "Player: …" tooltip reads it from here. A mask is a
		// display layer over an identity the forum already publishes
		// (the profile link points at this account), not an anonymity
		// feature — so naming the player discloses nothing new.
		if accountName != "" {
			dto["owner_name"] = accountName
		}
	}
}

// decoratePostAuthor resolves the author display fields into the nested
// AuthorRef DTO — the single source of truth for author display (F-18).
// The legacy flat author_* keys are gone; every reader takes the DTO.
//
// A MASK REPLACES THE DISPLAY ONLY. When the post names a character, the
// character supplies name/avatar/status/signature and `is_character` is set, so
// the card renders "Rough" with Rough's avatar — while author_id, the role and
// the reputation counters stay the human's. Ownership and credit are not
// display settings, and letting a mask shadow them would let a member take
// credit, or blame, for something the account did not write.
func decoratePostAuthor(app core.App, payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	dto, _ := payload["author"].(map[string]any)
	if dto == nil {
		return
	}
	id, _ := dto["user_id"].(string)
	if id == "" {
		// Guest post: the display name already lives in the nested DTO.
		if dto["kind"] == authorKindGuest {
			if s := loadForumSettings(app); s.GuestAvatarURL != "" {
				dto["avatar_url"] = s.GuestAvatarURL
			}
		}
		return
	}
	display, ok := displays[id]
	if !ok {
		// Deleted account: leave the nested DTO's display_name/avatar_url null
		dto["display_name"] = nil
		dto["avatar_url"] = nil
		dto["is_character"] = false
		return
	}

	// Write the resolved display fields into the nested AuthorRef DTO — the
	// single source of truth for author display (F-18). The post card reads
	// status/signature from here, so the page renders its final height on
	// first paint with no separate per-character fetch.
	dto["display_name"] = display.Nickname
	dto["avatar_url"] = display.AvatarURL
	dto["reputation"] = display.Reputation
	dto["posts_count"] = display.PostsCount
	dto["status_line"] = display.StatusLine
	dto["signature"] = display.Signature
	dto["role"] = display.Role
	dto["is_character"] = false
	if display.IsDeleted {
		dto["deleted"] = true
	}

	// THE MASK IS BAKED, SO IT STILL RENDERS.
	//
	// A soft-deleted account cannot change its masks any more (every
	// mutating route refuses a deleted account), and a mask that posts
	// reference cannot be deleted at all (the delete command refuses it
	// with 409). The row behind this id is therefore FROZEN: its name,
	// status, avatar and signature are exactly what the post was published
	// under. Hiding it would rewrite the message the reader sees - a post
	// that said "Rough" would suddenly read "Deleted user".
	//
	// The ACCOUNT identity is still marked deleted: a mask is a display
	// layer over an identity, and the identity is gone. The mask does not
	// resurrect the account, and it does not make the account's other
	// actions (profile link, direct messages, quoting) available again.
	applyMask(payload, id, masks)

	if display.IsDeleted {
		return
	}
}

// decoratePostAuthors resolves and applies the author projection to a page of
// post payloads.
func decoratePostAuthors(app core.App, payloads []map[string]any) {
	if len(payloads) == 0 {
		return
	}
	displays := loadAuthorDisplays(app, collectAuthorIDs(payloads, "author_id"))
	masks := loadCharacterDisplays(app, collectCharacterIDs(payloads, ""))
	for _, payload := range payloads {
		decoratePostAuthor(app, payload, displays, masks)
	}
}

// decorateTopicAuthor resolves the author display fields into the nested
// AuthorRef DTOs a topic row and the forum index render.
//
// The last-post author is resolved from the SAME maps as the topic author: a
// page of topics usually names a handful of accounts and a couple of masks, so
// the second lookup is a map hit rather than a query. Both may be masks — the
// topic opener and the last replier picked their masks independently, and the
// list row renders both names.
func decorateTopicAuthor(app core.App, payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	dto, _ := payload["author"].(map[string]any)
	if dto == nil {
		return
	}
	id, _ := dto["user_id"].(string)
	if id == "" {
		// Guest topic: the display name is already in the nested AuthorRef DTO
		if dto["kind"] == authorKindGuest {
			if s := loadForumSettings(app); s.GuestAvatarURL != "" {
				dto["avatar_url"] = s.GuestAvatarURL
			}
		}
		decorateLastPostAuthor(app, payload, displays, masks)
		return
	}
	display, ok := displays[id]
	if !ok {
		// Deleted account: leave the nested DTO's display_name/avatar_url null
		dto["display_name"] = nil
		dto["avatar_url"] = nil
		dto["is_character"] = false
		decorateLastPostAuthor(app, payload, displays, masks)
		return
	}

	// Write the resolved display fields into the nested AuthorRef DTO — the
	// single source of truth for author display (F-18).
	dto["display_name"] = display.Nickname
	dto["avatar_url"] = display.AvatarURL
	dto["role"] = display.Role
	dto["is_character"] = false
	if display.IsDeleted {
		dto["deleted"] = true
	}

	// The mask is baked, so it still renders (see decoratePostAuthor).
	applyMask(payload, id, masks)

	if display.IsDeleted {
		decorateLastPostAuthor(app, payload, displays, masks)
		return
	}

	// The last-post author is decorated HERE too, through the same shared helper
	// the category index uses. decorateTopicAuthors already loaded the last-post
	// ids and masks into these maps; without this call a topic list row never
	// resolved its last poster and the client fell back to the opener — the
	// exact divergence the audit flagged.
	decorateLastPostAuthor(app, payload, displays, masks)
}

// decorateTopicAuthors resolves and applies the author projection to a page of
// topic payloads, including the author of each topic's most recent post.
func decorateTopicAuthors(app core.App, payloads []map[string]any) {
	if len(payloads) == 0 {
		return
	}
	ids := collectAuthorIDs(payloads, "author_id")
	ids = append(ids, collectLastPostAuthorIDs(payloads, "last_post_author_id")...)
	displays := loadAuthorDisplays(app, ids)

	maskIDs := collectCharacterIDs(payloads, "")
	maskIDs = append(maskIDs, collectLastPostCharacterIDs(payloads, "last_post_author_character_id")...)
	masks := loadCharacterDisplays(app, maskIDs)

	for _, payload := range payloads {
		decorateTopicAuthor(app, payload, displays, masks)
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
	if maskID == "" {
		if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
			maskID, _ = dto["character_id"].(string)
		}
	}
	if maskID == "" || authorID == "" {
		return
	}
	mask, ok := masks[maskID]
	if !ok || mask.OwnerID != authorID {
		return
	}

	if dto, ok := payload["last_post_author_ref"].(map[string]any); ok && dto != nil {
		accountName, _ := dto["display_name"].(string)
		dto["display_name"] = mask.Name
		dto["avatar_url"] = mask.AvatarURL
		dto["is_character"] = true
		dto["character_id"] = maskID
		if accountName != "" {
			dto["owner_name"] = accountName
		}
	}

	// The mask renames the LAST POSTER only. The unread dot and the reputation
	// stay the account's.
}

// decorateLastPostAuthor resolves the display fields into the nested
// `last_post_author_ref` DTO, for the category index whose payload names a
// last-post author but no topic author, and for topic-list rows whose nested
// DTO came from the stored variant and now needs the resolved display fields.
//
// It is the SINGLE place that builds the public last-post AuthorRef DTO, so
// the category index and the topic lists can never disagree about who spoke
// last. A guest last-poster resolves to {kind: guest, display_name}; a
// missing account resolves to explicit null; a soft-deleted account keeps its
// baked display name with deleted:true (no mask rename); an account keeps
// user_id/profile_id and the resolved (possibly mask-renamed) display name.
func decorateLastPostAuthor(app core.App, payload map[string]any, displays map[string]authorDisplay, masks map[string]characterDisplay) {
	// Try nested DTO first (from topicPayload), fall back to flat fields
	// (from category_access.go projection).
	id := ""
	dto, _ := payload["last_post_author_ref"].(map[string]any)
	if dto != nil {
		id, _ = dto["user_id"].(string)
	}
	if id == "" {
		id, _ = payload["last_post_author_id"].(string)
	}
	if id == "" {
		// Guest last-poster: the display name travels in last_post_author_name
		// (category index) or last_post_guest_nickname (topic lists); neither
		// invents an account.
		name := ""
		if dto != nil {
			name, _ = dto["display_name"].(string)
		}
		if name == "" {
			name, _ = payload["last_post_author_name"].(string)
		}
		if name == "" {
			name, _ = payload["last_post_guest_nickname"].(string)
		}
		if name == "" {
			name, _ = payload["last_post_guest_display_name"].(string)
		}
		if name == "" {
			payload["last_post_author_ref"] = nil
			return
		}
		var avatarVal any = nil
		if s := loadForumSettings(app); s.GuestAvatarURL != "" {
			avatarVal = s.GuestAvatarURL
		}
		if dto == nil {
			dto = map[string]any{
				"kind":         authorKindGuest,
				"user_id":      nil,
				"profile_id":   nil,
				"display_name": name,
				"character_id": nil,
				"is_character": false,
				"avatar_url":   avatarVal,
			}
			payload["last_post_author_ref"] = dto
		} else {
			dto["kind"] = authorKindGuest
			dto["display_name"] = name
			dto["is_character"] = false
			dto["avatar_url"] = avatarVal
		}
		return
	}
	display, ok := displays[id]
	if !ok {
		// Deleted account: leave the nested DTO's display_name/avatar_url null
		// so the reader renders the deleted-account placeholder.
		if dto == nil {
			dto = map[string]any{
				"kind":         authorKindAccount,
				"user_id":      id,
				"profile_id":   nil,
				"display_name": nil,
				"character_id": nil,
				"is_character": false,
				"avatar_url":   nil,
			}
			payload["last_post_author_ref"] = dto
		} else {
			dto["display_name"] = nil
			dto["avatar_url"] = nil
			dto["is_character"] = false
		}
		return
	}

	// Write the resolved display fields into the nested AuthorRef DTO.
	if dto == nil {
		dto = map[string]any{
			"kind":         authorKindAccount,
			"user_id":      id,
			"profile_id":   id,
			"display_name": nil,
			"character_id": nil,
			"is_character": false,
			"avatar_url":   nil,
		}
		payload["last_post_author_ref"] = dto
	}
	dto["display_name"] = display.Nickname
	dto["avatar_url"] = display.AvatarURL
	dto["is_character"] = false
	if display.IsDeleted {
		dto["deleted"] = true
	}

	// Character ID: prefer nested DTO, fall back to flat field.
	characterID, _ := dto["character_id"].(string)
	if characterID == "" {
		characterID, _ = payload["last_post_author_character_id"].(string)
	}
	if characterID != "" {
		dto["character_id"] = characterID
	}

	// The mask is baked, so it still renders (see decoratePostAuthor).
	applyLastPostMask(payload, id, masks)

	if display.IsDeleted {
		return
	}
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
