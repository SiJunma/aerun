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

// ── The role payload is split by what the CALLER may know ──────────────────────
//
// GET /roles is ungated on purpose — a role badge must render for a signed-out
// visitor, and account_isolation_test.go pins that. What it must NOT answer is
// "what may this caller do", which is a different question with a different
// audience, and it used to answer it for everyone.
//
// The damage was not hypothetical disclosure of one field: the whole matrix. A
// guest could read every role, its full permission list, whether it is a system
// role, which system role a custom one derives from and its mask limit — a
// complete map of the board's security model, and the most useful thing to read
// before choosing an account to target.
//
// Both halves are asserted. A gate that only checks the public route would pass
// while the matrix quietly rode along on another key, and a gate that only checks
// the admin route would pass while the editor silently lost the fields its form
// submits back — which is the failure that makes roles UNFIXABLE, the same way
// hiding a category from its own editor does.
func TestRolePayloadIsSplitByAudience(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("the public list carries badge fields only", func(t *testing.T) {
		for _, who := range []string{"", "player", "root"} {
			status, body := getAerunAuthed(t, ts.URL+"/api/aerun/roles", tokens[who])
			if status != http.StatusOK {
				t.Fatalf("%q: expected 200, got %d: %s", who, status, body)
			}

			// Published on purpose: a badge paints all four, and a role badge on a
			// post already reveals the role to anyone who can read the post.
			for _, field := range []string{`"role_id"`, `"name"`, `"rank"`, `"color"`} {
				if !bytes.Contains(body, []byte(field)) {
					t.Fatalf("%q: badge payload must carry %s: %s", who, field, body)
				}
			}

			// The security model, on an ungated route, to anyone.
			for _, field := range []string{
				`"permissions"`, `"is_system"`, `"base_role_id"`, `"max_characters_limit"`,
			} {
				if bytes.Contains(body, []byte(field)) {
					t.Fatalf("%q: public role list leaked %s: %s", who, field, body)
				}
			}
		}
	})

	t.Run("the editor's list is refused without manage_roles", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/admin/roles", tokens["player"])
		if status != http.StatusForbidden {
			t.Fatalf("expected 403 for a member, got %d: %s", status, body)
		}
		// A refusal must carry nothing at all — a 403 body that still leaked the
		// matrix would be the same defect wearing a different status code.
		for _, field := range []string{`"permissions"`, `"base_role_id"`} {
			if bytes.Contains(body, []byte(field)) {
				t.Fatalf("a refused caller must receive nothing, got %s: %s", field, body)
			}
		}
	})

	t.Run("the editor's list carries the configuration back", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/admin/roles", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		for _, field := range []string{
			`"permissions"`, `"is_system"`, `"base_role_id"`, `"max_characters_limit"`, `"id"`,
		} {
			if !bytes.Contains(body, []byte(field)) {
				t.Fatalf("the role editor needs %s and must get it: %s", field, body)
			}
		}
	})
}

// ── The staff member DTO is a whitelist, and it is COMPLETE ──────────────────
//
// Two separate defects met on this one response, and they pull in opposite
// directions, so both halves are asserted here:
//
//	MISSING. The payload had no `status_line`. MembersPage renders the one-line
//	status under every nickname, so the admin table rendered that cell empty for
//	every account while the PUBLIC read supplied a real value — the same row
//	looking different depending on which endpoint answered. That asymmetry is
//	the tell: a mapper gap, not a data gap.
//
//	EXTRA. The payload is a whitelist rather than a serialised record, and the
//	whitelist is the security property. `users` is an auth collection, so a
//	record carries `settings` — every member's private preferences, including
//	sound volume and which notification types they muted — and `email`. Neither
//	may ride along here. They did not, and this is what stops them starting.
func TestStaffUserPayloadIsAWhitelistAndCarriesTheStatusLine(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("the moderation fields are present", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/admin/users", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}

		for _, field := range []string{
			`"status_line"`, `"status"`, `"verified"`, `"last_seen"`,
			`"post_count"`, `"topics_count"`, `"reputation"`,
		} {
			if !bytes.Contains(body, []byte(field)) {
				t.Fatalf("the staff member table needs %s and must get it: %s", field, body)
			}
		}
	})

	t.Run("no auth credentials or private preferences ride along", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/admin/users", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}

		// `settings` is the one that matters: it holds every member's sound
		// volume, in-app notification mutes and mail preferences. `email` is the
		// authentication credential — the password-reset target and the OAuth2
		// subject. Neither belongs in an operator read.
		for _, field := range []string{
			`"settings"`, `"email"`, `"password"`, `"tokenKey"`,
			`"legacy_firebase_uid"`, `"emailVisibility"`, `"contacts"`,
		} {
			if bytes.Contains(body, []byte(field)) {
				t.Fatalf("the staff member list must not serve %s: %s", field, body)
			}
		}
	})
}

