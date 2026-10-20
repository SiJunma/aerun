package pocketbase

// Tests for the TASK-3 characters domain API.
//
// The collection existed and the importer wrote it, but nothing exposed it at
// runtime: characters created in the UI went into users.settings.characters
// (the retracted fold) and imported ones were invisible and uneditable. These
// pin the properties that make the collection the real store: the cap is
// enforced server-side, ownership is enforced server-side, and reads follow the
// profile visibility rule.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// seedRuntimeCharacter writes a character row directly, which is how a
// rehearsal database looks to the runtime.
func seedRuntimeCharacter(t testing.TB, app *tests.TestApp, id, owner, name string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		t.Fatalf("characters collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("id", id)
	rec.Set("owner_id", owner)
	rec.Set("name", name)
	rec.Set("status_line", "")
	rec.Set("signature", "")
	rec.Set(avatarURLFieldName, "")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed character %s: %v", id, err)
	}
	return rec
}

func TestCharacterReadsFollowProfileVisibility(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Active Mask")
	seedRuntimeCharacter(t, app, "charpending0001", fixPendingID, "Pending Mask")
	seedRuntimeCharacter(t, app, "charbanned00001", fixBannedID, "Banned Mask")

	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("an active owner's characters are public", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/users/"+fixPlayerID+"/characters")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte("Active Mask")) {
			t.Fatalf("guest must see an active owner's characters: %s", body)
		}
	})

	t.Run("a pending owner's characters are public too", func(t *testing.T) {
		// Status does NOT narrow visibility. A pending account is awaiting
		// approval, not erased: it holds a nickname and a post history, and the
		// approval queue is read by looking at the profile. This subtest used to
		// demand a 404, which encoded the opposite rule — a restriction on the
		// account was being enforced as a restriction on its readers.
		status, body := getAerun(t, ts.URL+"/api/aerun/users/"+fixPendingID+"/characters")
		if status != http.StatusOK {
			t.Fatalf("expected 200 for a pending owner, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte("Pending Mask")) {
			t.Fatalf("a pending owner's characters must stay readable: %s", body)
		}
	})

	t.Run("a pending owner still reads their own", func(t *testing.T) {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPendingID+"/characters", tokens["pending"])
		if status != http.StatusOK {
			t.Fatalf("expected 200 for the owner, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte("Pending Mask")) {
			t.Fatalf("the owner must see their own characters: %s", body)
		}
	})

	t.Run("a single character follows the same rule", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/characters/charplayer00001")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte(`"owner_id":"`+fixPlayerID+`"`)) {
			t.Fatalf("payload must name the owner: %s", body)
		}

		// A banned owner's mask is readable like anybody else's: the ban stops
		// the account acting, it does not unpublish what it wrote.
		status, body = getAerun(t, ts.URL+"/api/aerun/characters/charbanned00001")
		if status != http.StatusOK {
			t.Fatalf("expected 200 for a banned owner's character, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte("Banned Mask")) {
			t.Fatalf("a banned owner's character must stay readable: %s", body)
		}
	})
}

// TestStaffCreatesMaskForAnotherAccount pins the staff path.
//
// The bug it pins: an admin adding a mask on somebody else's profile had the
// mask written to the ADMIN's own account, and the cap that then refused
// them was the admin's own role limit — "character limit reached for your
// role" on an account the admin never touched.
//
// So the assertions are about OWNERSHIP (whose row is written) and about
// WHOSE LIMIT (the owner's role, not the caller's).
func TestStaffCreatesMaskForAnotherAccount(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A root account creates a mask owned by the PLAYER. The mask must land
	// on the player, and the admin's own mask count must stay at zero.
	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/users/"+fixPlayerID+"/characters",
		`{"name":"Player Mask","status_line":"","signature":""}`,
		tokens["root"], "test-idem-char-staff-create")
	if status != http.StatusCreated {
		t.Fatalf("staff create for another account = %d, want 201: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte(`"owner_id":"`+fixPlayerID+`"`)) {
		t.Fatalf("the mask must be owned by the account in the path, not the caller: %s", payload)
	}

	owned, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixPlayerID})
	if err != nil {
		t.Fatal(err)
	}
	if owned != 1 {
		t.Fatalf("the target must own exactly one mask, got %d", owned)
	}
	callerOwned, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixRootID})
	if err != nil {
		t.Fatal(err)
	}
	if callerOwned != 0 {
		t.Fatalf("the caller must own none of them, got %d", callerOwned)
	}

	// A member WITHOUT create_others_mask may not write into somebody else's
	// masks. The permission is the gate, and the refusal must be 403.
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/users/"+fixModeratorID+"/characters",
		`{"name":"Not Mine"}`,
		tokens["player"], "test-idem-char-staff-denied")
	if status != http.StatusForbidden {
		t.Fatalf("a member without create_others_mask = %d, want 403: %s", status, payload)
	}
	owned, err = app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixModeratorID})
	if err != nil {
		t.Fatal(err)
	}
	if owned != 0 {
		t.Fatalf("a refused create must not write a row, got %d", owned)
	}
}

