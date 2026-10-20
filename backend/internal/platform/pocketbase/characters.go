package pocketbase

// Characters domain API — the runtime counterpart of the `characters`
// collection.
//
// The collection has existed since migration 1766600000 and the importer fills
// it (character_import.go), but it had NO runtime API at all. The frontend read
// and wrote `users.settings.characters` instead — the pre-migration fold that
// ADR-5 retracted. That left two consequences, both real:
//
//   - characters a user created through the UI never reached the collection the
//     importer writes, so they were invisible to every server-side read and lost
//     on import;
//   - characters the importer DID write were uneditable and undeletable.
//
// So this file replaces the fold with the collection as the single store
// (ADR-5). settings.characters is no longer read or written anywhere: the
// settings command stays permissive on purpose (an imported row may still carry
// the key until the next profile save overwrites the object), so a stale copy
// there is inert rather than authoritative.
//
// Visibility does not depend on the account status: an owner's characters are
// readable by anybody, suspended owner included. A ban limits what the banned
// account may DO; it does not unpublish what it wrote. See canReadCharactersOf.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	characterBodyLimit    = 16 * 1024
	characterNameMaxLen   = 64
	characterStatusMaxLen = 256
	characterSignMaxLen   = 1024
)

// characterPayload is the public shape. avatar_url is the host-agnostic
// /api/files path the frontend resolves with resolveAvatarUrl, exactly like the
// user avatar.
func characterPayload(r *core.Record) map[string]any {
	return map[string]any{
		"id":          r.Id,
		"owner_id":    r.GetString("owner_id"),
		"name":        r.GetString("name"),
		"status_line": r.GetString("status_line"),
		"signature":   r.GetString("signature"),
		"avatar_url":  r.GetString(avatarURLFieldName),
		"created":     r.GetDateTime("created_at").String(),
		"updated":     r.GetDateTime("updated_at").String(),
	}
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// listUserCharactersHandler serves GET /api/aerun/users/{id}/characters.
func listUserCharactersHandler(e *core.RequestEvent) error {
	ownerID := strings.TrimSpace(e.Request.PathValue("id"))
	if ownerID == "" {
		return validationError("user identifier is required")
	}

	visible, err := canReadCharactersOf(e, ownerID)
	if err != nil || !visible {
		return notFoundError("characters not found")
	}

	records, err := e.App.FindRecordsByFilter(
		charactersCollectionName,
		"owner_id = {:owner}",
		"created_at",
		0,
		0,
		dbx.Params{"owner": ownerID},
	)
	if err != nil {
		return internalError("failed to query characters", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		items = append(items, characterPayload(r))
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"owner_id":   ownerID,
		"request_id": requestIDFrom(e),
	})
}

// getCharacterHandler serves GET /api/aerun/characters/{id}.
func getCharacterHandler(e *core.RequestEvent) error {
	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	rec, err := e.App.FindRecordById(charactersCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("character not found")
	}

	visible, err := canReadCharactersOf(e, rec.GetString("owner_id"))
	if err != nil || !visible {
		return notFoundError("character not found")
	}

	return e.JSON(http.StatusOK, characterPayload(rec))
}

// canReadCharactersOf reports whether the caller may read this owner's
// characters.
//
// Visibility does NOT depend on the account status. A suspension limits what the
// suspended account may DO; it does not make the account disappear from the
// forum. The previous rule here mirrored the users ViewRule
// (`status = "active" || id = @request.auth.id`), which meant that banning
// somebody also unpublished their profile: the admin screen came back 404, the
// Characters tab read "none yet", and every reader lost the record of what the
// account had written. Nothing about the product wants that — an operator bans
// an account precisely so they can go on reading it.
//
// So the only question left is whether the owner exists.
func canReadCharactersOf(e *core.RequestEvent, ownerID string) (bool, error) {
	owner, err := e.App.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return false, nil
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

type characterForm struct {
	Name       string `json:"name"`
	StatusLine string `json:"status_line"`
	Signature  string `json:"signature"`
}

// characterFormFields holds the three writable text fields of a mask.
type characterFormFields struct {
	Name       string
	StatusLine string
	Signature  string
}

// readCharacterForm parses and validates the body of a mask command.
//
// It is shared by the self-service and the staff command so the two cannot
// drift on what a valid mask is: a name nobody may use is a name nobody may
// use.
func readCharacterForm(e *core.RequestEvent) (characterFormFields, error) {
	raw, err := readBodyLimited(e, characterBodyLimit)
	if err != nil {
		return characterFormFields{}, err
	}
	var form characterForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return characterFormFields{}, validationError("malformed character payload")
	}

	fields := characterFormFields{
		Name:       strings.TrimSpace(form.Name),
		StatusLine: strings.TrimSpace(form.StatusLine),
		Signature:  strings.TrimSpace(form.Signature),
	}
	if fields.Name == "" || len(fields.Name) > characterNameMaxLen {
		return characterFormFields{}, validationError("character name is required and must not exceed 64 characters")
	}
	if len(fields.StatusLine) > characterStatusMaxLen {
		return characterFormFields{}, validationError("status_line must not exceed 256 characters")
	}
	if len(fields.Signature) > characterSignMaxLen {
		return characterFormFields{}, validationError("signature must not exceed 1024 characters")
	}
	return fields, nil
}

// createCharacterFor writes a mask owned by ownerID.
//
// The owner is NEVER taken from the request body: it is either the caller
// (self-service) or the account named in the path (staff), and the caller has
// already been authorised for that account by the route that got here.
//
// The CAP is the OWNER's, too. A mask counts against the quota of the
// account it belongs to, so an admin creating a mask for a player is charged
// to the PLAYER's limit. Charging it to the actor is what produced "character
// limit reached for your role" on an account the admin never touched.
//
// `limitSubject` says whose quota ran out (limitSubjectSelf /
// limitSubjectOwner), so the refusal says whose limit was hit.
func createCharacterFor(txApp core.App, ownerID string, fields characterFormFields, limitSubject string) (*core.Record, error) {
	limit, err := characterLimitFor(txApp, ownerID)
	if err != nil {
		return nil, err
	}

	// Counted INSIDE the transaction: two concurrent creates would both pass
	// a check made before it, and this is the only place the cap can be
	// enforced honestly.
	count, err := txApp.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": ownerID})
	if err != nil {
		return nil, internalError("failed to count characters", err)
	}
	if count >= int64(limit) {
		// The message names the NUMBER, because the cap is now an admin-set
		// forum-wide value and "character limit reached" alone leaves the
		// member guessing what the limit is. The subject still says whose
		// quota ran out — the caller's or the owner's.
		return nil, characterLimitError(limit, limitSubject)
	}

	col, err := txApp.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		return nil, internalError("characters collection unavailable", err)
	}

	rec := core.NewRecord(col)
	rec.Set("owner_id", ownerID)
	rec.Set("name", fields.Name)
	rec.Set("status_line", fields.StatusLine)
	rec.Set("signature", fields.Signature)
	rec.Set(avatarURLFieldName, "")
	if err := txApp.Save(rec); err != nil {
		return nil, internalError("failed to create character", err)
	}
	return rec, nil
}