// A system role is EDITABLE. It is the template a custom role is derived from,
// so freezing it would freeze every role built on it. The fields that make it a
// system role in the first place stay locked: role_id (the key users.role and
// categories.allowed_roles point at) and is_system (what makes it deletable or
// not). Neither is writable through the payload.
func TestSystemRoleIsEditableButKeepsItsIdentity(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	role, err := app.FindFirstRecordByFilter(rolesCollectionName, "role_id = 'moderator'", dbx.Params{})
	if err != nil || role == nil {
		t.Fatalf("the seeded moderator role is missing: %v", err)
	}

	edits := []struct {
		name string
		body string
	}{
		{name: "rename", body: `{"name":"Renamed Moderator"}`},
		{name: "recolour", body: `{"color":"danger"}`},
		{name: "change rank", body: `{"rank":601}`},
		{name: "change permissions", body: `{"permissions":["view_forum"]}`},
	}
	for i, tc := range edits {
		t.Run(tc.name, func(t *testing.T) {
			status, payload, _ := categoryCall(t, http.MethodPatch,
				ts.URL+"/api/aerun/roles/"+role.Id, tc.body,
				tokens["root"], "test-idem-sysrole-edit-"+string(rune('a'+i)))
			if status != http.StatusOK {
				t.Fatalf("a system role must be editable, got %d: %s", status, payload)
			}
		})
	}

	reloaded, err := app.FindRecordById(rolesCollectionName, role.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.GetString("name"); got != "Renamed Moderator" {
		t.Fatalf("the rename did not persist, got %q", got)
	}
	if !reloaded.GetBool("is_system") {
		t.Fatal("is_system must not be writable — it is what makes the row deletable or not")
	}

	// A system role is a template, not a derivative: giving it a base would
	// leave the delete-revert path with no defined target for it.
	status, payload, _ := categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/roles/"+role.Id, `{"base_role_id":"player"}`,
		tokens["root"], "test-idem-sysrole-base")
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 when a system role is given a base, got %d: %s", status, payload)
	}

	// role_id is the join key for users.role; renaming it would orphan them.
	status, payload, _ = categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/roles/"+role.Id, `{"role_id":"shadow","is_system":false}`,
		tokens["root"], "test-idem-sysrole-identity")
	if status != http.StatusOK {
		t.Fatalf("identity fields are ignored rather than rejected, got %d: %s", status, payload)
	}
	final, err := app.FindRecordById(rolesCollectionName, role.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := final.GetString("role_id"); got != "moderator" {
		t.Fatalf("role_id must not be rewritable, got %q", got)
	}
	if !final.GetBool("is_system") {
		t.Fatal("is_system must survive a payload that tries to clear it")
	}

	// The role panel keys its permission cap on base_role_id, falling back to
	// the role's OWN id when the column is empty — which is every system role.
	// That fallback value must never reach the server: it is a self-reference,
	// and the admin got "a system role cannot have a base role" on a plain save
	// with nothing changed. The panel therefore omits the key, and the handler
	// leaves the column alone when it is absent.
	t.Run("saving a system role with no base key succeeds", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPatch,
			ts.URL+"/api/aerun/roles/"+role.Id, `{"name":"Guest Mode"}`,
			tokens["root"], "test-idem-sysrole-nobase")
		if status != http.StatusOK {
			t.Fatalf("an omitted base_role_id must leave the row alone, got %d: %s", status, payload)
		}
		reloaded, err := app.FindRecordById(rolesCollectionName, role.Id)
		if err != nil {
			t.Fatal(err)
		}
		if got := reloaded.GetString("base_role_id"); got != "" {
			t.Fatalf("a system role must stay base-less, got %q", got)
		}
	})
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
		// Zero is no longer a rejection: it means "rank omitted", and the
		// command derives one from the base role. The role form sends no rank
		// at all, so rejecting 0 made creating a custom role impossible — the
		// reported "Rank must be between 1 and 10000" on a plain
		// "create a role based on Player". validateRoleRank still guards the
		// range for a rank that WAS sent.
		{name: "zero means derive a rank", rank: 0, want: http.StatusCreated},
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

