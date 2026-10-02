package pocketbase

// role_commands_test.go — part 1: the TASK-5 role command hardening (ADR-3).
//
// Each rule here exists because the previous handler produced a state nobody
// could reason about: an edited system role that import-roles would silently
// revert, a deleted role that left users.role dangling, and a custom role that
// could take a system role's name.
//
// Part 2 (at the bottom of this file) pins the rank matrix for handing roles
// out: an admin acts only on strictly lower accounts and may never appoint an
// admin, while `root` is TRANSFERRED rather than granted.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func TestSystemRoleIsNotEditable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	role, err := app.FindFirstRecordByFilter(rolesCollectionName, "role_id = 'moderator'", dbx.Params{})
	if err != nil || role == nil {
		t.Fatalf("the seeded moderator role is missing: %v", err)
	}
	before := role.GetString("name")

	cases := []struct {
		name string
		body string
	}{
		{name: "rename", body: `{"name":"Renamed Moderator"}`},
		{name: "recolour", body: `{"color":"danger"}`},
		{name: "change rank", body: `{"rank":1}`},
		{name: "change permissions", body: `{"permissions":["view_forum"]}`},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, payload, _ := categoryCall(t, http.MethodPatch,
				ts.URL+"/api/aerun/roles/"+role.Id, tc.body,
				tokens["root"], "test-idem-sysrole-"+string(rune('a'+i)))
			if status != http.StatusForbidden {
				t.Fatalf("expected 403 on a system role, got %d: %s", status, payload)
			}
		})
	}

	reloaded, err := app.FindRecordById(rolesCollectionName, role.Id)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.GetString("name") != before {
		t.Fatalf("a refused PATCH must not change the row, got %q", reloaded.GetString("name"))
	}
}

func TestReservedRoleIDIsRejected(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The UNIQUE index only covers rows that exist, so a reserved id that was
	// never seeded would pass it — and then shadow the compiled matrix for
	// every account carrying that role.
	reserved := []string{"root", "admin", "moderator", "player", "spectator", "guest"}
	for i, roleID := range reserved {
		t.Run(roleID, func(t *testing.T) {
			status, payload, _ := categoryCall(t, http.MethodPost,
				ts.URL+"/api/aerun/roles",
				`{"role_id":"`+roleID+`","name":"Impostor","rank":9000}`,
				tokens["root"], "test-idem-reserved-"+string(rune('a'+i)))
			if status != http.StatusBadRequest {
				t.Fatalf("expected 400 for the reserved id %q, got %d: %s", roleID, status, payload)
			}
			if !bytes.Contains(payload, []byte("reserved")) {
				t.Fatalf("the message must say the id is reserved: %s", payload)
			}
		})
	}
}

func TestRoleRankBounds(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	cases := []struct {
		name string
		rank int
		want int
	}{
		{name: "negative is rejected", rank: -1, want: http.StatusBadRequest},
		{name: "zero is rejected", rank: 0, want: http.StatusBadRequest},
		{name: "above the ceiling is rejected", rank: 10001, want: http.StatusBadRequest},
		{name: "the ceiling itself is allowed", rank: 10000, want: http.StatusCreated},
		{name: "the lowest useful rank is allowed", rank: 1, want: http.StatusCreated},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, payload, _ := categoryCall(t, http.MethodPost,
				ts.URL+"/api/aerun/roles",
				`{"role_id":"ranktest`+string(rune('a'+i))+`","name":"Rank Test","rank":`+strconv.Itoa(tc.rank)+`}`,
				tokens["root"], "test-idem-rank-"+string(rune('a'+i)))
			if status != tc.want {
				t.Fatalf("expected %d for rank %d, got %d: %s", tc.want, tc.rank, status, payload)
			}
		})
	}
}