// TestStaffCreateChargesTheOwnersLimit pins WHICH limit applies.
//
// The cap is a property of the account that OWNS the masks, so a staff member
// filling somebody else's quota is refused for the OWNER's reason — and the
// caller's own quota is untouched while that happens.
func TestStaffCreateChargesTheOwnersLimit(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Fill the PLAYER's quota to the cap.
	const cap = 2
	setCharacterLimit(t, app, cap)
	for i := 0; i < cap; i++ {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/me/characters",
			`{"name":"Own `+string(rune('A'+i))+`"}`,
			tokens["player"], "test-idem-char-owner-fill-"+string(rune('a'+i)))
		if status != http.StatusCreated {
			t.Fatalf("filling the player's quota failed at %d: %d %s", i, status, payload)
		}
	}

	// The admin now tries to add one more mask for that player. The player's
	// quota is exhausted, so it is refused — and the message must not blame
	// the admin's own role.
	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/users/"+fixPlayerID+"/characters",
		`{"name":"One Too Many"}`,
		tokens["root"], "test-idem-char-staff-over")
	if status != http.StatusConflict {
		t.Fatalf("staff create past the owner's cap = %d, want 409: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("Character limit")) {
		t.Fatalf("the refusal must name the reason: %s", payload)
	}
	// The refusal must blame the OWNER's quota, not the caller's — that was
	// the bug this whole staff path was written for.
	if !bytes.Contains(payload, []byte("owner's account")) {
		t.Fatalf("the refusal must name the owner's quota: %s", payload)
	}
	if !bytes.Contains(payload, []byte("2 masks maximum")) {
		t.Fatalf("the refusal must name the cap: %s", payload)
	}

	// The admin's OWN quota is untouched: their mask list is still empty and
	// they can still create for themselves.
	callerOwned, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixRootID})
	if err != nil {
		t.Fatal(err)
	}
	if callerOwned != 0 {
		t.Fatalf("the caller's quota must not be charged, got %d", callerOwned)
	}
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/users/"+fixRootID+"/characters",
		`{"name":"Root Own"}`,
		tokens["root"], "test-idem-char-staff-self")
	if status != http.StatusCreated {
		t.Fatalf("staff create for themselves = %d, want 201: %s", status, payload)
	}
}

// setCharacterLimit writes the forum-wide mask cap into the settings row, the
// way the admin panel's PATCH does.
//
// The tests use it to exercise a SMALL cap: the default is ten, and filling
// ten masks over HTTP to reach the boundary is slow and says nothing a small
// cap would not.
func setCharacterLimit(t testing.TB, app *tests.TestApp, limit int) {
	t.Helper()
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		t.Fatalf("forum settings row missing: %v", err)
	}
	record.Set("max_characters_per_user", limit)
	if err := app.Save(record); err != nil {
		t.Fatalf("failed to set the character limit: %v", err)
	}
}

// setRoleCharacterLimit writes a per-role mask cap onto the role row, the way
// the role editor's PATCH does.
func setRoleCharacterLimit(t testing.TB, app *tests.TestApp, roleID string, limit int) {
	t.Helper()
	record, err := app.FindFirstRecordByFilter(rolesCollectionName, "role_id = {:rid}", dbx.Params{"rid": roleID})
	if err != nil || record == nil {
		t.Fatalf("role %q missing: %v", roleID, err)
	}
	record.Set("max_characters_limit", limit)
	if err := app.Save(record); err != nil {
		t.Fatalf("failed to set the role character limit: %v", err)
	}
}

