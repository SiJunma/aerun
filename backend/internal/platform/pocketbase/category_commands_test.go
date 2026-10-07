package pocketbase

// Tests for the TASK-2 category / category-group commands.
//
// The admin Categories tab was dead because its writes went to a locked browser
// API, so these exercise the raw HTTP surface end to end (plan §7): permission
// matrix, validation, conflict answers, idempotent replay and the audit row that
// must land in the same transaction as the domain change.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// bytesContains is a short alias for the payload assertions below; every check
// is a substring test on the raw JSON, which keeps the expectations readable.
func bytesContains(payload []byte, needle string) bool {
	return bytes.Contains(payload, []byte(needle))
}

// categoryCall performs a JSON command request with the standard headers.
func categoryCall(t testing.TB, method, path, body, token, idemKey string) (int, []byte, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, path, bodyReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, payload, res.Header
}

// seedTestCategoryGroup creates a category group and returns its id.
//
// Every category must now name a group: one that does not is invisible on the
// forum index. Tests about permissions, slugs or idempotency are not about
// groups, so they seed one rather than re-assert the rule each time — the rule
// itself is pinned by TestCreateCategoryRequiresAGroup.
func seedTestCategoryGroup(t testing.TB, app *tests.TestApp) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(categoryGroupsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("title", "Test Group")
	rec.Set("sort_order", 0)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return rec.Id
}

// A category outside every group is invisible on the forum index, so creating
// one is refused outright rather than producing a row nobody can reach.
//
// This is the rule the admin UI gates on, and the reason the rule exists at
// all: without it an admin can create a category that is stored perfectly well
// and never rendered, with no indication of why.
func TestCreateCategoryRequiresAGroup(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("no group_id is refused and explains why", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"name":"Nowhere"}`,
			tokens["root"], "test-idem-cat-nogroup")
		if status != http.StatusBadRequest {
			t.Fatalf("a category with no group must be refused, got %d: %s", status, payload)
		}
		if !bytesContains(payload, "group") {
			t.Fatalf("the 400 must name the missing group: %s", payload)
		}

		count, err := app.CountRecords(categoriesCollectionName, dbx.HashExp{"name": "Nowhere"})
		if err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("a refused create must not persist a row, found %d", count)
		}
	})

	t.Run("a named group is accepted", func(t *testing.T) {
		groupID := seedTestCategoryGroup(t, app)
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories",
			`{"name":"Visible","group_id":"`+groupID+`"}`,
			tokens["root"], "test-idem-cat-withgroup")
		if status != http.StatusCreated {
			t.Fatalf("a category inside a group must be created, got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"group_id":"`+groupID+`"`) {
			t.Fatalf("the stored row must keep the group: %s", payload)
		}
	})
}

func TestCreateCategoryPermissionMatrix(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	groupID := seedTestCategoryGroup(t, app)
	body := `{"name":"Lore","description":"Backstory","allowed_roles":["player","admin"],"sort_order":3,"group_id":"` + groupID + `"}`

	cases := []struct {
		name   string
		actor  string
		status int
	}{
		{name: "anonymous is refused", actor: "", status: http.StatusUnauthorized},
		{name: "player is forbidden", actor: "player", status: http.StatusForbidden},
		{name: "moderator is forbidden", actor: "moderator", status: http.StatusForbidden},
		{name: "admin may create", actor: "root", status: http.StatusCreated},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, payload, _ := categoryCall(t, http.MethodPost,
				ts.URL+"/api/aerun/categories", body, tokens[tc.actor],
				"test-idem-cat-create-"+string(rune('a'+i)))
			if status != tc.status {
				t.Fatalf("expected %d, got %d: %s", tc.status, status, payload)
			}
		})
	}
}