// createCharacterHandler serves POST /api/aerun/me/characters.
//
// Banned accounts are refused; pending ones keep the legacy self-service right
// (they can present themselves, so they can build the mask they present with).
func createCharacterHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if err := requireCharacterAuthor(e); err != nil {
		return err
	}
	if err := requireCharactersEnabled(e); err != nil {
		return err
	}

	fields, err := readCharacterForm(e)
	if err != nil {
		return err
	}

	ownerID := e.Auth.Id

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := createCharacterFor(txApp, ownerID, fields, limitSubjectSelf)
		if err != nil {
			return 0, nil, err
		}

		if err := recordAuditLog(txApp, "character_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"owner_id":  ownerID,
			"name":      fields.Name,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusCreated, characterPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// createUserCharacterHandler serves POST /api/aerun/users/{id}/characters.
//
// It is the staff half of the mask command: the mask belongs to the account
// named in the path, not to the caller.
//
// The legacy Firestore rules allowed exactly this — "allow create: if
// (isActive() && isOwner(userId)) || isAdmin()" — and the legacy permission
// registry carries create_others_mask for it, granted to moderators and admins.
// The modern command layer had only the self-service route, so an admin
// creating a mask for somebody else had nowhere to put it.
//
// Two rules, and the second is the one the bug report was about:
//
//   - WHO MAY: the caller needs create_others_mask, and the owner's rank
//     decides how far down the hierarchy they may reach — the same matrix the
//     nickname and profile commands use, so staff authority cannot be aimed
//     upward.
//   - WHOSE LIMIT: the cap belongs to the OWNER (see createCharacterFor), not
//     to the actor.
//
// Creating a mask for oneself through this route is the self-service command
// wearing a different address, so it is allowed and charged to the caller's own
// limit; the client picks the address, not the rules.
func createUserCharacterHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if err := requireCharacterAuthor(e); err != nil {
		return err
	}
	if err := requireCharactersEnabled(e); err != nil {
		return err
	}

	ownerID := strings.TrimSpace(e.Request.PathValue("id"))
	if ownerID == "" {
		return validationError("user identifier is required")
	}

	fields, err := readCharacterForm(e)
	if err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		owner, err := txApp.FindRecordById(usersCollectionName, ownerID)
		if err != nil || owner == nil {
			return 0, nil, notFoundError("user not found")
		}
		if isUserDeleted(owner) {
			return 0, nil, forbiddenError("this account has been deleted; it cannot hold a mask")
		}

		limitSubject := limitSubjectOwner
		if ownerID != e.Auth.Id {
			acc := AccessFrom(e)
			if !auth.Has(acc.Permissions, auth.PermCreateOthersMask) {
				return 0, nil, forbiddenError("you are not allowed to create masks for other members")
			}
			if err := checkStaffRank(txApp, acc.Role, auth.Role(owner.GetString("role")), staffRankMessages{
				targetAbove: "you cannot create a mask for a higher-ranked account",
				notLower:    "you can only create a mask for a strictly lower-ranked account",
				notStaff:    "you are not allowed to create masks for other members",
			}); err != nil {
				return 0, nil, err
			}
		} else {
			limitSubject = limitSubjectSelf
		}

		rec, err := createCharacterFor(txApp, ownerID, fields, limitSubject)
		if err != nil {
			return 0, nil, err
		}

		if err := recordAuditLog(txApp, "character_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"owner_id":  ownerID,
			"name":      fields.Name,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusCreated, characterPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// characterOwnerAccess answers whether the caller may write a character owned
// by ownerID.
//
// The OWNER always may — that is the whole of self-service. A staff member may
// act on somebody else's mask when they hold `permission` (the registry's
// edit_others_mask / delete_others_mask) AND the owner's rank is reachable
// under the same matrix the nickname and profile commands use. Both halves
// are needed: the permission alone would let a moderator rewrite an admin's
// masks.
//
// The legacy Firestore rules allowed the admin to manage ANYBODY's characters
// ("allow update: if isAdmin()"), and the profile editor still gates these
// buttons on the `_others_mask` keys, so the capability is a promise the UI
// makes and the command layer has to keep.
//
// `denied` is the refusal for a caller who does not hold the permission, and
// `msgs` the rank matrix's three refusals. They are worded per action because
// they name what was attempted.
func characterOwnerAccess(txApp core.App, e *core.RequestEvent, ownerID string, permission auth.Permission, denied string, msgs staffRankMessages) error {
	if ownerID == e.Auth.Id {
		return nil
	}

	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, permission) {
		return forbiddenError(denied)
	}

	owner, err := txApp.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return notFoundError("character owner not found")
	}
	return checkStaffRank(txApp, acc.Role, auth.Role(owner.GetString("role")), msgs)
}