// TestCharacterCapIsEnforcedServerSide pins the cap on the FORUM-WIDE setting
// - the number the admin panel edits.
func TestCharacterCapIsEnforcedServerSide(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The player's role row has no explicit max_characters_limit, so the
	// forum-wide setting applies. Filling it exactly is the boundary that
	// matters: the limit counts existing rows, not requests.
	const cap = 2
	setCharacterLimit(t, app, cap)
	for i := 0; i < cap; i++ {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/me/characters",
			`{"name":"Mask `+string(rune('A'+i))+`","status_line":"","signature":""}`,
			tokens["player"], "test-idem-char-create-"+string(rune('a'+i)))
		if status != http.StatusCreated {
			t.Fatalf("create %d failed: %d %s", i, status, payload)
		}
	}

	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", `{"name":"One Too Many"}`,
		tokens["player"], "test-idem-char-over")
	if status != http.StatusConflict {
		t.Fatalf("expected 409 past the cap, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("Character limit")) {
		t.Fatalf("the refusal must name the reason: %s", payload)
	}
	// The refusal must state the NUMBER, so the member learns the cap instead
	// of guessing it.
	if !bytes.Contains(payload, []byte("2 masks maximum")) {
		t.Fatalf("the refusal must name the cap: %s", payload)
	}

	count, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixPlayerID})
	if err != nil {
		t.Fatal(err)
	}
	if int(count) != cap {
		t.Fatalf("a refused create must not write a row, got %d", count)
	}
}

// TestCharacterRoleLimitOverridesTheForumCap pins how a per-role limit and
// the forum-wide setting combine.
//
// The ROLE wins (owner's ruling, 2026-10-19): a role that states a number
// states the limit for its members, in either direction. The forum-wide
// setting is what a role INHERITS when it states nothing.
//
// The direction matters, so both are pinned: a role may narrow the cap AND
// widen it. A role that widens it is bounded by the same ceiling the
// forum-wide value is bound by, so no configuration makes masks unbounded.
func TestCharacterRoleLimitOverridesTheForumCap(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A role that wants FEWER masks than the forum allows gets fewer.
	setCharacterLimit(t, app, 5)
	setRoleCharacterLimit(t, app, string(auth.RolePlayer), 1)

	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", `{"name":"First"}`,
		tokens["player"], "test-idem-char-role-narrow")
	if status != http.StatusCreated {
		t.Fatalf("create 1 failed: %d %s", status, payload)
	}
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", `{"name":"Second"}`,
		tokens["player"], "test-idem-char-role-narrow-2")
	if status != http.StatusConflict {
		t.Fatalf("a role cap of 1 must refuse the second mask, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("1 masks maximum")) {
		t.Fatalf("the refusal must name the role's own cap: %s", payload)
	}

	// A role that asks for MORE than the forum allows gets it: the role's
	// statement is the specific one.
	setCharacterLimit(t, app, 2)
	setRoleCharacterLimit(t, app, string(auth.RolePlayer), 4)

	// The player already holds one mask from the case above, so three more fit
	// under the role's cap of four.
	for i := 0; i < 3; i++ {
		status, payload, _ = categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/me/characters",
			`{"name":"Extra `+string(rune('A'+i))+`"}`,
			tokens["player"], "test-idem-char-role-raise-"+string(rune('a'+i)))
		if status != http.StatusCreated {
			t.Fatalf("create %d failed: %d %s", i, status, payload)
		}
	}
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", `{"name":"One Too Many"}`,
		tokens["player"], "test-idem-char-role-raise-over")
	if status != http.StatusConflict {
		t.Fatalf("the role cap of 4 must refuse the fifth mask, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("4 masks maximum")) {
		t.Fatalf("the refusal must name the role's cap, not the forum-wide one: %s", payload)
	}

	// A role that states nothing inherits the forum-wide setting.
	setRoleCharacterLimit(t, app, string(auth.RolePlayer), 0)
	setCharacterLimit(t, app, 2)

	// The player holds four masks, so the inherited cap of 2 is already
	// exceeded — the refusal names the FORUM's number.
	status, payload, _ = categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", `{"name":"Inherited"}`,
		tokens["player"], "test-idem-char-role-inherit")
	if status != http.StatusConflict {
		t.Fatalf("the inherited forum cap of 2 must refuse another mask, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte("2 masks maximum")) {
		t.Fatalf("a role without a number must inherit the forum-wide cap: %s", payload)
	}
}

