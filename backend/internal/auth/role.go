package auth

import "slices"

// Role identifies a forum role. The values are a wire and migration contract
// with the legacy data: role ids "root", "admin", "moderator", "player",
// "spectator" and "guest" exist in the exported Firestore documents.
//
// The legacy pseudo-roles "pending" and "banned" are intentionally absent:
// in the target contract they are account statuses (see Status), not roles.
type Role string

const (
	RoleRoot      Role = "root"
	RoleAdmin     Role = "admin"
	RoleModerator Role = "moderator"
	RolePlayer    Role = "player"
	RoleSpectator Role = "spectator"
	RoleGuest     Role = "guest"
)

// RoleSpec is the canonical definition of a system role: display name,
// authority rank, UI color and the default permission set.
//
// The roles collection is seeded from these specs at migration time and is
// the runtime authority for role permissions; the specs here are the
// bootstrap defaults and the reconciliation reference (a migration test
// asserts the seeded rows match them).
type RoleSpec struct {
	Role Role
	// Name is the human-readable role name shown in the UI.
	Name string
	// Rank orders roles by authority; higher means more authority.
	// Guests rank below every interactive role, root above everyone.
	Rank int
	// Color is the legacy bootstrap color token used by the UI.
	Color string
	// IsSystem marks immutable system roles (all current roles).
	IsSystem bool
	// Permissions is the default permission set granted while the account
	// status is active. Statuses narrow it further (see NarrowForStatus).
	Permissions []Permission
}

var roleSpecs = []RoleSpec{
	{
		Role:        RoleRoot,
		Name:        "Chief Admin",
		Rank:        1000,
		Color:       "danger",
		IsSystem:    true,
		Permissions: AllPermissions(),
	},
	{
		Role:        RoleAdmin,
		Name:        "Administrator",
		Rank:        800,
		Color:       "danger",
		IsSystem:    true,
		Permissions: AllPermissions(),
	},
	{
		Role:     RoleModerator,
		Name:     "Moderator",
		Rank:     600,
		Color:    "info",
		IsSystem: true,
		// A moderator keeps the full set `moderate_content` used to imply, so
		// nothing is lost in the split — every action the umbrella key gated is
		// still gated, now by its own key.
		//
		// EXCEPT `delete_others_topics`, which is deliberately absent: the owner
		// ruled that a moderator does not delete another account's topic. They
		// keep `delete_others_posts` (removing an individual reply is a normal
		// moderation act) and they keep `edit_others_topics`.
		//
		// The consequence is enforced in deleteTopicHandler, not here: a
		// moderator may remove their OWN topic only while it still holds just
		// their opening post. Once somebody has replied, deleting the topic
		// would destroy their post, which is exactly the loss of other people's
		// content that removing the key is meant to prevent.
		Permissions: []Permission{
			PermBypassHideTags,
			PermCloseTopics,
			PermCreateOthersMask,
			PermCreateSelfMask,
			PermCreateTopic,
			PermDeleteOthersMask,
			PermDeleteOthersPosts,
			PermDeleteSelfMask,
			PermDeleteSelfPost,
			PermDeleteSelfTopic,
			PermEditOthersMask,
			// The owner ranks a moderator as able to edit profile fields of
			// STRICTLY LOWER accounts only, so `edit_others_nicknames` is
			// required for the nickname matrix to be reachable at all. The rank
			// restriction that actually bounds it is not expressible as a
			// permission and is enforced in the handler.
			PermEditOthersNicknames,
			PermEditOthersPosts,
			PermEditOthersTopics,
			PermEditSelfAvatar,
			PermEditSelfNickname,
			PermEditSelfPost,
			PermEditSelfProfile,
			PermEditSelfSignature,
			PermEditSelfStatus,
			PermEditSelfTopic,
			PermModerateContent,
			PermMoveTopics,
			PermPinTopics,
			PermPostReply,
			PermUseDice,
			PermUseMasks,
			PermUseReputation,
			PermViewAuditLog,
			PermViewForum,
			PermViewMasterDice,
		},
	},
	{
		Role:     RolePlayer,
		Name:     "Player",
		Rank:     400,
		Color:    "primary",
		IsSystem: true,
		Permissions: []Permission{
			PermCreateSelfMask,
			PermCreateTopic,
			PermDeleteSelfMask,
			PermDeleteSelfPost,
			PermDeleteSelfTopic,
			PermEditSelfAvatar,
			PermEditSelfNickname,
			PermEditSelfPost,
			PermEditSelfProfile,
			PermEditSelfSignature,
			PermEditSelfStatus,
			PermEditSelfTopic,
			PermPostReply,
			PermUseDice,
			PermUseDirectMessages,
			PermUseMasks,
			PermUseReputation,
			PermViewForum,
			PermViewMasterDice,
		},
	},
	{
		Role:        RoleSpectator,
		Name:        "Spectator",
		Rank:        300,
		Color:       "secondary",
		IsSystem:    true,
		Permissions: []Permission{PermViewForum},
	},
	{
		Role:     RoleGuest,
		Name:     "Guest",
		Rank:     200,
		Color:    "light",
		IsSystem: true,
		// Guests may read the public forum. The legacy constants list
		// view_forum in the guest ceiling (MAX_ROLE_PERMISSIONS.guest), so a
		// permissionless guest would lock anonymous visitors out of every
		// read path that is not explicitly overridden at category level.
		Permissions: []Permission{PermViewForum},
	},
}

// SystemRoles returns the canonical role specs sorted by descending rank.
func SystemRoles() []RoleSpec {
	return slices.Clone(roleSpecs)
}

// SpecFor returns the canonical spec for the role, if it is a known role.
// (Named SpecFor because RoleSpec is the struct type name.)
func SpecFor(role Role) (RoleSpec, bool) {
	for _, spec := range roleSpecs {
		if spec.Role == role {
			return spec, true
		}
	}
	return RoleSpec{}, false
}

// AllRoles returns all known roles sorted by descending rank.
func AllRoles() []Role {
	roles := make([]Role, 0, len(roleSpecs))
	for _, spec := range roleSpecs {
		roles = append(roles, spec.Role)
	}
	return roles
}

// RoleValues maps roles to their string values, keeping order.
func RoleValues(roles []Role) []string {
	values := make([]string, len(roles))
	for i, role := range roles {
		values[i] = string(role)
	}
	return values
}

// AllRoleValues returns all known roles as plain strings sorted by
// descending rank, ready for select fields.
func AllRoleValues() []string {
	return RoleValues(AllRoles())
}
