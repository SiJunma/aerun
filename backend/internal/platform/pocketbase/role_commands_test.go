package pocketbase

// Tests for the TASK-5 role command hardening (ADR-3).
//
// Each rule here exists because the previous handler produced a state nobody
// could reason about: an edited system role that import-roles would silently
// revert, a deleted role that left users.role dangling, and a custom role that
// could take a system role's name.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/pocketbase/dbx"
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