// TestCharacterOwnershipIsEnforced pins who may write to a mask.
//
// The OWNER always may. A staff member may too, but only with the matching
// `_others_mask` permission AND the owner's rank reachable under the owner's
// matrix — the legacy Firestore rules let isAdmin() manage anybody's
// characters, and the profile editor still gates those buttons on those keys.
//
// The cases below are a MEMBER without those permissions (a spectator): the
// refusal must be 403 and the row must survive it.
func TestCharacterOwnershipIsEnforced(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	ts := newTestServer(t, app)
	defer ts.Close()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		actor  string
		want   int
	}{
		{
			name:   "another account cannot patch",
			method: http.MethodPatch,
			path:   "/api/aerun/characters/charplayer00001",
			body:   `{"name":"Stolen"}`,
			actor:  "spectator",
			want:   http.StatusForbidden,
		},
		{
			name:   "another account cannot delete",
			method: http.MethodDelete,
			path:   "/api/aerun/characters/charplayer00001",
			body:   "",
			actor:  "spectator",
			want:   http.StatusForbidden,
		},
		{
			name:   "a banned account cannot create",
			method: http.MethodPost,
			path:   "/api/aerun/me/characters",
			body:   `{"name":"Nope"}`,
			actor:  "banned",
			want:   http.StatusForbidden,
		},
		{
			name:   "a guest cannot create",
			method: http.MethodPost,
			path:   "/api/aerun/me/characters",
			body:   `{"name":"Nope"}`,
			actor:  "",
			want:   http.StatusUnauthorized,
		},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, payload, _ := categoryCall(t, tc.method, ts.URL+tc.path, tc.body,
				tokens[tc.actor], "test-idem-char-own-"+string(rune('a'+i)))
			if status != tc.want {
				t.Fatalf("expected %d, got %d: %s", tc.want, status, payload)
			}
		})
	}

	rec, err := app.FindRecordById(charactersCollectionName, "charplayer00001")
	if err != nil || rec == nil {
		t.Fatalf("the character must survive every refused call: %v", err)
	}
	if rec.GetString("name") != "Player Mask" {
		t.Fatalf("a refused patch must not change the row, got %q", rec.GetString("name"))
	}
}

// TestStaffManagesAnotherAccountsMask pins the staff half of the write
// commands: a staff member holding the `_others_mask` key may edit and delete
// a mask that belongs to somebody else, and the row it acts on is the OWNER's.
//
// The moderator is the interesting actor: it holds the permission, and the
// player it acts on is strictly lower, so the rank matrix allows it.
func TestStaffManagesAnotherAccountsMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload, _ := categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/characters/charplayer00001",
		`{"name":"Moderated"}`,
		tokens["moderator"], "test-idem-char-staff-patch")
	if status != http.StatusOK {
		t.Fatalf("staff patch of another account's mask = %d, want 200: %s", status, payload)
	}
	rec, err := app.FindRecordById(charactersCollectionName, "charplayer00001")
	if err != nil || rec == nil {
		t.Fatalf("the mask must survive the staff patch: %v", err)
	}
	if rec.GetString("name") != "Moderated" {
		t.Fatalf("the staff patch must reach the owner's row, got %q", rec.GetString("name"))
	}
	if rec.GetString("owner_id") != fixPlayerID {
		t.Fatalf("the owner must not change, got %q", rec.GetString("owner_id"))
	}

	status, payload, _ = categoryCall(t, http.MethodDelete,
		ts.URL+"/api/aerun/characters/charplayer00001",
		"",
		tokens["moderator"], "test-idem-char-staff-delete")
	if status != http.StatusOK {
		t.Fatalf("staff delete of another account's mask = %d, want 200: %s", status, payload)
	}
	if _, err := app.FindRecordById(charactersCollectionName, "charplayer00001"); err == nil {
		t.Fatal("the staff delete must remove the owner's row")
	}
}

