package pocketbase

// Nickname changes (2026-10-02).
//
// Routes:
//
//	PATCH /api/aerun/me/nickname       — change your OWN nickname
//	PATCH /api/aerun/users/{id}/nickname — change somebody else's, staff only
//
// WHO MAY CHANGE WHOSE NICKNAME is a RANK rule, not a permission rule, and
// that distinction is the whole design:
//
//   - self:  anyone with `edit_self_nickname`.
//   - other: a moderator may edit a STRICTLY LOWER rank; an admin may edit
//     admins as well (equal rank is allowed, lower only); root may edit anyone
//     EXCEPT an account whose nickname is marked untouchable.
//
// The owner's rule, restated as code below. Two properties fall out of it and
// are enforced rather than assumed:
//
//   - A custom role INHERITS the rank of the role it derives from, so a
//     moderator-based custom role cannot edit a plain moderator (equal rank is
//     not "strictly lower"). That is intended, not an accident.
//   - root's own nickname is untouchable by everyone, including root. It is the
//     one identity a compromise must not be able to rename, because the name is
//     what members look for when deciding whether a message is genuine.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const (
	// nicknameBodyBytes bounds the request. The payload is one field; the limit
	// is generous rather than tight so a client sending extra fields is not
	// rejected for the wrong reason.
	nicknameBodyBytes = 8 * 1024

	// nicknameUntouchableNickname is the display form whose value no one may
	// change, not even root. Matching is on the NORMALISED key, so a
	// differently-cased spelling of the same name is equally protected.
	nicknameUntouchableNickname = "aerun"
)

type changeNicknameForm struct {
	Nickname string `json:"nickname"`
}

// changeMyNicknameHandler changes the caller's own nickname.
func changeMyNicknameHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication is required to change a nickname")
	}
	if e.Auth.Collection().Name != usersCollectionName {
		return forbiddenError("this endpoint serves forum accounts only")
	}

	acc := AccessFrom(e)
	if !auth.Has(acc.Permissions, auth.PermEditSelfNickname) {
		return forbiddenError("you are not allowed to change your own nickname")
	}

	nickname, err := readNicknameForm(e)
	if err != nil {
		return err
	}
	// Self-service obeys the same rank rule as everybody else: nobody rewrites
	// their own name into a protected one.
	if isUntouchableNickname(nickname) {
		return forbiddenError("this nickname is reserved and cannot be claimed")
	}

	return writeNickname(e, e.Auth.Id, nickname, acc.Role)
}

// changeUserNicknameHandler changes another account's nickname, staff only.
func changeUserNicknameHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	targetID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	if !auth.Has(acc.Permissions, auth.PermEditOthersNicknames) {
		return forbiddenError("you are not allowed to change other members' nicknames")
	}

	nickname, err := readNicknameForm(e)
	if err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		target, err := txApp.FindRecordById(usersCollectionName, targetID)
		if err != nil || target == nil {
			return 0, nil, notFoundError("user not found")
		}

		targetRole := auth.Role(target.GetString("role"))
		if err := checkNicknameRank(txApp, acc.Role, targetRole, target.GetString("nickname")); err != nil {
			return 0, nil, err
		}

		if err := applyNickname(txApp, target, nickname, e.Auth.Id, acc.Role); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"id":         target.Id,
			"nickname":   nickname,
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// rankFor resolves the authority rank of a role.
//
// The `roles` collection is the RUNTIME authority — the same source
// access.go already trusts for permissions — so a custom role's rank is the
// value stored on its row, not a value this function infers. `base_role_id`
// is deliberately NOT consulted to derive it: a custom role is free to hold any
// rank the operator gave it, and a helper that quietly overrode that would make
// the role's real authority unknowable.
//
// The compiled spec is the fallback for a role with no row, which is the shape
// a unit-level call has. An unresolvable role ranks 0, so an unknown role is
// treated as the least authority rather than the most.
func rankFor(txApp core.App, role auth.Role) int {
	if spec, ok := auth.SpecFor(role); ok {
		return spec.Rank
	}
	if txApp == nil {
		return 0
	}
	collection, err := txApp.FindCachedCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		return 0
	}
	records, err := txApp.FindAllRecords(collection, dbx.HashExp{"role_id": string(role)})
	if err != nil || len(records) != 1 {
		return 0
	}
	return records[0].GetInt("rank")
}

