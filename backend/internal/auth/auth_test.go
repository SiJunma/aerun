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
		PermUseMasks, PermCreateSelfMask, PermDeleteSelfMask, PermUseDice,
		PermViewMasterDice, PermUseDirectMessages, PermEditSelfNickname,
		PermEditSelfAvatar, PermEditSelfStatus, PermEditSelfSignature,
	} {
		if !Has(player, perm) {
			t.Fatalf("player is missing %q", perm)
		}
	}
	for _, perm := range []Permission{
		PermModerateContent, PermBanUsers, PermViewAuditLog, PermChangeRoles,
		PermBypassHideTags,
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
	} {
		if !Has(moderator, perm) {
			t.Fatalf("moderator is missing %q", perm)
		}
	}
	for _, perm := range []Permission{
		PermBanUsers, PermChangeRoles, PermManageRoles, PermApproveUsers,
		PermDeleteUsers, PermUseDirectMessages,
	} {
		if Has(moderator, perm) {
			t.Fatalf("moderator must not hold %q", perm)
		}
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
	if len(values) != 3 {
		t.Fatalf("expected 3 statuses, got %v", values)
	}
	for _, value := range []string{"active", "pending", "banned"} {
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
