package pocketbase

// nickname_commands_test.go pins the rank matrix for renaming, which is a
// RANK rule rather than a permission rule:
//
//	moderator → strictly lower only (a peer moderator is refused)
//	admin     → admins and everyone below (equal rank allowed)
//	root      → anyone, except a protected nickname
//
// Each case is asserted through the HTTP command, not by calling the helper
// directly: the point is that the route wires the rule up, and a helper test
// would pass even if the handler stopped calling it.
//
// The protected-nickname case is here too, because "nobody, including root, may
// rename the chief account" is the rule most likely to be quietly relaxed.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// renameIssues issues PATCH /users/{targetID}/nickname as `actor`.
func renameIssues(t *testing.T, serverURL, token, targetID, nickname, key string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(
		http.MethodPatch,
		fmt.Sprintf("%s/api/aerun/users/%s/nickname", serverURL, targetID),
		strings.NewReader(fmt.Sprintf(`{"nickname":%q}`, nickname)),
	)
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	var payload map[string]any
	_ = json.NewDecoder(res.Body).Decode(&payload)
	return res.StatusCode, payload
}

// seedCustomRoleUser creates a custom role plus an account holding it,
// returning the account id.
//
// `rank` is set to the moderator rank EXPLICITLY. It is a required column, and
// writing it is the point: a custom role that ranks as a moderator must be
// refused by a moderator, because the rule is STRICTLY lower. If the helper
// instead inferred the rank from base_role_id, the case would be proving the
// wrong thing — so the value is stated, and the collection owns it.
func seedCustomRoleUser(t *testing.T, app *tests.TestApp, id, email, nickname, baseRole string) string {
	t.Helper()

	roles, err := app.FindCollectionByNameOrId(rolesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	role := core.NewRecord(roles)
	role.Set("id", id)
	role.Set("role_id", id)
	role.Set("name", "Peer "+baseRole)
	role.Set("rank", 600)
	role.Set("color", "info")
	role.Set("is_system", false)
	role.Set("permissions", []string{
		string(auth.PermEditOthersNicknames),
		string(auth.PermViewForum),
	})
	role.Set("base_role_id", baseRole)
	role.Set("max_characters_limit", 0)
	if err := app.Save(role); err != nil {
		t.Fatalf("failed to create custom role: %v", err)
	}

	createTestUser(t, app, id, email, nickname, auth.Role(id), auth.StatusActive)
	return id
}

// TestNicknameChangeIsAuditedWithBothValues pins the owner's requirement that a
// rename leaves a trail carrying the OLD name — without it, "who wrote this
// under their previous name" becomes unanswerable.
func TestNicknameChangeIsAuditedWithBothValues(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	status, _ := renameIssues(t, server.URL, tokens["root"], fixPlayerID, "RenamedPlayer", "nick-audit-1")
	if status != http.StatusOK {
		t.Fatalf("rename = %d, want 200", status)
	}

	for _, entry := range auditLogsFor(t, app, "nickname_change") {
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		if oldName, _ := details["old_nickname"].(string); oldName == "PlayerOne" {
			if newName, _ := details["new_nickname"].(string); newName != "RenamedPlayer" {
				t.Fatalf("audit recorded old=%q new=%q, want new=%q", oldName, newName, "RenamedPlayer")
			}
			return
		}
	}
	t.Error("a nickname change must be audited with the previous nickname")
}

// TestNicknameUniquenessIsEnforcedAcrossSpellings proves the uniqueness key is
// the NORMALISED one: different case and different padding must collide, and the
// loser gets 409 rather than a second account with a near-identical name.
func TestNicknameUniquenessIsEnforcedAcrossSpellings(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// Case and padding must not create a second identity: "  PLAYERONE  "
	// normalises to exactly the fixture's "PlayerOne".
	//
	// Note the spelling is deliberately PLAYERONE and not "player one" —
	// NormalizeNickname collapses whitespace but does NOT remove it, so
	// "player one" is a different nickname and would legitimately succeed.
	// Asserting the wrong one of those would have "proved" uniqueness while
	// testing nothing.
	status, _ := renameIssues(t, server.URL, tokens["root"], fixPendingID, "  PLAYERONE  ", "nick-dup-1")
	if status != http.StatusConflict {
		t.Fatalf("colliding rename = %d, want 409", status)
	}
}

// TestSelfRenameRefusesTheProtectedName: nobody may TAKE the protected name,
// including the chief account itself, which is the whole point of protecting it.
func TestSelfRenameRefusesTheProtectedName(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodPatch,
		fmt.Sprintf("%s/api/aerun/me/nickname", server.URL),
		strings.NewReader(`{"nickname":"`+nicknameUntouchableNickname+`"}`))
	req.Header.Set("Authorization", tokens["root"])
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "nick-protected-1")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("claiming the protected nickname = %d, want 403", res.StatusCode)
	}
}
func TestNicknameRankMatrix(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	adminToken := createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
	// A custom role holding the MODERATOR rank. It must be refused by a
	// moderator, because the rule is STRICTLY lower — this is the only way that
	// case is reachable for a non-system role.
	peerID := seedCustomRoleUser(t, app, "peermoderator01", "peer@example.com", "PeerMod", "moderator")
	// An ordinary account whose nickname IS the protected one. createTestUser
	// returns an auth TOKEN, so the id is restated here rather than captured
	// from it — reading the token as a record id yields a baffling 404.
	const protectedID = "userprotect0001"
	createTestUser(t, app, protectedID, "prot@example.com", nicknameUntouchableNickname, auth.RolePlayer, auth.StatusActive)

	server := newTestServer(t, app)
	defer server.Close()

	cases := []struct {
		name   string
		actor  string
		target string
		want   int
	}{
		{"moderator renames a player", tokens["moderator"], fixPlayerID, http.StatusOK},
		{"moderator refuses a peer moderator", tokens["moderator"], fixModeratorID, http.StatusForbidden},
		{"moderator refuses a custom moderator role", tokens["moderator"], peerID, http.StatusForbidden},
		{"moderator refuses an admin", tokens["moderator"], fixAdminID, http.StatusForbidden},
		{"moderator refuses root", tokens["moderator"], fixRootID, http.StatusForbidden},
		{"admin renames a player", adminToken, fixPlayerID, http.StatusOK},
		{"admin renames another admin", adminToken, fixAdminID, http.StatusOK},
		{"admin renames a moderator", adminToken, fixModeratorID, http.StatusOK},
		{"admin refuses root", adminToken, fixRootID, http.StatusForbidden},
		{"root renames an admin", tokens["root"], fixAdminID, http.StatusOK},
		{"root renames a moderator", tokens["root"], fixModeratorID, http.StatusOK},
		{"root may NOT rename the protected account", tokens["root"], protectedID, http.StatusForbidden},
		{"admin may NOT rename the protected account", adminToken, protectedID, http.StatusForbidden},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, _ := renameIssues(t, server.URL, tc.actor, tc.target,
				fmt.Sprintf("Renamed%d", i), fmt.Sprintf("nick-rank-%d", i))
			if status != tc.want {
				t.Fatalf("status = %d, want %d", status, tc.want)
			}
		})
	}
}