func TestDeleteRoleRefusesWhileReferenced(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A custom role nobody holds and no category names: deletable.
	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/roles",
		`{"role_id":"spare","name":"Spare","rank":250,"base_role_id":"player","permissions":["view_forum"]}`,
		tokens["root"], "test-idem-role-spare")
	if status != http.StatusCreated {
		t.Fatalf("failed to create the spare role: %d %s", status, payload)
	}
	var spare struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &spare); err != nil {
		t.Fatal(err)
	}

	t.Run("an unused role deletes and audits", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/roles/"+spare.ID, "", tokens["root"], "test-idem-role-del-spare")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, payload)
		}

		logs, err := app.FindRecordsByFilter(auditLogsCollectionName, "action_type = 'role_deleted'", "", 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(logs) != 1 {
			t.Fatalf("expected one role_deleted audit row, got %d", len(logs))
		}
	})

	// Now a role an account holds.
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/roles",
		`{"role_id":"held","name":"Held","rank":250,"base_role_id":"player","permissions":["view_forum"]}`,
		tokens["root"], "test-idem-role-held")
	if status != http.StatusCreated {
		t.Fatalf("failed to create the held role: %d %s", status, payload)
	}
	var held struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &held); err != nil {
		t.Fatal(err)
	}

	status, payload, _ = categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/admin/users/"+fixModeratorID,
		`{"role":"held","status":"active"}`,
		tokens["root"], "test-idem-user-held")
	if status != http.StatusOK {
		t.Fatalf("failed to assign the role: %d %s", status, payload)
	}

	t.Run("a role held by an account cannot be deleted", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/roles/"+held.ID, "", tokens["root"], "test-idem-role-del-held")
		if status != http.StatusConflict {
			t.Fatalf("expected 409 while an account holds the role, got %d: %s", status, payload)
		}
		if !bytes.Contains(payload, []byte("account")) {
			t.Fatalf("the message must say who holds it: %s", payload)
		}
	})

	t.Run("a role granted to a category cannot be deleted", func(t *testing.T) {
		// Same role, now also referenced by a category: moving the account away
		// must be necessary but not sufficient.
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories",
			`{"name":"Held Room","allowed_roles":["held"]}`,
			tokens["root"], "test-idem-cat-held")
		if status != http.StatusCreated {
			t.Fatalf("failed to create the category: %d %s", status, payload)
		}

		status, payload, _ = categoryCall(t, http.MethodPatch,
			ts.URL+"/api/aerun/admin/users/"+fixModeratorID,
			`{"role":"moderator","status":"active"}`,
			tokens["root"], "test-idem-user-unheld")
		if status != http.StatusOK {
			t.Fatalf("failed to move the account away: %d %s", status, payload)
		}

		status, payload, _ = categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/roles/"+held.ID, "", tokens["root"], "test-idem-role-del-cat")
		if status != http.StatusConflict {
			t.Fatalf("expected 409 while a category grants the role, got %d: %s", status, payload)
		}
		if !bytes.Contains(payload, []byte("held-room")) {
			t.Fatalf("the message must name the category slug: %s", payload)
		}
	})

	t.Run("a system role still cannot be deleted", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/roles/root", "", tokens["root"], "test-idem-role-del-root")
		if status != http.StatusForbidden {
			t.Fatalf("expected 403 for a system role, got %d: %s", status, payload)
		}
	})
}

// Part 2: the rank matrix for handing roles out.
//
//	admin → strictly lower accounts only, and never the admin role itself
//	root  → anything except writing `root`
//
// The third rule is the one that will be attempted first by anyone poking at
// the admin panel: `PATCH /admin/users/{id} {"role":"root"}`. It must fail, and
// for the stated reason — root is TRANSFERRED, never granted — because a role
// write that can mint root is an escalation with no ceremony and no record.

// setRole issues PATCH /admin/users/{id} with a role body as `actor`.
func setRole(t *testing.T, serverURL, token, targetID, newRole, key string) int {
	t.Helper()
	req, _ := http.NewRequest(
		http.MethodPatch,
		fmt.Sprintf("%s/api/aerun/admin/users/%s", serverURL, targetID),
		strings.NewReader(fmt.Sprintf(`{"role":%q}`, newRole)),
	)
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

func TestRoleChangeRankMatrix(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	adminToken := createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
	// A second admin, so "admin may not demote an admin" is reachable: the
	// target must be a peer, not the caller.
	// Fixed 15-char record id, as every PocketBase id in this codebase is.
	const peerAdminID = "useradminpeer01"
	createTestUser(t, app, peerAdminID, "admin2@example.com", "AdminTwo", auth.RoleAdmin, auth.StatusActive)

	server := newTestServer(t, app)
	defer server.Close()

	cases := []struct {
		name   string
		actor  string
		target string
		role   string
		want   int
	}{
		{"admin promotes a player to moderator", adminToken, fixPlayerID, string(auth.RoleModerator), http.StatusOK},
		{"admin demotes a moderator to player", adminToken, fixModeratorID, string(auth.RolePlayer), http.StatusOK},
		{"admin may NOT appoint an admin", adminToken, fixPlayerID, string(auth.RoleAdmin), http.StatusForbidden},
		{"admin may NOT demote a peer admin", adminToken, peerAdminID, string(auth.RolePlayer), http.StatusForbidden},
		{"admin may NOT touch root", adminToken, fixRootID, string(auth.RolePlayer), http.StatusForbidden},
		{"root appoints an admin", tokens["root"], fixPlayerID, string(auth.RoleAdmin), http.StatusOK},
		{"root demotes an admin", tokens["root"], peerAdminID, string(auth.RolePlayer), http.StatusOK},
		// The transfer guard, for BOTH actors.
		{"root may NOT write the root role", tokens["root"], fixPlayerID, string(auth.RoleRoot), http.StatusForbidden},
		{"admin may NOT write the root role", adminToken, fixPlayerID, string(auth.RoleRoot), http.StatusForbidden},
		{"a moderator may not change roles at all", tokens["moderator"], fixPlayerID, string(auth.RolePlayer), http.StatusForbidden},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := setRole(t, server.URL, tc.actor, tc.target, tc.role, fmt.Sprintf("role-%d", i)); got != tc.want {
				t.Fatalf("status = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestRoleChangeIsAudited: a role change is the most consequential write in the
// product, so the resulting role has to survive in the ledger.
func TestRoleChangeIsAudited(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	if got := setRole(t, server.URL, tokens["root"], fixPlayerID, string(auth.RoleModerator), "role-audit-1"); got != http.StatusOK {
		t.Fatalf("promotion = %d, want 200", got)
	}

	for _, entry := range auditLogsFor(t, app, "admin_user_update") {
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		if role, _ := details["role"].(string); role == string(auth.RoleModerator) {
			return
		}
	}
	t.Error("a role change must be audited with the resulting role")
}
