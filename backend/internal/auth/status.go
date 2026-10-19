package auth

import "slices"

// Status is an account lifecycle state, separate from the role. The legacy
// application encoded "pending" and "banned" as role ids; the target
// contract keeps them as statuses so a banned moderator keeps its role and
// can be restored without guessing the previous role at import time.
type Status string

const (
	// StatusActive is a fully usable account.
	StatusActive Status = "active"
	// StatusPending is a registered account that staff have not approved
	// yet. Legacy pending users keep a narrow self-service permission set.
	StatusPending Status = "pending"
	// StatusBanned is an account stripped of every permission.
	StatusBanned Status = "banned"
	// StatusDeleted marks a soft-deleted account (see
	// markdowns/DONE_DELETED_USER_PROFILE_AND_POSTS_2026-10-18.md).
	//
	// A deleted account keeps its users row (nickname, avatar, counters stay
	// baked in for rendering), but it is out of circulation: NarrowForStatus
	// denies every permission for it, auth hooks refuse its sign-in, and the
	// command layer blocks votes/DMs/nickname claims against it.
	//
	// Deliberately NOT part of AllStatuses(): it is not an assignable
	// lifecycle state — only the admin delete command writes it (IsValid()
	// must keep refusing it in status forms). AllStatusValues() adds it back
	// for the two consumers that need to HOLD or FIND the value: the select
	// field schema and the admin status filter.
	StatusDeleted Status = "deleted"
)

// AllStatuses returns every known account status.
func AllStatuses() []Status {
	return []Status{StatusActive, StatusBanned, StatusPending}
}

// StatusValues maps statuses to their string values, keeping order.
func StatusValues(statuses []Status) []string {
	values := make([]string, len(statuses))
	for i, status := range statuses {
		values[i] = string(status)
	}
	return values
}

// AllStatusValues returns every status the COLUMN may store, ready for the
// select field (identity contract: the admin filter and the schema share it).
//
// It includes StatusDeleted, which is deliberately NOT in AllStatuses(): the
// soft-delete marker is written only by the admin delete command and must
// never be assignable through a status form (that would produce a half-deleted
// row with no is_deleted flag). Assignment validation therefore uses
// Status.IsValid(), which reads AllStatuses — while the select field and the
// admin status filter read this list, because both must be able to HOLD and
// FIND every value a row can legally carry.
func AllStatusValues() []string {
	return append(StatusValues(AllStatuses()), string(StatusDeleted))
}

// IsValid reports whether the status is one of the known values.
func (s Status) IsValid() bool {
	return slices.Contains(AllStatuses(), s)
}

// pendingAllowedPermissions mirrors the legacy MAX_ROLE_PERMISSIONS.pending
// set: while an account is unapproved it may only look at the public forum
// and edit its own presentation fields.
//
// PermEditSelfProfile is in this list on purpose: it gates the WHOLE
// PATCH /me/profile body (bio, location, birthday, status line), and the UI
// already exposes those fields to pending members — the OAuth registration
// flow saves a profile while the account is still pending. Without the key
// NarrowForStatus stripped the permission for every pending account and the
// save failed with 403 even though the role row granted it.
var pendingAllowedPermissions = []Permission{
	PermViewForum,
	PermEditSelfNickname,
	PermEditSelfAvatar,
	PermEditSelfStatus,
	PermEditSelfSignature,
	PermEditSelfProfile,
}

// NarrowForStatus narrows a role permission list according to the account
// status:
//
//   - active: permissions pass through unchanged;
//   - pending: only view_forum plus the self-edit permissions survive;
//   - banned (or any unknown status): everything is denied.
//
// The result is always a fresh slice; the input is never mutated.
func NarrowForStatus(perms []Permission, status Status) []Permission {
	switch status {
	case StatusActive:
		return slices.Clone(perms)
	case StatusPending:
		narrowed := make([]Permission, 0, len(perms))
		for _, perm := range perms {
			if slices.Contains(pendingAllowedPermissions, perm) {
				narrowed = append(narrowed, perm)
			}
		}
		return narrowed
	default:
		// StatusBanned and unknown statuses deny everything.
		return []Permission{}
	}
}