// TestStaffCreateRefusesAPeerOfEqualRank pins the rank half of the staff
// path.
//
// The permission says the ACTION may be aimed at somebody else; the rank
// matrix says WHOM. A moderator holds create_others_mask, so without the rank
// rule they could create masks for an admin — staff authority aimed upward.
func TestStaffCreateRefusesAPeerOfEqualRank(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	// A SECOND moderator: the peer must be somebody else, or the request is
	// the self-service branch and never reaches the rank matrix.
	peerModeratorID := "usermoder000002"
	createTestUser(t, app, peerModeratorID, "mod2@example.com", "ModTwo", auth.RoleModerator, auth.StatusActive)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A moderator creating a mask for another MODERATOR: equal rank is out.
	status, payload, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/users/"+peerModeratorID+"/characters",
		`{"name":"Peer Mask"}`,
		tokens["moderator"], "test-idem-char-staff-peer")
	if status != http.StatusForbidden {
		t.Fatalf("a moderator creating for a peer = %d, want 403: %s", status, payload)
	}
	owned, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": peerModeratorID})
	if err != nil {
		t.Fatal(err)
	}
	if owned != 0 {
		t.Fatalf("a refused staff create must not write a row, got %d", owned)
	}
}

// TestStaffDeleteRespectsTheOwnersCurrentMask pins the guard's owner.
//
// "The current mask" pointer belongs to the account that OWNS the mask. A
// staff member deleting somebody else's mask must be stopped by the OWNER's
// selection: the owner's profile would otherwise point at a row that no
// longer exists, and the owner is the one who would see it.
func TestStaffDeleteRespectsTheOwnersCurrentMask(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	owner, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	owner.Set("last_selected_character_id", "charplayer00001")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload, _ := categoryCall(t, http.MethodDelete,
		ts.URL+"/api/aerun/characters/charplayer00001",
		"",
		tokens["root"], "test-idem-char-staff-del-selected")
	if status != http.StatusConflict {
		t.Fatalf("staff delete of the owner's current mask = %d, want 409: %s", status, payload)
	}
	if _, err := app.FindRecordById(charactersCollectionName, "charplayer00001"); err != nil {
		t.Fatal("the refused delete must leave the mask in place")
	}
}

// setCharactersEnabled flips the forum's mask switch, the way the admin
// panel's PATCH does.
func setCharactersEnabled(t testing.TB, app *tests.TestApp, enabled bool) {
	t.Helper()
	record, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || record == nil {
		t.Fatalf("forum settings row missing: %v", err)
	}
	record.Set("enable_characters", enabled)
	if err := app.Save(record); err != nil {
		t.Fatalf("failed to toggle the character system: %v", err)
	}
}

// TestDisabledCharacterSystemRefusesWrites pins what the admin switch does.
//
// The switch was decorative for its whole life: stored, published in the
// public snapshot, and read by nobody. Now it is enforced, and the
// asymmetry is the point:
//
//   - WRITES are refused (403): no new masks, no edits, no deletes, no
//     avatar uploads.
//   - READS stay allowed. Posts carry `author_character_id`, so refusing to
//     read a mask would strip the author's name from every message they
//     ever wrote under it. Switching the system off is not erasing what
//     already exists.
func TestDisabledCharacterSystemRefusesWrites(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	ts := newTestServer(t, app)
	defer ts.Close()

	setCharactersEnabled(t, app, false)

	writes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/aerun/me/characters", `{"name":"New Mask"}`},
		{http.MethodPost, "/api/aerun/users/" + fixPlayerID + "/characters", `{"name":"Staff Mask"}`},
		{http.MethodPatch, "/api/aerun/characters/charplayer00001", `{"name":"Renamed"}`},
		{http.MethodDelete, "/api/aerun/characters/charplayer00001", ""},
		{http.MethodPut, "/api/aerun/characters/charplayer00001/avatar", ""},
	}
	for i, w := range writes {
		status, payload, _ := categoryCall(t, w.method, ts.URL+w.path, w.body,
			tokens["player"], fmt.Sprintf("test-idem-char-disabled-%d", i))
		if status != http.StatusForbidden {
			t.Fatalf("%s %s must be refused while the mask system is off, got %d: %s",
				w.method, w.path, status, payload)
		}
	}

	// The mask survived every refusal.
	if _, err := app.FindRecordById(charactersCollectionName, "charplayer00001"); err != nil {
		t.Fatal("a refused write must not touch the mask")
	}

	// READING still works: the message this mask signed stays readable.
	status, payload, _ := categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/characters/charplayer00001", "", tokens["player"], "")
	if status != http.StatusOK {
		t.Fatalf("reading a mask must stay available, got %d: %s", status, payload)
	}
	status, payload, _ = categoryCall(t, http.MethodGet,
		ts.URL+"/api/aerun/users/"+fixPlayerID+"/characters", "", tokens["player"], "")
	if status != http.StatusOK {
		t.Fatalf("listing masks must stay available, got %d: %s", status, payload)
	}
}

