package auth

import (
	"slices"
	"testing"
)

func TestAllPermissionsMatchLegacyRegistrySize(t *testing.T) {
	// The legacy registry had 37 keys. Migration 1767800000 adds eight more —
	// the edit/delete split by subject and ownership — so 45 is the new count.
	// The floor is the meaningful part: the count may only ever GROW as the
	// product gains a capability, and a silent DROP is what this guards.
	const legacyCount = 37
	if got := len(allPermissions); got < legacyCount {
		t.Fatalf("expected at least %d permissions, got %d", legacyCount, got)
	}
	if !slices.IsSorted(AllPermissions()) {
		t.Fatal("AllPermissions must stay sorted for stable seeds")
	}
	seen := map[Permission]bool{}
	for _, perm := range allPermissions {
		if seen[perm] {
			t.Fatalf("duplicate permission %q", perm)
		}
		seen[perm] = true
	}
}

func TestRoleSpecsAreRankedAndConsistent(t *testing.T) {
	specs := SystemRoles()
	if len(specs) != 6 {
		t.Fatalf("expected 6 system roles, got %d", len(specs))
	}
	for i := 1; i < len(specs); i++ {
		if specs[i-1].Rank <= specs[i].Rank {
			t.Fatalf("SystemRoles must be sorted by descending rank: %d then %d", specs[i-1].Rank, specs[i].Rank)
		}
	}
	if specs[0].Role != RoleRoot || specs[len(specs)-1].Role != RoleGuest {
		t.Fatal("expected root first and guest last")
	}

	for _, role := range AllRoles() {
		if _, ok := SpecFor(role); !ok {
			t.Fatalf("AllRoles contains %q without a spec", role)
		}
	}
	if _, ok := SpecFor("pending"); ok {
		t.Fatal("pending must be a status, not a role")
	}
	if _, ok := SpecFor("banned"); ok {
		t.Fatal("banned must be a status, not a role")
	}
	if _, ok := SpecFor("unknown"); ok {
		t.Fatal("unknown roles must not resolve")
	}
}

