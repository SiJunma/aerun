package pocketbase

// Profile field editing (2026-10-02).
//
// Routes:
//
//	PATCH /api/aerun/me/profile
//	PATCH /api/aerun/users/{id}/profile
//
// WHY THIS EXISTS: the legacy profile form has always existed and always saved
// through the ADMIN endpoint (`PATCH /admin/users/{id}`). Against the Go
// backend that stopped working in two separate ways, and neither was visible
// from the UI:
//
//   - Editing YOUR OWN profile never reached the server at all. The provider
//     called `updateSettings` for the settings blob and then merged everything
//     else into local React state, so a changed status line, bio or nickname
//     looked saved and vanished on reload.
//   - Editing SOMEONE ELSE'S profile went to the admin route, which requires
//     `admin_access` and whose body only carries role and status. A moderator
//     editing a player's bio got a 403; an admin got a 200 that discarded every
//     field they had just submitted.
//
// So the form had no working save path at all. This command is that path.
//
// NICKNAME IS NOT HERE, DELIBERATELY. It has its own commands because renaming
// is audited with both the old and new value and is bounded by the RANK matrix —
// moderators may only rename strictly lower accounts. Folding it in here would
// have meant either losing the audit or duplicating the rule in two places.
//
// The biographical fields have no dedicated permission in the legacy matrix —
// they were always writable — so they follow the account-tab gate: your own
// profile, or somebody else's if you hold edit_others_statuses, which is the
// same key the legacy UI already used to decide whether the tab is editable.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const profileBodyBytes = 32 * 1024

// profileForm carries the writable profile columns. Every field is a POINTER so
// "absent" and "cleared to empty" are distinguishable: sending only `bio` must
// not wipe the location, and sending `"bio": ""` must clear it.
//
// `nickname` is absent from this struct on purpose — see the file header.
type profileForm struct {
	StatusLine *string `json:"status_line"`
	Bio        *string `json:"bio"`
	Location   *string `json:"location"`
	Birthday   *string `json:"birthday"`
	Occupation *string `json:"occupation"`
	Interests  *string `json:"interests"`
	Contacts   *string `json:"contacts"`
	// LastSelectedCharacterID is which mask the author posts as.
	//
	// It is NOT a profile field a member may see or staff may change, so it is
	// excluded from applyProfile's allowlist and accepted ONLY on the self path.
	// It needs a route of its own anyway: the legacy UI saved it through the
	// admin endpoint, which requires admin_access and only carries role and
	// status — so picking a character answered 403 for every ordinary member.
	// The Firestore rules allowed exactly this one key on a user's own record
	// (PROJECT_CONTEXT.md, users.allow update), which is why it exists.
	LastSelectedCharacterID *string `json:"last_selected_character_id"`
}

// profileFieldNames is the ALLOWLIST. Fields are applied by iterating this list
// rather than the decoded JSON, so a client cannot reach a column the form does
// not name by sending an extra key.
var profileFieldNames = []string{
	"status_line", "bio", "location", "birthday", "occupation", "interests", "contacts",
}

// profileFieldLengths mirrors the collection's own Max values, so a value that
// would fail at the database is refused with a readable message instead of a
// raw constraint error.
var profileFieldLengths = map[string]int{
	"status_line": 256,
	"bio":         4096,
	"location":    128,
	"birthday":    32,
	"occupation":  128,
	"interests":   512,
	"contacts":    512,
}

func applyProfile(record *core.Record, form profileForm) error {
	values := map[string]*string{
		"status_line": form.StatusLine,
		"bio":         form.Bio,
		"location":    form.Location,
		"birthday":    form.Birthday,
		"occupation":  form.Occupation,
		"interests":   form.Interests,
		"contacts":    form.Contacts,
	}
	for _, name := range profileFieldNames {
		value := values[name]
		if value == nil {
			continue
		}
		trimmed := strings.TrimSpace(*value)
		if len([]rune(trimmed)) > profileFieldLengths[name] {
			return validationError(name + " is too long")
		}
		record.Set(name, trimmed)
	}
	return nil
}

func decodeProfileForm(raw []byte) (profileForm, error) {
	var form profileForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return form, validationError("invalid JSON body")
	}
	return form, nil
}

func profileResponse(record *core.Record) map[string]any {
	payload := map[string]any{}
	for _, name := range profileFieldNames {
		payload[name] = record.GetString(name)
	}
	return payload
}

func updateMyProfileHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required for this action")
	}
	if e.Auth.Collection().Name != usersCollectionName {
		return forbiddenError("this endpoint serves forum accounts only")
	}

	acc := AccessFrom(e)
	if acc.Status == auth.StatusBanned {
		return forbiddenError("banned accounts cannot edit their profile")
	}
	if !auth.Has(acc.Permissions, auth.PermEditSelfProfile) {
		return forbiddenError("you are not allowed to edit your profile")
	}

	raw, err := readBodyLimited(e, profileBodyBytes)
	if err != nil {
		return err
	}
	form, err := decodeProfileForm(raw)
	if err != nil {
		return err
	}

	record := e.Auth
	if err := applyProfile(record, form); err != nil {
		return err
	}
	// Self-only, and deliberately OUTSIDE applyProfile so the staff path can
	// never set it: choosing a mask is the author's own business.
	if form.LastSelectedCharacterID != nil {
		record.Set("last_selected_character_id", strings.TrimSpace(*form.LastSelectedCharacterID))
	}
	if err := e.App.Save(record); err != nil {
		return internalError("failed to save the profile", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"profile":    profileResponse(record),
		"request_id": requestIDFrom(e),
	})
}

// updateUserProfileHandler edits another account's profile. Staff only, and
// subject to the same rank rule as renaming: a moderator may not edit a peer or
// anyone above, so staff authority cannot be aimed upward.
func updateUserProfileHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	targetID := e.Request.PathValue("id")
	acc := AccessFrom(e)

	// The biographical block is gated on `edit_others_profile`, NOT on
	// `edit_others_statuses` — that key names the one-line status under a
	// nickname, and reusing it here made the permission list say something the
	// code did not do.
	//
	// Default holder: admins only. Moderators have never held
	// edit_others_avatars, _statuses or _signatures either, so this keeps the
	// family consistent; a custom role can be granted the key per member.
	if !auth.Has(acc.Permissions, auth.PermEditOthersProfile) {
		return forbiddenError("you are not allowed to edit other members' profiles")
	}

	raw, err := readBodyLimited(e, profileBodyBytes)
	if err != nil {
		return err
	}
	form, err := decodeProfileForm(raw)
	if err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		target, err := txApp.FindRecordById(usersCollectionName, targetID)
		if err != nil || target == nil {
			return 0, nil, notFoundError("user not found")
		}
		if err := checkNicknameRank(txApp, acc.Role, auth.Role(target.GetString("role")), target.GetString("nickname")); err != nil {
			return 0, nil, err
		}
		if err := applyProfile(target, form); err != nil {
			return 0, nil, err
		}
		if err := txApp.Save(target); err != nil {
			return 0, nil, internalError("failed to save the profile", err)
		}
		_ = recordAuditLog(txApp, "profile_edit", e.Auth.Id, map[string]any{
			"target_id":   target.Id,
			"status_line": target.GetString("status_line"),
		})
		return http.StatusOK, map[string]any{
			"id":         target.Id,
			"profile":    profileResponse(target),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}
