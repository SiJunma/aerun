package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestGetGlobalSettingsPublic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	for _, who := range []string{"", "player", "root"} {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/settings", tokens[who])
		if status != http.StatusOK {
			t.Fatalf("%q: expected 200, got %d: %s", who, status, body)
		}
		var resp struct {
			Settings map[string]any `json:"settings"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("%q: invalid json: %v", who, err)
		}
		if resp.Settings == nil {
			t.Fatalf("%q: settings must not be nil", who)
		}
		if _, ok := resp.Settings["forumName"]; !ok {
			t.Fatalf("%q: settings must contain forumName", who)
		}
		if _, ok := resp.Settings["topicsPerPage"]; !ok {
			t.Fatalf("%q: settings must contain topicsPerPage", who)
		}
		if _, ok := resp.Settings["postsPerPage"]; !ok {
			t.Fatalf("%q: settings must contain postsPerPage", who)
		}
	}
}

func TestUpdateGlobalSettingsRequiresAdmin(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Anonymous caller: 401 Unauthorized (RequirePermission distinguishes guest
	// from authenticated-but-lacking-permission: guest → 401, authenticated → 403)
	status, _, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"topicsPerPage":25}`, "", "test-idem-settings-anon")
	if status != http.StatusUnauthorized {
		t.Fatalf("anonymous edit must be 401 Unauthorized, got %d", status)
	}

	// Non-admin player: forbidden (403)
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"topicsPerPage":25}`, tokens["player"], "test-idem-settings-player")
	if status != http.StatusForbidden {
		t.Fatalf("player edit must be forbidden, got %d", status)
	}
}

// TestUpdateGlobalSettingsSavesTheMaskLimit pins the admin panel's control
// over the per-account mask cap.
//
// The cap used to be a compiled constant nobody could change. It is now a
// forum-wide setting, so the panel's PATCH must store it, the snapshot must
// publish it, and the bounds must be enforced — a value the read path would
// clamp away is a value the admin believes they set and did not.
func TestUpdateGlobalSettingsSavesTheMaskLimit(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings",
		`{"maxCharactersPerUser":25}`, tokens["root"], "test-idem-settings-mask-limit")
	if status != http.StatusOK {
		t.Fatalf("admin edit must succeed, got %d: %s", status, body)
	}

	var resp struct {
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if resp.Settings["maxCharactersPerUser"] != float64(25) {
		t.Fatalf("expected maxCharactersPerUser=25, got %v", resp.Settings["maxCharactersPerUser"])
	}

	reloaded, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatalf("find forum_settings row: %v", err)
	}
	if got := reloaded.GetInt("max_characters_per_user"); got != 25 {
		t.Fatalf("expected max_characters_per_user=25 in db, got %d", got)
	}

	// Out of range: above the ceiling and below the floor. Both must be
	// refused, not silently clamped — a clamped write looks like it worked.
	outOfRange := []string{`{"maxCharactersPerUser":500}`, `{"maxCharactersPerUser":0}`}
	for i, payload := range outOfRange {
		status, body, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings",
			payload, tokens["root"], fmt.Sprintf("test-idem-settings-mask-limit-%d", i))
		if status != http.StatusBadRequest {
			t.Fatalf("%s must be refused, got %d: %s", payload, status, body)
		}
	}
}

func TestUpdateGlobalSettingsAdminSavesAndSyncsBrand(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	payload := `{"forumName":{"en":"Dragon Realm","ru":"Мир Драконов"},"topicsPerPage":35,"postsPerPage":40}`
	status, body, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", payload, tokens["root"], "test-idem-settings-admin")
	if status != http.StatusOK {
		t.Fatalf("admin edit must succeed, got %d: %s", status, body)
	}

	var resp struct {
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if resp.Settings["topicsPerPage"] != float64(35) {
		t.Fatalf("expected topicsPerPage=35, got %v", resp.Settings["topicsPerPage"])
	}
	if resp.Settings["postsPerPage"] != float64(40) {
		t.Fatalf("expected postsPerPage=40, got %v", resp.Settings["postsPerPage"])
	}

	// Verify database row
	reloaded, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil {
		t.Fatalf("find forum_settings row: %v", err)
	}
	if got := reloaded.GetInt("topics_per_page"); got != 35 {
		t.Fatalf("expected topics_per_page=35 in db, got %d", got)
	}

	// Verify the response carries the new forum name: the handler reads back
	// the stored snapshot and returns it, so a divergence here means the write
	// did not reach the row the snapshot reads from.
	rawName, ok := resp.Settings["forumName"]
	if !ok {
		t.Fatal("response must contain forumName")
	}
	if nameMap, ok := rawName.(map[string]any); !ok || nameMap["en"] != "Dragon Realm" {
		t.Fatalf("expected forumName.en=Dragon Realm, got %v", rawName)
	}
}

func TestUpdateGlobalSettingsValidatesBounds(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// topicsPerPage out of bounds (> 50)
	status, _, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"topicsPerPage":100}`, tokens["root"], "test-idem-settings-oob")
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for out-of-bounds topicsPerPage, got %d", status)
	}

	// maxCharsPerPost: 0 means "unlimited" since migration 1769000000 and must
	// be ACCEPTED. This assertion used to expect 400 for 0 and went stale when
	// the lower bound was deliberately dropped to 0 — the handler's bounds
	// check is `*n < 0 || *n > 1_000_000`, so the cases that remain refused
	// are negative and above the hard ceiling, and both are pinned below.
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"maxCharsPerPost":0}`, tokens["root"], "test-idem-settings-chars-zero")
	if status != http.StatusOK {
		t.Fatalf("0 maxCharsPerPost must be accepted as unlimited, got %d", status)
	}
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"maxCharsPerPost":-1}`, tokens["root"], "test-idem-settings-chars-negative")
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative maxCharsPerPost, got %d", status)
	}
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings", `{"maxCharsPerPost":1000001}`, tokens["root"], "test-idem-settings-chars-over")
	if status != http.StatusBadRequest {
		t.Fatalf("expected 400 for over-ceiling maxCharsPerPost, got %d", status)
	}
}