// checkNicknameRank is the authority rule, in one place.
//
//	moderator → strictly lower only (a peer moderator is out)
//	admin     → admins and everyone below (equal rank is allowed)
//	root      → anyone, except a protected nickname
//
// The three are the owner's matrix verbatim. A caller of lower rank than the
// target is refused in every case, and a caller of higher rank is refused for
// a moderator trying to reach up.
func checkNicknameRank(txApp core.App, actor auth.Role, target auth.Role, targetNickname string) error {
	if isUntouchableNickname(targetNickname) {
		return forbiddenError("this nickname is protected and cannot be changed")
	}

	// The MATRIX itself lives in checkStaffRank (staff_authority.go), shared with
	// the other staff-on-another-account commands. Only the WORDING is the
	// nickname's, because that is what the refusal is about.
	return checkStaffRank(txApp, actor, target, staffRankMessages{
		targetAbove: "you cannot change the nickname of a higher-ranked account",
		notLower:    "you can only change the nickname of a strictly lower-ranked account",
		notStaff:    "you are not allowed to change other members' nicknames",
	})
}

// isUntouchableNickname reports whether a nickname is protected. Matching is on
// the normalised key so a differently-cased or padded spelling cannot slip past.
func isUntouchableNickname(nickname string) bool {
	return auth.NormalizeNickname(nickname) == auth.NormalizeNickname(nicknameUntouchableNickname)
}

// readNicknameForm parses and validates the request body, returning the trimmed
// display form. Validation is auth.ValidateNickname (2..32 runes) plus the
// reserved-name check, which the caller applies because the self-service path
// must refuse claiming the protected name while the staff path must refuse
// writing it.
func readNicknameForm(e *core.RequestEvent) (string, error) {
	raw, err := readBodyLimited(e, nicknameBodyBytes)
	if err != nil {
		return "", err
	}
	var form changeNicknameForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return "", validationError("invalid JSON body")
	}
	nickname := strings.TrimSpace(form.Nickname)
	if err := auth.ValidateNickname(nickname); err != nil {
		return "", validationError(err.Error())
	}
	return nickname, nil
}

// applyNickname writes both the display form and its normalised key, then
// audits the change with BOTH values recorded.
//
// The audit carries the previous nickname on purpose: a rename is the one
// identity change that makes historic attribution harder to read, so the old
// value must survive in the ledger or the trail breaks. The self-service path
// is audited too — not because a member may not rename themselves, but because
// "who was this account called last week" is exactly the question a rename
// creates.
//
// The UNIQUE index on nickname_normalized is the real enforcement; the
// pre-check exists to turn the common case into a stable 409 message rather
// than a raw database error.
func applyNickname(txApp core.App, record *core.Record, nickname, actorID string, actorRole auth.Role) error {
	normalised := auth.NormalizeNickname(nickname)
	if normalised == record.GetString("nickname_normalized") {
		// Idempotent no-op. Saving anyway would bump `updated` and write a
		// duplicate audit row for a change that did not happen.
		return nil
	}

	if existing, err := txApp.FindFirstRecordByFilter(
		usersCollectionName,
		"nickname_normalized = {:nickname}",
		dbx.Params{"nickname": normalised},
	); err == nil && existing != nil && existing.Id != record.Id && !isUserDeleted(existing) {
		return conflictError("this nickname is already taken")
	}

	old := record.GetString("nickname")
	record.Set("nickname", nickname)
	record.Set("nickname_normalized", normalised)

	if err := txApp.Save(record); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return conflictError("this nickname is already taken")
		}
		return internalError("failed to save the new nickname", err)
	}

	return recordAuditLog(txApp, "nickname_change", actorID, map[string]any{
		"target_id":    record.Id,
		"old_nickname": old,
		"new_nickname": nickname,
		"actor_role":   string(actorRole),
		"by_author":    actorID == record.Id,
	})
}

// writeNickname is the self-service path's shared tail: it re-reads nothing
// (the caller already validated) and delegates to applyNickname in a command
// transaction so the rename and its audit row commit together or not at all.
func writeNickname(e *core.RequestEvent, targetID, nickname string, actorRole auth.Role) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		record, err := txApp.FindRecordById(usersCollectionName, targetID)
		if err != nil || record == nil {
			return 0, nil, notFoundError("user not found")
		}
		if err := applyNickname(txApp, record, nickname, e.Auth.Id, actorRole); err != nil {
			return 0, nil, err
		}
		return http.StatusOK, map[string]any{
			"id":         record.Id,
			"nickname":   nickname,
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
