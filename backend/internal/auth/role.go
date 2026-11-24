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

// CategoryInheritMarker is the sentinel stored in `categories.allowed_roles`
// that means "visibility follows the global role settings".
//
// WHY A MARKER EXISTS. `allowed_roles` is the ONLY input canViewCategory reads
// (ADR-1), and an empty list means root-only. Without a marker, a category
// that "follows the global settings" can only be stored as a SNAPSHOT of the
// role registry taken when the admin last saved — and a role created after
// that save is silently absent from the array, so its members are denied a
// public category until every category is re-saved by hand. The marker turns
// that snapshot into a live rule.
//
// WHY THIS PARTICULAR TEXT. It must be impossible to enter as a role name by
// accident, and it must survive a round trip through a JSON array of ids:
//
//   - it is not a plausible role id (the legacy ids are lowercase words; this
//     is not one, and no UI suggests it);
//   - it can never become a REAL role, because validateAllowedRoles rejects any
//     id absent from the roles registry, and the registry is the only writer —
//     so the marker cannot be shadowed by a role that happens to share the
//     name;
//   - the leading non-alphabetic character cannot start a human-chosen slug, so
//     even a future id-validation relaxation would not collide with it.
//
// The alternative — treating an EMPTY list as "inherit" — is exactly the
// reading ADR-1 removed, and reintroducing it would republish every restricted
// category whose list ever arrived empty. Empty stays root-only.
const CategoryInheritMarker = "__aerun_inherit_roles__"

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

func adminDefaultPermissions() []Permission {
	all := AllPermissions()
	perms := make([]Permission, 0, len(all)-1)
	for _, p := range all {
		// PermViewRawIP is reserved strictly for Chief Admin (Root)
		if p != PermViewRawIP {
			perms = append(perms, p)
		}
	}
	return perms
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
		Permissions: adminDefaultPermissions(),
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
			// DMs are a baseline member capability, not a moderator perk: a
			// moderator who cannot answer a player in private is worse than
			// useless. It was missing from this row while the admin panel's
			// ceiling listed it, so the checkbox rendered — unchecked, and
			// honestly — for the one role that most needs it.
			PermUseDirectMessages,
			PermUseMasks,
			PermUseReputation,
			// Reputation the moderator may retract: their OWN entries by
			// default, and anybody else's only because this is the staff role.
			// Editing somebody else's entry stays OFF by default — rewriting a
			// reputation comment after the fact is a rarer and more suspicious
			// act than removing an abusive one, and it is one checkbox away.
			PermEditSelfReputation,
			PermDeleteSelfReputation,
			PermDeleteOthersReputation,
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
			// A player may adjust and retract their OWN reputation entries.
			// Before the split there was no route for either, so the only way to
			// take back a "+1" was to ask a moderator.
			PermEditSelfReputation,
			PermDeleteSelfReputation,
			PermViewForum,
			// NO view_master_dice. A master roll is the GM's private number;
			// "everyone but guests" made the players the audience for it. It
			// stays a moderator-and-above capability, and the key is still in
			// the registry so a custom role can grant it deliberately.
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