// TestDisabledCharacterSystemPostsUnderTheAccount pins the last effect of the
// switch.
//
// A member who picked a mask before the admin switched the system off must
// not keep posting under it. The server resolves the mask, so the answer is
// "no mask" — the post goes out under the account.
func TestDisabledCharacterSystemPostsUnderTheAccount(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	owner, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	owner.Set("last_selected_character_id", "charplayer00001")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	// While the system is on, the stored selection is honoured.
	resolved, err := resolveAuthorCharacter(app, fixPlayerID, "")
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "charplayer00001" {
		t.Fatalf("the stored mask must be used while the system is on, got %q", resolved)
	}

	setCharactersEnabled(t, app, false)

	// Now it is not — neither the requested id nor the stored one survives.
	resolved, err = resolveAuthorCharacter(app, fixPlayerID, "charplayer00001")
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "" {
		t.Fatalf("a disabled mask system must post under the account, got %q", resolved)
	}
	resolved, err = resolveAuthorCharacter(app, fixPlayerID, "")
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "" {
		t.Fatalf("a disabled mask system must not fall back to the stored mask, got %q", resolved)
	}
}

func TestCharacterDeleteRefusesWhenSelected(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charplayer00001", fixPlayerID, "Player Mask")

	owner, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	owner.Set("last_selected_character_id", "charplayer00001")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload, _ := categoryCall(t, http.MethodDelete,
		ts.URL+"/api/aerun/characters/charplayer00001", "",
		tokens["player"], "test-idem-char-del-selected")
	if status != http.StatusConflict {
		t.Fatalf("expected 409 while the character is the current mask, got %d: %s", status, payload)
	}

	// Clearing the reference makes the delete succeed — the refusal has to be
	// actionable, not a dead end.
	owner.Set("last_selected_character_id", "")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	status, payload, _ = categoryCall(t, http.MethodDelete,
		ts.URL+"/api/aerun/characters/charplayer00001", "",
		tokens["player"], "test-idem-char-del-ok")
	if status != http.StatusOK {
		t.Fatalf("expected 200 once unreferenced, got %d: %s", status, payload)
	}
}

func TestCharacterMutationIsIdempotentAndAudited(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	const key = "test-idem-char-replay"
	body := `{"name":"Idempotent","status_line":"s","signature":"g"}`

	status, first, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", body, tokens["player"], key)
	if status != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", status, first)
	}

	status, second, header := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/me/characters", body, tokens["player"], key)
	if status != http.StatusCreated {
		t.Fatalf("replay must return the original status, got %d: %s", status, second)
	}
	if header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay must be flagged: %v", header)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("replay must be byte-identical:\n first: %s\nsecond: %s", first, second)
	}

	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(first, &created); err != nil {
		t.Fatal(err)
	}

	logs, err := app.FindRecordsByFilter(auditLogsCollectionName, "action_type = 'character_created'", "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected one character_created audit row, got %d", len(logs))
	}

	status, payload, _ := categoryCall(t, http.MethodPatch,
		ts.URL+"/api/aerun/characters/"+created.ID,
		`{"name":"Renamed"}`, tokens["player"], "test-idem-char-patch")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, payload)
	}
	if !bytes.Contains(payload, []byte(`"name":"Renamed"`)) {
		t.Fatalf("the patch must be reflected: %s", payload)
	}
	// The omitted fields must survive: a PATCH that blanks them would erase a
	// signature the form never loaded.
	if !bytes.Contains(payload, []byte(`"status_line":"s"`)) ||
		!bytes.Contains(payload, []byte(`"signature":"g"`)) {
		t.Fatalf("a PATCH must leave omitted fields alone: %s", payload)
	}
}
