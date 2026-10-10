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

// AllStatusValues returns every account status as plain strings (sorted),
// ready for select fields.
func AllStatusValues() []string {
	return StatusValues(AllStatuses())
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
