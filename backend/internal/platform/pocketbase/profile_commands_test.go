package pocketbase

// profile_commands_test.go pins the save path the legacy profile form never had.
//
// The bug this exists for was invisible from the UI: editing YOUR OWN profile
// merged the values into local React state and never called the server, so a
// changed status line looked saved and vanished on reload. These tests assert
// the value is in the DATABASE afterwards, not merely that the call returned
// 200 — a 200 with nothing written is exactly the failure being fixed.

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func profileField(t *testing.T, app core.App, userID, field string) string {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || record == nil {
		t.Fatalf("account %s missing: %v", userID, err)
	}
	return record.GetString(field)
}

func TestProfileEditIsPersistedForSelf(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	body := `{"status_line":"Deep in the fog","bio":"long time reader","location":"Mistford","occupation":"Archivist"}`
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/profile", strings.NewReader(body))
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("self profile save = %d, want 200", res.StatusCode)
	}

	// The whole point: read the DATABASE, not the response.
	for field, want := range map[string]string{
		"status_line": "Deep in the fog",
		"bio":         "long time reader",
		"location":    "Mistford",
		"occupation":  "Archivist",
	} {
		if got := profileField(t, app, fixPlayerID, field); got != want {
			t.Errorf("%s = %q, want %q — the value did not persist", field, got, want)
		}
	}
}

// TestProfileEditIsPartialNotWholesale: sending one field must not blank the
// others. Every field is a pointer for this reason.
func TestProfileEditIsPartialNotWholesale(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/profile",
		strings.NewReader(`{"status_line":"only this"}`))
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if got := profileField(t, app, fixPlayerID, "status_line"); got != "only this" {
		t.Errorf("status_line = %q", got)
	}
	if got := profileField(t, app, fixPlayerID, "bio"); got != "" {
		t.Errorf("bio = %q, want it left untouched", got)
	}
}

func TestProfileEditOfAnotherAccountIsRankBounded(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	adminToken := createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
	server := newTestServer(t, app)
	defer server.Close()

	patch := func(actor, target, body, key string) int {
		req, _ := http.NewRequest(http.MethodPatch,
			fmt.Sprintf("%s/api/aerun/users/%s/profile", server.URL, target), strings.NewReader(body))
		req.Header.Set("Authorization", actor)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	// WHO may edit another account follows the PROFILE matrix, not the nickname
	// one. `edit_others_profile` is admin-only by default and is deliberately
	// not `edit_others_statuses`: that key names the one-line status under a
	// nickname, and borrowing it made the permission list describe something the
	// code did not do. Moderators edit content (posts, topics, nicknames); these
	// are personal facts.
	//
	// The RANK matrix from renaming still applies on top — see the root case.
	if got := patch(adminToken, fixPlayerID, `{"bio":"moderated"}`, "prof-adm-1"); got != http.StatusOK {
		t.Errorf("admin editing a player's bio = %d, want 200", got)
	}
	if got := profileField(t, app, fixPlayerID, "bio"); got != "moderated" {
		t.Errorf("admin-edited bio did not persist: %q", got)
	}

	if got := patch(tokens["moderator"], fixPlayerID, `{"bio":"nope"}`, "prof-mod-1"); got != http.StatusForbidden {
		t.Errorf("moderator editing a player's bio = %d, want 403 (no edit_others_profile)", got)
	}
	if got := profileField(t, app, fixPlayerID, "bio"); got != "moderated" {
		t.Errorf("a refused edit changed the bio: %q", got)
	}

	// An admin may edit a peer, but NOT root — the rank matrix from renaming,
	// reused so staff authority cannot be aimed upward.
	if got := patch(adminToken, fixAdminID, `{"bio":"peer"}`, "prof-adm-2"); got != http.StatusOK {
		t.Errorf("admin editing another admin = %d, want 200", got)
	}
	if got := patch(adminToken, fixRootID, `{"bio":"up"}`, "prof-adm-3"); got != http.StatusForbidden {
		t.Errorf("admin editing root = %d, want 403", got)
	}
	if got := patch(tokens["player"], fixModeratorID, `{"bio":"nope"}`, "prof-plr-1"); got != http.StatusForbidden {
		t.Errorf("player editing a moderator = %d, want 403", got)
	}
}

// TestProfileEditRejectsOverlongFields: the bound is enforced with a readable
// message rather than left to the database constraint.
func TestProfileEditRejectsOverlongFields(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"bio":%q}`, strings.Repeat("x", 5000))
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/profile", strings.NewReader(body))
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusOK {
		t.Error("an overlong bio must be refused, not truncated")
	}
}

// TestProfileEditDoesNotWriteNickname: nickname keeps its own audited command
// and its rank matrix, so it must not be reachable through this one.
func TestProfileEditDoesNotWriteNickname(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	before := profileField(t, app, fixPlayerID, "nickname")
	req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/profile",
		strings.NewReader(`{"nickname":"Smuggled","bio":"fine"}`))
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if after := profileField(t, app, fixPlayerID, "nickname"); after != before {
		t.Errorf("nickname changed from %q to %q through the profile command — it has its own audited path", before, after)
	}
	if got := profileField(t, app, fixPlayerID, "bio"); got != "fine" {
		t.Errorf("bio = %q, the allowed field should still have saved", got)
	}
}