// TestOmittedRoleRankLandsAboveItsBase is the create-without-rank contract.
//
// The admin role form has no rank input, so the payload carries none. The role
// must still be created, and it must sort where the base-role picker implies it
// belongs: one step above Player, i.e. between Player and Moderator.
func TestOmittedRoleRankLandsAboveItsBase(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload, _ := categoryCall(t, http.MethodPost, ts.URL+"/api/aerun/roles",
		`{"role_id":"vanguard","name":"Vanguard","base_role_id":"player","permissions":["view_forum"]}`,
		tokens["root"], "test-idem-omitted-rank")
	if status != http.StatusCreated {
		t.Fatalf("creating a role without a rank: got %d, want 201 (%s)", status, payload)
	}

	rec, err := app.FindFirstRecordByFilter(rolesCollectionName, "role_id = 'vanguard'", dbx.Params{})
	if err != nil || rec == nil {
		t.Fatalf("stored role not found: %v", err)
	}
	playerSpec, ok := auth.SpecFor(auth.RolePlayer)
	if !ok {
		t.Fatal("player spec missing from the compiled matrix")
	}
	if got, want := rec.GetInt("rank"), playerSpec.Rank+1; got != want {
		t.Errorf("stored rank = %d, want %d — the role must sort just above its base", got, want)
	}
	if err := validateRoleRank(rec.GetInt("rank")); err != nil {
		t.Errorf("the derived rank is out of bounds: %v", err)
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

	// The holder is REVERTED to the base role rather than blocking the delete.
	// A role derived from Player was a Player with differences; deleting it
	// must leave its members on Player, not on nothing (users.role is plain
	// text, so a dangling id fails silently at the deny path).
	t.Run("deleting a held role reverts its holders to the base", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/roles/"+held.ID, "", tokens["root"], "test-idem-role-del-held")
		if status != http.StatusOK {
			t.Fatalf("expected 200, the holders fall back to the base, got %d: %s", status, payload)
		}
		if !bytes.Contains(payload, []byte("reassigned_to")) {
			t.Fatalf("the response must report where the holders went: %s", payload)
		}

		user, err := app.FindRecordById(usersCollectionName, fixModeratorID)
		if err != nil {
			t.Fatal(err)
		}
		if got := user.GetString("role"); got != "player" {
			t.Fatalf("the holder must fall back to the base role, got %q", got)
		}
		// Stale custom_role_id would keep the staff check resolving against
		// the role that was just deleted.
		if got := user.GetString("custom_role_id"); got != "" {
			t.Fatalf("custom_role_id must be cleared on revert, got %q", got)
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

// A role held by an account but carrying NO base has nowhere to send that
// account, so the delete is refused. Silently clearing users.role would leave
// them on the deny path with no error anywhere.
func TestDeleteRoleWithoutBaseIsRefusedWhileHeld(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/roles",
		`{"role_id":"baseless","name":"Baseless","rank":250,"permissions":["view_forum"]}`,
		tokens["root"], "test-idem-role-baseless")
	if status != http.StatusCreated {
		t.Fatalf("failed to create the role: %d %s", status, payload)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &created); err != nil {
		t.Fatal(err)
	}

	status, payload, _ = categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/admin/users/"+fixModeratorID,
		`{"role":"baseless","status":"active"}`,
		tokens["root"], "test-idem-user-baseless")
	if status != http.StatusOK {
		t.Fatalf("failed to assign the role: %d %s", status, payload)
	}

	status, payload, _ = categoryCall(t, http.MethodDelete,
		ts.URL+"/api/aerun/roles/"+created.ID, "", tokens["root"], "test-idem-role-del-baseless")
	if status != http.StatusConflict {
		t.Fatalf("expected 409 with no base to fall back to, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("base role")) {
		t.Fatalf("the message must name the missing base: %s", payload)
	}

	// The holder must be untouched by the refusal.
	user, err := app.FindRecordById(usersCollectionName, fixModeratorID)
	if err != nil {
		t.Fatal(err)
	}
	if got := user.GetString("role"); got != "baseless" {
		t.Fatalf("a refused delete must not move the holder, got %q", got)
	}
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
