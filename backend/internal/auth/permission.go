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
		PermDeleteReputation,
		PermDeleteSelfMask,
		PermDeleteUsers,
		PermEditOthersAvatars,
		PermEditOthersMask,
		PermEditOthersNicknames,
		PermEditOthersSignatures,
		PermEditOthersStatuses,
		PermEditSelfAvatar,
		PermEditSelfNickname,
		PermEditSelfSignature,
		PermEditSelfStatus,
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