// maskIsBaked reports whether this mask is frozen WITH the posts that used it.
//
// A mask of a soft-deleted account is baked when posts still reference it:
// the account cannot change the mask any more, and staff must not either —
// renaming it would rewrite the published posts retroactively, so the message
// would end up saying something its author never wrote under that name.
//
// A mask of a deleted account that NO post references is not baked: nothing
// displays it, so nothing can be rewritten, and freezing it would strand the
// row forever — the owner is gone and staff could not clean it up.
func maskIsBaked(txApp core.App, maskID string, ownerID string) (bool, error) {
	owner, err := txApp.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return false, nil
	}
	if !isUserDeleted(owner) {
		return false, nil
	}
	if !postsHaveAuthorCharacter(txApp) {
		return false, nil
	}
	used, err := txApp.CountRecords(postsCollectionName, dbx.HashExp{
		"author_character_id": maskID,
	})
	if err != nil {
		return false, internalError("failed to count character references", err)
	}
	return used > 0, nil
}

// requireMaskNotFrozen refuses a write to a mask that is baked with the posts
// that used it.
//
// The refusal names the reason, because "you may not do this" without a
// reason is indistinguishable from a permissions problem the admin could fix
// by granting something.
func requireMaskNotFrozen(txApp core.App, maskID string, ownerID string) error {
	baked, err := maskIsBaked(txApp, maskID, ownerID)
	if err != nil {
		return err
	}
	if baked {
		return forbiddenError("this mask is baked into the posts that used it and can no longer be changed")
	}
	return nil
}

