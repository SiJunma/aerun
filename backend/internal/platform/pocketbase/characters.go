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

	// defaultCharacterLimit is the compiled fallback used when the owner's role
	// carries no explicit max_characters_limit.
	//
	// TASK-3 required checking the legacy default first
	// (src/constants/permissions.js / the legacy profile character UI). There
	// is none: the legacy UI never counted characters at all — it only checked
	// CREATE_SELF_MASK before showing the "add" button, and PROJECT_SPEC.md §278
	// defers the limit entirely to roles.max_characters_limit. Rather than
	// invent a number that silently caps people below the limit they had, the
	// fallback is the smallest value that still enforces the documented rule
	// ("the cap is a real number, not an absent concept"), and it is recorded in
	// the plan so the product can change it in one place.
	defaultCharacterLimit = 3
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

	raw, err := readBodyLimited(e, characterBodyLimit)
	if err != nil {
		return err
	}
	var form characterForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("malformed character payload")
	}

	name := strings.TrimSpace(form.Name)
	if name == "" || len(name) > characterNameMaxLen {
		return validationError("character name is required and must not exceed 64 characters")
	}
	statusLine := strings.TrimSpace(form.StatusLine)
	if len(statusLine) > characterStatusMaxLen {
		return validationError("status_line must not exceed 256 characters")
	}
	signature := strings.TrimSpace(form.Signature)
	if len(signature) > characterSignMaxLen {
		return validationError("signature must not exceed 1024 characters")
	}

	ownerID := e.Auth.Id

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		limit, err := characterLimitFor(txApp, ownerID)
		if err != nil {
			return 0, nil, err
		}

		// Counted INSIDE the transaction: two concurrent creates would both pass
		// a check made before it, and this is the only place the cap can be
		// enforced honestly.
		count, err := txApp.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": ownerID})
		if err != nil {
			return 0, nil, internalError("failed to count characters", err)
		}
		if count >= int64(limit) {
			return 0, nil, conflictError("character limit reached for your role")
		}

		col, err := txApp.FindCollectionByNameOrId(charactersCollectionName)
		if err != nil {
			return 0, nil, internalError("characters collection unavailable", err)
		}

		rec := core.NewRecord(col)
		rec.Set("owner_id", ownerID)
		rec.Set("name", name)
		rec.Set("status_line", statusLine)
		rec.Set("signature", signature)
		rec.Set(avatarURLFieldName, "")
		if err := txApp.Save(rec); err != nil {
			return 0, nil, internalError("failed to create character", err)
		}

		if err := recordAuditLog(txApp, "character_created", e.Auth.Id, map[string]any{
			"target_id": rec.Id,
			"owner_id":  ownerID,
			"name":      name,
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusCreated, characterPayload(rec), nil
	})
	return writeCommandResult(e, outcome, err)
}

// updateCharacterHandler serves PATCH /api/aerun/characters/{id} (owner only).
func updateCharacterHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if err := requireCharacterAuthor(e); err != nil {
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

	actorID := e.Auth.Id

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(charactersCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("character not found")
		}
		if rec.GetString("owner_id") != actorID {
			return 0, nil, forbiddenError("you can only change your own characters")
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

// deleteCharacterHandler serves DELETE /api/aerun/characters/{id} (owner only).
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

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	actorID := e.Auth.Id

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		rec, err := txApp.FindRecordById(charactersCollectionName, id)
		if err != nil || rec == nil {
			return 0, nil, notFoundError("character not found")
		}
		if rec.GetString("owner_id") != actorID {
			return 0, nil, forbiddenError("you can only delete your own characters")
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

		owner, err := txApp.FindRecordById(usersCollectionName, actorID)
		if err == nil && owner != nil && owner.GetString("last_selected_character_id") == rec.Id {
			return 0, nil, conflictError("this character is selected as your current mask")
		}

		targetID := rec.Id
		if err := txApp.Delete(rec); err != nil {
			return 0, nil, internalError("failed to delete character", err)
		}

		if err := recordAuditLog(txApp, "character_deleted", e.Auth.Id, map[string]any{
			"target_id": targetID,
			"owner_id":  actorID,
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

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("character identifier is required")
	}

	rec, err := e.App.FindRecordById(charactersCollectionName, id)
	if err != nil || rec == nil {
		return notFoundError("character not found")
	}
	if rec.GetString("owner_id") != e.Auth.Id {
		return forbiddenError("you can only change your own characters")
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

// characterLimitFor resolves the per-user mask cap: the owner's role row limit
// when it is greater than zero, otherwise the compiled default. A missing or
// ambiguous role row degrades to the default rather than to "unlimited" — an
// unresolvable role must not hand out unlimited writes.
func characterLimitFor(app core.App, ownerID string) (int, error) {
	owner, err := app.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return 0, internalError("owner account not found", err)
	}

	roleID := owner.GetString("role")
	if roleID == "" {
		return defaultCharacterLimit, nil
	}

	record, err := app.FindFirstRecordByFilter(
		rolesCollectionName,
		"role_id = {:rid}",
		dbx.Params{"rid": roleID},
	)
	if err != nil || record == nil {
		return defaultCharacterLimit, nil
	}
	if limit := record.GetInt("max_characters_limit"); limit > 0 {
		return limit, nil
	}
	return defaultCharacterLimit, nil
}