func TestDefaultPermissionMatrixMirrorsLegacyRoles(t *testing.T) {
	all := AllPermissions()

	for _, role := range []Role{RoleRoot, RoleAdmin} {
		got := DefaultPermissions(role)
		if len(got) != len(all) {
			t.Fatalf("%s must hold every permission, got %d of %d", role, len(got), len(all))
		}
		for _, perm := range all {
			if !Has(got, perm) {
				t.Fatalf("%s is missing %q", role, perm)
			}
		}
	}

	// player: general + features + self-edit, no moderation or staff keys.
	player := DefaultPermissions(RolePlayer)
	for _, perm := range []Permission{
		PermViewForum, PermPostReply, PermCreateTopic, PermUseReputation,
		PermEditSelfReputation, PermDeleteSelfReputation,
		PermUseMasks, PermCreateSelfMask, PermDeleteSelfMask, PermUseDice,
		PermUseDirectMessages, PermEditSelfNickname,
		PermEditSelfAvatar, PermEditSelfStatus, PermEditSelfProfile,
		PermEditSelfSignature,
		// Editing your own post/topic is ordinary authorship, and the handler
		// compares the author on every one of these — the key never widens the
		// subject, it only makes the intent separately assignable.
		PermEditSelfPost, PermDeleteSelfPost, PermEditSelfTopic, PermDeleteSelfTopic,
	} {
		if !Has(player, perm) {
			t.Fatalf("player is missing %q", perm)
		}
	}
	for _, perm := range []Permission{
		PermModerateContent, PermBanUsers, PermViewAuditLog, PermChangeRoles,
		PermBypassHideTags,
		// A master roll is the GM's private number. This used to be asserted as
		// PRESENT for player; it is now asserted absent, which is the point of
		// the change. A member who cannot see a master roll must not be able to
		// tick a box that makes it visible.
		PermViewMasterDice,
		// Deleting somebody else's entry is staff work, not authorship.
		PermDeleteOthersReputation, PermEditOthersReputation,
		// Takes other people's replies with it: offered in the admin panel,
		// never granted to a built-in role by default.
		PermDeleteOwnTopicWithReplies,
	} {
		if Has(player, perm) {
			t.Fatalf("player must not hold %q", perm)
		}
	}

	// moderator: moderation stack without role management.
	moderator := DefaultPermissions(RoleModerator)
	for _, perm := range []Permission{
		PermModerateContent, PermMoveTopics, PermCloseTopics, PermPinTopics,
		PermViewAuditLog, PermBypassHideTags,
		// DMs are a baseline member capability. This was previously asserted as
		// ABSENT for moderator — which is the bug where a moderator could not
		// answer a player in private. It is now asserted present, because a
		// moderator who cannot reply in DMs cannot resolve most of what a
		// moderator is for.
		PermUseDirectMessages,
		// The staff half of the reputation split.
		PermDeleteOthersReputation, PermEditSelfReputation, PermDeleteSelfReputation,
	} {
		if !Has(moderator, perm) {
			t.Fatalf("moderator is missing %q", perm)
		}
	}
	for _, perm := range []Permission{
		PermBanUsers, PermChangeRoles, PermManageRoles, PermApproveUsers,
		PermDeleteUsers,
	} {
		if Has(moderator, perm) {
			t.Fatalf("moderator must not hold %q", perm)
		}
	}
	// Rewriting somebody else's reputation entry after the fact is deliberately
	// OFF for moderators. Removing an abusive one is not; the two are separate
	// keys precisely so this asymmetry can be expressed.
	if Has(moderator, PermEditOthersReputation) {
		t.Fatal("moderator must not hold edit_others_reputation by default")
	}

	// spectator and guest: read-only access to the public forum.
	if got := DefaultPermissions(RoleSpectator); len(got) != 1 || got[0] != PermViewForum {
		t.Fatalf("spectator must hold exactly view_forum, got %v", got)
	}
	if got := DefaultPermissions(RoleGuest); len(got) != 1 || got[0] != PermViewForum {
		t.Fatalf("guest must hold exactly view_forum, got %v", got)
	}

	// Unknown roles deny everything.
	if got := DefaultPermissions("legacy-pending"); len(got) != 0 {
		t.Fatalf("unknown roles must deny everything, got %v", got)
	}
}

func TestEffectivePermissionsNarrowedByStatus(t *testing.T) {
	if _, ok := EffectivePermissions("nope", StatusActive); ok {
		t.Fatal("unknown roles must not report ok")
	}

	playerActive, _ := EffectivePermissions(RolePlayer, StatusActive)
	if !Has(playerActive, PermPostReply) {
		t.Fatal("active players keep posting rights")
	}

	playerPending, _ := EffectivePermissions(RolePlayer, StatusPending)
	if !Has(playerPending, PermViewForum) || !Has(playerPending, PermEditSelfNickname) {
		t.Fatal("pending users keep view_forum and self-edit rights")
	}
	// The whole biographical block rides on this ONE key: PATCH /me/profile
	// gates every field on it, and the UI exposes those fields to pending
	// members (the OAuth flow even saves a profile before approval). Losing it
	// here is what made every pending save answer 403.
	if !Has(playerPending, PermEditSelfProfile) {
		t.Fatal("pending users keep edit_self_profile — the profile form must save")
	}
	for _, perm := range []Permission{
		PermPostReply, PermCreateTopic, PermUseReputation, PermUseDirectMessages,
	} {
		if Has(playerPending, perm) {
			t.Fatalf("pending users must lose %q", perm)
		}
	}

	playerBanned, _ := EffectivePermissions(RolePlayer, StatusBanned)
	if len(playerBanned) != 0 {
		t.Fatalf("banned users must lose everything, got %v", playerBanned)
	}

	// Unknown statuses deny everything as well.
	moderatorWeird, _ := EffectivePermissions(RoleModerator, Status("weird"))
	if len(moderatorWeird) != 0 {
		t.Fatalf("unknown statuses must deny everything, got %v", moderatorWeird)
	}

	// Guests keep their read-only baseline while active, lose it when banned.
	guestActive, _ := EffectivePermissions(RoleGuest, StatusActive)
	if len(guestActive) != 1 || !Has(guestActive, PermViewForum) {
		t.Fatalf("active guests must hold view_forum, got %v", guestActive)
	}
	guestBanned, _ := EffectivePermissions(RoleGuest, StatusBanned)
	if len(guestBanned) != 0 {
		t.Fatalf("banned guests must lose view_forum, got %v", guestBanned)
	}
}