// updateCharacterHandler serves PATCH /api/aerun/characters/{id}.
//
// The owner may always edit their own mask; a staff member holding
// edit_others_mask may edit another account's mask, subject to the rank matrix
// (see characterOwnerAccess).
func updateCharacterHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if err := requireCharacterAuthor(e); err != nil {
		return err
	}
	if err := requireCharactersEnabled(e); err != nil {
		return err
	}

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	raw, err := readBodyLimited(e, characterBodyLimit)
	if err != nil {
		return err
	}
	var form characterForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed character payload")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(charactersCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("character not found")
		}
		if err := characterOwnerAccess(txApp, e, rec.GetString("owner_id"), auth.PermEditOthersMask,
			"you are not allowed to change other members' masks",
			staffRankMessages{
				targetAbove: "you cannot change the mask of a higher-ranked account",
				notLower:    "you can only change the mask of a strictly lower-ranked account",
				notStaff:    "you are not allowed to change other members' masks",
			}); err != nil {
			return 0, nil, err
		}
		// A mask baked into published posts cannot be renamed: the posts
		// would start saying something their author never wrote.
		if err := requireMaskNotFrozen(txApp, rec.Id, rec.GetString("owner_id")); err != nil {
			return 0, nil, err
		}

		// An omitted field is left alone: this is a PATCH, and "name omitted"
		// must not blank the name.
		if form.Name != "" {
			name := strings.TrimSpace(form.Name)
			if len(name) > characterNameMaxLen {
				return 0, nil, validationError("character name must not exceed 64 characters")
			}
			rec.Set("name", name)
		}
		if form.StatusLine != "" {
			statusLine := strings.TrimSpace(form.StatusLine)
			if len(statusLine) > characterStatusMaxLen {
				return 0, nil, validationError("status_line must not exceed 256 characters")
			}
			rec.Set("status_line", statusLine)
		}
		if form.Signature != "" {
			signature := strings.TrimSpace(form.Signature)
			if len(signature) > characterSignMaxLen {
				return 0, nil, validationError("signature must not exceed 1024 characters")
			}
			rec.Set("signature", signature)
		}

		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to update character", err)
		}

		if err := recordAuditLog(txApp, "character_updated", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"owner_id":  rec.GetString("owner_id"),
			"name":      rec.GetString("name"),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, characterPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// deleteCharacterHandler serves DELETE /api/aerun/characters/{id}.
//
// The owner may always delete their own mask; a staff member holding
// delete_others_mask may delete another account's, subject to the rank matrix
// (see characterOwnerAccess).
//
// A character still referenced by a post, or selected as its owner's current
// mask, is refused with 409 rather than deleted: the legacy UI only ever deleted
// unused masks, and a post that freezes a deleted mask's display identity would
// render a dangling author forever.
func deleteCharacterHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if err := requireCharacterAuthor(e); err != nil {
		return err
	}
	if err := requireCharactersEnabled(e); err != nil {
		return err
	}

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(charactersCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("character not found")
		}
		if err := characterOwnerAccess(txApp, e, rec.GetString("owner_id"), auth.PermDeleteOthersMask,
			"you are not allowed to delete other members' masks",
			staffRankMessages{
				targetAbove: "you cannot delete the mask of a higher-ranked account",
				notLower:    "you can only delete the mask of a strictly lower-ranked account",
				notStaff:    "you are not allowed to delete other members' masks",
			}); err != nil {
			return 0, nil, err
		}

		// The post reference column arrives with the TASK-6 post writer (the
		// frozen display identity), so the check is guarded by the schema rather
		// than assumed: querying a column that does not exist would make every
		// delete fail with a 500 until the importer lands.
		if postsHaveAuthorCharacter(txApp) {
			used, err := txApp.CountRecords(postsCollectionName, dbx.HashExp{
				"author_character_id": rec.Id,
			})
			if err != nil {
				return 0, nil, internalError("failed to count character references", err)
			}
			if used > 0 {
				return 0, nil, conflictError("this character is used by posts and cannot be deleted")
			}
		}

		// The "current mask" pointer belongs to the mask's OWNER, not to
		// whoever asked for the delete: a staff member removing a mask that the
		// owner has selected must leave that selection intact, or the owner's
		// profile would point at a row that no longer exists.
		ownerID := rec.GetString("owner_id")
		owner, err := txApp.FindRecordById(usersCollectionName, ownerID)
		if err == nil && owner != nil && owner.GetString("last_selected_character_id") == rec.Id {
			return 0, nil, conflictError("this character is selected as your current mask")
		}

		targetID := rec.Id
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete character", err)
		}

		if err := recordAuditLog(txApp, "character_deleted", e.Auth.Id, map[string]any{
			"target_id": targetID,
			"owner_id":  ownerID,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{"ok": true, "target_id": targetID}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// uploadCharacterAvatarHandler serves PUT /api/aerun/characters/{id}/avatar.
//
// Pattern-identical to uploadMyAvatarHandler, including the documented
// deviation from plan invariant 6: NOT bound to enforceIdempotency, because that
// middleware buffers the body and caps it at 512 KB while this is a multipart
// upload. The command is a replace, so a retry converges (ADR-4).
func uploadCharacterAvatarHandler(e *core.RequestEvent) error {
	if err := requireCharacterAuthor(e); err != nil {
		return err
	}
	if err := requireCharactersEnabled(e); err != nil {
		return err
	}

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	rec, err := e.App.FindRecordById(charactersCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("character not found")
	}
	// The avatar belongs to the mask, so the SAME rule as the text fields
	// applies: the owner may always change it, and a staff member holding
	// edit_others_mask may change another account's, subject to the rank
	// matrix. This handler runs outside a transaction (see the note below), so
	// the check is made directly rather than through the command closure.
	if err := characterOwnerAccess(e.App, e, rec.GetString("owner_id"), auth.PermEditOthersMask,
		"you are not allowed to change other members' masks",
		staffRankMessages{
			targetAbove: "you cannot change the mask of a higher-ranked account",
			notLower:    "you can only change the mask of a strictly lower-ranked account",
			notStaff:    "you are not allowed to change other members' masks",
		}); err != nil {
		return err
	}

	// A baked mask's avatar is part of what the published posts show, so it
	// is frozen with the rest of it.
	if err := requireMaskNotFrozen(e.App, rec.Id, rec.GetString("owner_id")); err != nil {
		return err
	}

	avatarURL, err := storeOwnedAvatar(e, rec, avatarFieldName)
	if err != nil {
		return err
	}

	// Outside a runCommand transaction on purpose: a multipart upload cannot be
	// wrapped by the idempotency envelope (see the ADR-4 note above), and
	// wrapping it in a transaction would hold the SQLite write lock for the
	// whole body read. The audit row is therefore best-effort and logged: the
	// file is already stored, so failing the request would report a broken
	// upload that actually succeeded.
	if err := recordAuditLog(e.App, "character_avatar_changed", e.Auth.Id, map[string]any{
		"target_id": rec.Id,
		"owner_id":  rec.GetString("owner_id"),
	}); err != nil {
		e.App.Logger().Warn("character_avatar_changed audit row failed", "error", err, "character", rec.Id)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"avatar_url": avatarURL,
		"request_id": requestIDFrom(e),
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// requireCharacterAuthor rejects unauthenticated and non-forum callers. The
// per-record ownership check stays in each handler, because a character may
// belong to somebody else even when the caller is a valid account.
func requireCharacterAuthor(e *core.RequestEvent) error {
	if e.Auth == nil {
		return router.NewUnauthorizedError("authentication is required for this action", nil)
	}
	if e.Auth.Collection().Name != usersCollectionName {
		return router.NewForbiddenError("this endpoint serves forum accounts only", nil)
	}
	if AccessFrom(e).Status == auth.StatusBanned {
		return router.NewForbiddenError("banned accounts cannot manage characters", nil)
	}
	return nil
}

// requireCharactersEnabled refuses mask WRITES while the forum's mask system is
// switched off.
//
// WHY A SERVER GUARD AND NOT ONLY A HIDDEN BUTTON. The admin panel's
// "Enable Characters" switch was decorative: it was stored, published in the
// public settings snapshot, and read by nobody. A control a client can omit
// is not a control — the same reasoning 1768800000 applied to the settings
// that used to live in each browser's localStorage.
//
// READING STAYS ALLOWED, and that is a deliberate asymmetry. Posts and topics
// carry `author_character_id`, so a message already published under a mask
// names it; refusing to read the mask would strip the author's name from
// every post they ever wrote under it. Switching the system off therefore
// means "no new masks, no new mask edits, no posting under a mask" — not
// "erase what already exists".
func requireCharactersEnabled(e *core.RequestEvent) error {
	if loadForumSettings(e.App).EnableCharacters {
		return nil
	}
	return forbiddenError("the character system is disabled on this forum")
}

// postsHaveAuthorCharacter reports whether the posts collection already carries
// the frozen display identity reference. It arrives with the TASK-6 post
// writer, so the delete guard asks the schema instead of assuming: a hard-coded
// reference would turn every character delete into a 500 until the importer
// lands, which is a regression shipped to make a future feature possible.
func postsHaveAuthorCharacter(app core.App) bool {
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil || col == nil {
		return false
	}
	return col.Fields.GetByName("author_character_id") != nil
}

// characterLimitFor resolves the effective mask cap for one account.
//
// TWO SOURCES, AND THE ROLE WINS.
//
// The ROLE's own `max_characters_limit` is the more specific statement, so it
// takes priority: a role that says 3 means 3, even when the forum-wide
// setting says 10. This is the owner's ruling (2026-10-19) — a role exists
// precisely to say something different about its members.
//
// The FORUM-WIDE setting (`forum_settings.max_characters_per_user`, the admin
// panel's "Max Masks per User") is the FALLBACK: it applies to every role
// that states nothing, and it is what a brand-new role inherits.
//
// A missing or ambiguous role row therefore degrades to the forum-wide
// setting — an unresolvable role must not hand out unlimited writes, and it
// must not be read as "no masks allowed" either.
func characterLimitFor(app core.App, ownerID string) (int, error) {
	forumLimit := loadForumSettings(app).MaxCharactersPerUser

	owner, err := app.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return 0, internalError("owner account not found", err)
	}

	roleID := owner.GetString("role")
	if roleID == "" {
		return forumLimit, nil
	}

	record, err := app.FindFirstRecordByFilter(
		rolesCollectionName,
		"role_id = {:rid}",
		dbx.Params{"rid": roleID},
	)
	if err != nil || record == nil {
		return forumLimit, nil
	}
	// 0 means "this role has no opinion" — it inherits the forum-wide setting.
	// A number is the role's own limit and wins over it, up to the same
	// ceiling the forum-wide value is bound by.
	if roleLimit := record.GetInt("max_characters_limit"); roleLimit > 0 {
		return auth.ClampMaxCharactersPerUser(roleLimit), nil
	}
	return forumLimit, nil
}
