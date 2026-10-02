package auth

import "slices"

// Permission is a forum capability key. The string values are a wire and
// migration contract with the legacy application
// (src/constants/permissions.js): do not rename them.
type Permission string

// All legacy permission keys, grouped like the legacy constants file.
const (
	PermAdminAccess          Permission = "admin_access"
	PermManageForum          Permission = "manage_forum"
	PermManageDesigns        Permission = "manage_designs"
	PermApproveUsers         Permission = "approve_users"
	PermBanUsers             Permission = "ban_users"
	PermChangeRoles          Permission = "change_roles"
	PermEditOthersNicknames  Permission = "edit_others_nicknames"
	PermEditOthersAvatars    Permission = "edit_others_avatars"
	PermEditOthersStatuses   Permission = "edit_others_statuses"
	PermEditOthersSignatures Permission = "edit_others_signatures"
	PermEditSelfNickname     Permission = "edit_self_nickname"
	PermEditSelfAvatar       Permission = "edit_self_avatar"
	PermEditSelfStatus       Permission = "edit_self_status"
	PermEditSelfSignature    Permission = "edit_self_signature"
	PermManageRoles          Permission = "manage_roles"
	PermManageCategories     Permission = "manage_categories"
	PermDeleteUsers          Permission = "delete_users"
	PermViewAuditLog         Permission = "view_audit_log"

	PermModerateContent Permission = "moderate_content"
	PermMoveTopics      Permission = "move_topics"
	PermCloseTopics     Permission = "close_topics"
	PermPinTopics       Permission = "pin_topics"

	// Post and topic moderation are split by subject (post vs topic) and by
	// ownership (self vs others), so a role can be given the narrow one.
	//
	// `moderate_content` used to gate all six of these at once, which made
	// "a moderator who edits but never deletes" unrepresentable. The four
	// _self_ keys are redundant with authorship checks for an ordinary account,
	// but they are what makes the pair a complete, separately assignable set:
	// a custom role can be denied `delete_others_posts` and keep the rest.
	//
	// `_self_` keys never grant access to ANOTHER account's row — the
	// authorship comparison stays mandatory at every call site. A key answers
	// "may this account perform this action on a post that is not theirs?",
	// with the _self_ variant existing so the pair can be reasoned about
	// together, not as a bypass.
	PermEditSelfPost       Permission = "edit_self_post"
	PermEditOthersPosts    Permission = "edit_others_posts"
	PermDeleteSelfPost     Permission = "delete_self_post"
	PermDeleteOthersPosts  Permission = "delete_others_posts"
	PermEditSelfTopic      Permission = "edit_self_topic"
	PermEditOthersTopics   Permission = "edit_others_topics"
	PermDeleteSelfTopic    Permission = "delete_self_topic"
	PermDeleteOthersTopics Permission = "delete_others_topics"

	PermViewForum   Permission = "view_forum"
	PermPostReply   Permission = "post_reply"
	PermCreateTopic Permission = "create_topic"

	PermUseReputation     Permission = "use_reputation"
	PermDeleteReputation  Permission = "delete_reputation"
	PermUseMasks          Permission = "use_masks"
	PermCreateSelfMask    Permission = "create_self_mask"
	PermDeleteSelfMask    Permission = "delete_self_mask"
	PermCreateOthersMask  Permission = "create_others_mask"
	PermEditOthersMask    Permission = "edit_others_mask"
	PermDeleteOthersMask  Permission = "delete_others_mask"
	PermUseDice           Permission = "use_dice"
	PermViewMasterDice    Permission = "view_master_dice"
	PermUseDirectMessages Permission = "use_direct_messages"
	PermBypassHideTags    Permission = "bypass_hide_tags"
)

