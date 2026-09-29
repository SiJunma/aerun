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
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
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

	t.Run("a pending owner's characters are not public", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/users/"+fixPendingID+"/characters")
		if status != http.StatusNotFound {
			t.Fatalf("expected 404 for a pending owner, got %d: %s", status, body)
		}
		if bytes.Contains(body, []byte("Pending Mask")) {
			t.Fatalf("a pending owner's characters must not leak: %s", body)
		}
	})

	t.Run("a pending owner still reads their own", func(t *testing.T) {
		// Same escape the users ViewRule grants: an account always reads itself,
		// so the owner can still manage the masks they present with.
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPendingID+"/characters", tokens["pending"])
		if status != http.StatusOK {
			t.Fatalf("expected 200 for the owner, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte("Pending Mask")) {
			t.Fatalf("the owner must see their own characters: %s", body)
		}
	})

	t.Run("a single character respects the same rule", func(t *testing.T) {
		status, body := getAerun(t, ts.URL+"/api/aerun/characters/charplayer00001")
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		if !bytes.Contains(body, []byte(`"owner_id":"`+fixPlayerID+`"`)) {
			t.Fatalf("payload must name the owner: %s", body)
		}

		status, body = getAerun(t, ts.URL+"/api/aerun/characters/charbanned00001")
		if status != http.StatusNotFound {
			t.Fatalf("expected 404 for a banned owner's character, got %d: %s", status, body)
		}
	})
}

func TestCharacterCapIsEnforcedServerSide(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The player's role row has no explicit max_characters_limit, so the
	// compiled default applies. Filling it exactly is the boundary that matters:
	// the limit counts existing rows, not requests.
	for i := 0; i < defaultCharacterLimit; i++ {
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

	count, err := app.CountRecords(charactersCollectionName, dbx.HashExp{"owner_id": fixPlayerID})
	if err != nil {
		t.Fatal(err)
	}
	if int(count) != defaultCharacterLimit {
		t.Fatalf("a refused create must not write a row, got %d", count)
	}
}

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
			actor:  "moderator",
			want:   http.StatusForbidden,
		},
		{
			name:   "another account cannot delete",
			method: http.MethodDelete,
			path:   "/api/aerun/characters/charplayer00001",
			body:   "",
			actor:  "root",
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