func TestAllStatusValues(t *testing.T) {
	values := AllStatusValues()
	// 4 stored statuses: the three assignable lifecycle states plus the
	// soft-delete marker. The SPLIT is the contract — see TestDeletedStatusIsStoredButNotAssignable.
	if len(values) != 4 {
		t.Fatalf("expected 4 stored status values, got %v", values)
	}
	for _, value := range []string{"active", "pending", "banned", "deleted"} {
		if !slices.Contains(values, value) {
			t.Fatalf("missing status %q in %v", value, values)
		}
	}
	if !(Status("active")).IsValid() {
		t.Fatal("active must be valid")
	}
	if (Status("gone")).IsValid() {
		t.Fatal("unknown statuses must not be valid")
	}
}

// TestDeletedStatusIsStoredButNotAssignable pins the split the soft-delete
// feature depends on: `deleted` is a value the users.status select must HOLD
// (so a record save of a soft-deleted row passes validation) and the admin
// filter must FIND, but no status form may ASSIGN it — assigning it without
// the coordinated is_deleted/nickname_normalized writes would produce a
// half-deleted row the command layer cannot reason about.
func TestDeletedStatusIsStoredButNotAssignable(t *testing.T) {
	if !slices.Contains(AllStatusValues(), string(StatusDeleted)) {
		t.Fatalf("the select must hold deleted, got %v", AllStatusValues())
	}
	if StatusDeleted.IsValid() {
		t.Fatal("deleted must not be assignable: only the admin delete command may write it")
	}
	// The narrowing must deny everything for it — same class as an unknown
	// status, on purpose: a deleted account is out of circulation.
	perms := NarrowForStatus(DefaultPermissions(RoleModerator), StatusDeleted)
	if len(perms) != 0 {
		t.Fatalf("deleted must deny every permission, got %v", perms)
	}
}

func TestMentionAllPermissionDefaultsAndStatusNarrowing(t *testing.T) {
	// Owner ruling (2026-10-11, Part 9):
	// PermMentionAll ("mention_all") is default ON for admin/root,
	// default OFF for player, moderator, spectator, guest.
	for _, role := range []Role{RoleRoot, RoleAdmin} {
		if !Has(DefaultPermissions(role), PermMentionAll) {
			t.Fatalf("%s must hold PermMentionAll by default", role)
		}
	}
	for _, role := range []Role{RolePlayer, RoleModerator, RoleSpectator, RoleGuest} {
		if Has(DefaultPermissions(role), PermMentionAll) {
			t.Fatalf("%s must not hold PermMentionAll by default", role)
		}
	}

	// Narrowing for status: pending strips PermMentionAll; banned strips everything.
	adminPerms := DefaultPermissions(RoleAdmin)
	pending := NarrowForStatus(adminPerms, StatusPending)
	if Has(pending, PermMentionAll) {
		t.Fatal("pending accounts must lose PermMentionAll")
	}
	banned := NarrowForStatus(adminPerms, StatusBanned)
	if Has(banned, PermMentionAll) {
		t.Fatal("banned accounts must lose PermMentionAll")
	}
}