// allPermissions is the sorted registry of every known permission key.
var allPermissions = func() []Permission {
	return []Permission{
		PermAdminAccess,
		PermApproveUsers,
		PermBanUsers,
		PermBypassHideTags,
		PermChangeRoles,
		PermCloseTopics,
		PermCreateOthersMask,
		PermCreateSelfMask,
		PermCreateTopic,
		PermDeleteOthersMask,
		PermDeleteOthersPosts,
		PermDeleteOthersTopics,
		PermDeleteReputation,
		PermDeleteSelfMask,
		PermDeleteSelfPost,
		PermDeleteSelfTopic,
		PermDeleteUsers,
		PermEditOthersAvatars,
		PermEditOthersMask,
		PermEditOthersNicknames,
		PermEditOthersPosts,
		PermEditOthersSignatures,
		PermEditOthersStatuses,
		PermEditOthersTopics,
		PermEditSelfAvatar,
		PermEditSelfNickname,
		PermEditSelfPost,
		PermEditSelfSignature,
		PermEditSelfStatus,
		PermEditSelfTopic,
		PermManageCategories,
		PermManageDesigns,
		PermManageForum,
		PermManageRoles,
		PermModerateContent,
		PermMoveTopics,
		PermPinTopics,
		PermPostReply,
		PermUseDice,
		PermUseDirectMessages,
		PermUseMasks,
		PermUseReputation,
		PermViewAuditLog,
		PermViewForum,
		PermViewMasterDice,
	}
}()

// AllPermissions returns a fresh sorted copy of every known permission key.
func AllPermissions() []Permission {
	return slices.Clone(allPermissions)
}

// Forum limit bounds. The EFFECTIVE post limit and page size are tunable rows
// in the `forum_settings` collection (migration 1767800000) because the admin
// panel is supposed to set them; these constants are the CEILINGS around that
// tuning, not the values themselves.
//
// The distinction matters. Before this, the panel's `maxPostsPerTopic` lived
// only in localStorage while the server enforced forum.MaxPostsPerTopic, so the
// number a reader was shown and the number the server applied were unrelated,
// and the panel's change applied to one browser only. A ceiling is a property
// of the build: no configuration, however entered, can produce a forum with
// unbounded topics, an unpaginatable page, or a limit of zero that would make
// every topic unpostable.
const (
	// HardMaxPostsPerTopic is the largest value a forum may configure for
	// posts per topic. The owner's cap, chosen to keep a runaway topic from
	// degrading the topic page for everyone.
	HardMaxPostsPerTopic = 5000
	// MinMaxPostsPerTopic keeps at least one reply possible: a limit of 1
	// would allow the opening post and nothing else, and 0 would make every
	// topic permanently unpostable.
	MinMaxPostsPerTopic = 2
	// DefaultMaxPostsPerTopic is the seeded value and the fallback when the
	// settings row is missing. 2000 is what the Firestore snapshot carried.
	DefaultMaxPostsPerTopic = 2000

	// HardMaxPostsPerPage bounds the page size. It sits above the largest
	// sensible forum page and below the point where one response stops being
	// cheap to render.
	HardMaxPostsPerPage = 100
	// MinPostsPerPage is 1: a page smaller than a single post would render an
	// empty feed.
	MinPostsPerPage = 1
	// DefaultPostsPerPage matches the legacy default and the UI default.
	DefaultPostsPerPage = 20
)

// ClampMaxPostsPerTopic bounds a configured value into the permitted range.
// A zero or negative value means "unset" and yields the default rather than
// the floor, so a settings row that lost its value degrades to normal forum
// behaviour instead of locking every topic.
func ClampMaxPostsPerTopic(configured int) int {
	if configured <= 0 {
		return DefaultMaxPostsPerTopic
	}
	if configured < MinMaxPostsPerTopic {
		return MinMaxPostsPerTopic
	}
	if configured > HardMaxPostsPerTopic {
		return HardMaxPostsPerTopic
	}
	return configured
}

// ClampPostsPerPage bounds a configured page size, with the same "unset means
// default" rule.
func ClampPostsPerPage(configured int) int {
	if configured <= 0 {
		return DefaultPostsPerPage
	}
	if configured < MinPostsPerPage {
		return MinPostsPerPage
	}
	if configured > HardMaxPostsPerPage {
		return HardMaxPostsPerPage
	}
	return configured
}

// AllPermissionValues returns every permission key as plain strings (sorted),
// ready for select fields and JSON payloads.
func AllPermissionValues() []string {
	return PermissionValues(allPermissions)
}

// PermissionValues maps permissions to their string values, keeping order.
func PermissionValues(perms []Permission) []string {
	values := make([]string, len(perms))
	for i, perm := range perms {
		values[i] = string(perm)
	}
	return values
}

// Has reports whether the permission list contains the wanted permission.
// An empty list denies everything (deny-by-default).
func Has(perms []Permission, want Permission) bool {
	return slices.Contains(perms, want)
}