func TestCreateCategoryValidationAndSlug(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()
	groupID := seedTestCategoryGroup(t, app)

	t.Run("missing name is rejected", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"description":"no name"}`,
			tokens["root"], "test-idem-cat-noname")
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", status, payload)
		}
	})

	t.Run("unknown role id names the offender", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"name":"Ghost","allowed_roles":["nosuchrole"]}`,
			tokens["root"], "test-idem-cat-badrole")
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", status, payload)
		}
		if !bytesContains(payload, "nosuchrole") {
			t.Fatalf("the 400 must name the unknown role: %s", payload)
		}
	})

	t.Run("a custom role id is accepted", func(t *testing.T) {
		// ADR-2: custom roles are first-class rows, and the legacy data grants a
		// category to one by id. Rejecting it would make "Скрытые игры"
		// impossible to reproduce.
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/roles",
			`{"role_id":"demon","name":"Demon","rank":250,"base_role_id":"player","permissions":["view_forum"]}`,
			tokens["root"], "test-idem-role-demon")
		if status != http.StatusCreated {
			t.Fatalf("failed to create the custom role: %d %s", status, payload)
		}

		status, payload, _ = categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"name":"Hidden Games","allowed_roles":["demon"],"group_id":"`+groupID+`"}`,
			tokens["root"], "test-idem-cat-customrole")
		if status != http.StatusCreated {
			t.Fatalf("expected 201 for a custom-role category, got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"allowed_roles":["demon"]`) {
			t.Fatalf("the stored list must name the custom role: %s", payload)
		}
	})

	t.Run("slug is derived from the name", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"name":"Общий раздел","slug":"client-supplied","group_id":"`+groupID+`"}`,
			tokens["root"], "test-idem-cat-slug")
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", status, payload)
		}
		// О-б-щ-и-й → o-b-sch-i-i, " раздел" → "razdel". The exact spelling is
		// the point only up to "derived on the server": what must not happen is
		// the client's slug surviving, because it is the UNIQUE key.
		if !bytesContains(payload, `"slug":"obschii-razdel"`) {
			t.Fatalf("slug must be server-derived and transliterated: %s", payload)
		}
		if bytesContains(payload, "client-supplied") {
			t.Fatalf("the client slug must be ignored: %s", payload)
		}
	})

	t.Run("duplicate slug is a conflict", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories", `{"name":"Общий раздел","group_id":"`+groupID+`"}`,
			tokens["root"], "test-idem-cat-dupslug")
		if status != http.StatusConflict {
			t.Fatalf("expected 409 for a duplicate slug, got %d: %s", status, payload)
		}
	})
}

func TestCategoryIdempotentReplayAndAudit(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	body := `{"name":"Replays","allowed_roles":["player"],"sort_order":7,"group_id":"` + seedTestCategoryGroup(t, app) + `"}`
	const key = "test-idem-cat-replay"

	status, first, _ := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/categories", body, tokens["root"], key)
	if status != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", status, first)
	}

	status, second, header := categoryCall(t, http.MethodPost,
		ts.URL+"/api/aerun/categories", body, tokens["root"], key)
	if status != http.StatusCreated {
		t.Fatalf("replay must return the original status, got %d: %s", status, second)
	}
	if header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay must be flagged: %v", header)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("replay must return the stored bytes verbatim:\n first: %s\nsecond: %s", first, second)
	}

	count, err := app.CountRecords(categoriesCollectionName, dbx.HashExp{"slug": "replays"})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("a replayed create must not duplicate the row, got %d rows", count)
	}

	// The audit row is written in the same transaction as the domain change.
	logs, err := app.FindRecordsByFilter(auditLogsCollectionName, "action_type = 'category_created'", "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected exactly one category_created audit row, got %d", len(logs))
	}
	if logs[0].GetString("performer_id") != fixRootID {
		t.Fatalf("audit row must name the performer, got %q", logs[0].GetString("performer_id"))
	}
}

func TestCategoryGroupLifecycle(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("player cannot create a group", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/category-groups", `{"title":"Lore"}`,
			tokens["player"], "test-idem-group-player")
		if status != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", status, payload)
		}
	})

	var groupID string
	t.Run("root creates a group at the tail of the list", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/category-groups", `{"title":"Lore"}`,
			tokens["root"], "test-idem-group-create")
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", status, payload)
		}
		var created struct {
			ID        string `json:"id"`
			SortOrder int    `json:"sort_order"`
		}
		if err := json.Unmarshal(payload, &created); err != nil {
			t.Fatalf("decode: %v (%s)", err, payload)
		}
		groupID = created.ID
		if created.SortOrder != 0 {
			t.Fatalf("the first group must land at sort_order 0, got %d", created.SortOrder)
		}
	})

	var catID string
	t.Run("a category can join the group", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories",
			`{"name":"Grouped","group_id":"`+groupID+`","allowed_roles":["player"]}`,
			tokens["root"], "test-idem-cat-grouped")
		if status != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", status, payload)
		}
		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(payload, &created); err != nil {
			t.Fatal(err)
		}
		catID = created.ID
	})

	t.Run("a referenced group cannot be deleted", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/category-groups/"+groupID, "",
			tokens["root"], "test-idem-group-delete-ref")
		if status != http.StatusConflict {
			t.Fatalf("expected 409 while the group still holds categories, got %d: %s", status, payload)
		}
	})

	t.Run("an unknown group reference is rejected", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories",
			`{"name":"Nowhere","group_id":"doesnotexist99"}`,
			tokens["root"], "test-idem-cat-badgroup")
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400 for a dangling group_id, got %d: %s", status, payload)
		}
	})

	t.Run("the group is deletable once it is empty", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPatch,
			ts.URL+"/api/aerun/categories/"+catID, `{"group_id":""}`,
			tokens["root"], "test-idem-cat-ungroup")
		if status != http.StatusOK {
			t.Fatalf("failed to ungroup the category: %d %s", status, payload)
		}

		status, payload, _ = categoryCall(t, http.MethodDelete,
			ts.URL+"/api/aerun/category-groups/"+groupID, "",
			tokens["root"], "test-idem-group-delete")
		if status != http.StatusOK {
			t.Fatalf("expected 200 once empty, got %d: %s", status, payload)
		}
	})
}

// TestCategoryLabelsRoundTripBothLanguages pins the fix for "the EN key never
// saves". The command contract used to collapse {en, ru} to one string on the
// way in (pickTitle kept Russian) and duplicate it back into both languages on
// the way out, so an EN edit was accepted, dropped, and served as the RU text —
// the toast said "saved" while English reverted. Every half of that round trip
// is asserted here: the object travels in, both languages are stored, both are
// served, and editing one language cannot wipe the other.
func TestCategoryLabelsRoundTripBothLanguages(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	t.Run("a bilingual group title is stored and served in both languages", func(t *testing.T) {
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/category-groups",
			`{"title":{"en":"General Chat","ru":"Общение"}}`,
			tokens["root"], "test-idem-bilingual-group-create")
		if status != http.StatusCreated {
			t.Fatalf("bilingual group create: got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"en":"General Chat"`) || !bytesContains(payload, `"ru":"Общение"`) {
			t.Fatalf("the group payload must carry both languages: %s", payload)
		}

		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(payload, &created); err != nil {
			t.Fatalf("decode: %v (%s)", err, payload)
		}

		// The legacy column keeps the PRIMARY rendering (Russian): slug
		// derivation, the importer's match checks and audit rows read it as a
		// plain string and must never see JSON.
		stored, err := app.FindRecordById(categoryGroupsCollectionName, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got := stored.GetString("title"); got != "Общение" {
			t.Fatalf("legacy title must stay the RU primary, got %q", got)
		}
		i18n, err := json.Marshal(stored.Get("title_i18n"))
		if err != nil {
			t.Fatalf("marshal title_i18n: %v", err)
		}
		if !bytes.Contains(i18n, []byte("General Chat")) || !bytes.Contains(i18n, []byte("Общение")) {
			t.Fatalf("title_i18n must hold both languages, got %s", i18n)
		}

		// PATCH naming ONLY en must leave ru alone — this is the exact shape a
		// partial edit used to wipe the other language with.
		status, payload, _ = categoryCall(t, http.MethodPatch,
			ts.URL+"/api/aerun/category-groups/"+created.ID,
			`{"title":{"en":"Lobby"}}`,
			tokens["root"], "test-idem-bilingual-group-patch")
		if status != http.StatusOK {
			t.Fatalf("EN-only patch: got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"en":"Lobby"`) {
			t.Fatalf("the EN edit did not apply: %s", payload)
		}
		if !bytesContains(payload, `"ru":"Общение"`) {
			t.Fatalf("an EN-only edit must not wipe RU: %s", payload)
		}
	})

	t.Run("a bilingual category round-trips through the list", func(t *testing.T) {
		groupID := seedTestCategoryGroup(t, app)
		status, payload, _ := categoryCall(t, http.MethodPost,
			ts.URL+"/api/aerun/categories",
			`{"name":{"en":"Echo of Beasts","ru":"Эхо зверя"},`+
				`"description":{"en":"EN description","ru":"RU description"},`+
				`"group_id":"`+groupID+`"}`,
			tokens["root"], "test-idem-bilingual-cat-create")
		if status != http.StatusCreated {
			t.Fatalf("bilingual category create: got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"en":"Echo of Beasts"`) || !bytesContains(payload, `"ru":"Эхо зверя"`) {
			t.Fatalf("the category payload must carry both name languages: %s", payload)
		}
		if !bytesContains(payload, `"en":"EN description"`) {
			t.Fatalf("the category payload must carry the EN description: %s", payload)
		}

		var created struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(payload, &created); err != nil {
			t.Fatalf("decode: %v (%s)", err, payload)
		}

		// The PUBLIC list is what the admin board reloads from — it must serve
		// the {en, ru} pair, not a collapsed string.
		status, listPayload, _ := categoryCall(t, http.MethodGet,
			ts.URL+"/api/aerun/categories", "",
			tokens["root"], "test-idem-bilingual-cat-list")
		if status != http.StatusOK {
			t.Fatalf("list categories: got %d: %s", status, listPayload)
		}
		if !bytesContains(listPayload, `"en":"Echo of Beasts"`) || !bytesContains(listPayload, `"ru":"Эхо зверя"`) {
			t.Fatalf("the list must serve both name languages: %s", listPayload)
		}

		// PATCH naming only en keeps ru — the EN edit sticks across saves.
		status, payload, _ = categoryCall(t, http.MethodPatch,
			ts.URL+"/api/aerun/categories/"+created.ID,
			`{"name":{"en":"Echoes"}}`,
			tokens["root"], "test-idem-bilingual-cat-patch")
		if status != http.StatusOK {
			t.Fatalf("EN-only patch: got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"en":"Echoes"`) {
			t.Fatalf("the EN edit did not apply: %s", payload)
		}
		if !bytesContains(payload, `"ru":"Эхо зверя"`) {
			t.Fatalf("an EN-only edit must not wipe RU: %s", payload)
		}
	})

	t.Run("a row written before bilingual storage serves its string in both languages", func(t *testing.T) {
		// The importer and every pre-1769200000 row carry the legacy column
		// only. The read path must duplicate that string into both languages —
		// what the collapsed contract served — rather than go blank.
		col, err := app.FindCollectionByNameOrId(categoryGroupsCollectionName)
		if err != nil {
			t.Fatal(err)
		}
		legacy := core.NewRecord(col)
		legacy.Set("title", "Legacy Group")
		legacy.Set("sort_order", 42)
		if err := app.Save(legacy); err != nil {
			t.Fatal(err)
		}

		status, payload, _ := categoryCall(t, http.MethodGet,
			ts.URL+"/api/aerun/category-groups", "",
			tokens["root"], "test-idem-bilingual-legacy-list")
		if status != http.StatusOK {
			t.Fatalf("list groups: got %d: %s", status, payload)
		}
		if !bytesContains(payload, `"en":"Legacy Group"`) || !bytesContains(payload, `"ru":"Legacy Group"`) {
			t.Fatalf("a legacy row must serve its string in both languages: %s", payload)
		}
	})
}
