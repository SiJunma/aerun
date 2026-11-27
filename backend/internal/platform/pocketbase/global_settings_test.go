package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
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

	payload := `{"forumName":"Мир Драконов","headerHtml":"<p>Привет!</p>","customFooterHtml":"<p>Футер</p>","topicsPerPage":35,"postsPerPage":40}`
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

	// Verify the response carries the new forum name as a plain string: the
	// handler reads back the stored snapshot and returns it, so a divergence
	// here means the write did not reach the row the snapshot reads from.
	rawName, ok := resp.Settings["forumName"]
	if !ok {
		t.Fatal("response must contain forumName")
	}
	if rawName != "Мир Драконов" {
		t.Fatalf("expected forumName=%q (plain string), got %v", "Мир Драконов", rawName)
	}
	if resp.Settings["headerHtml"] != "<p>Привет!</p>" {
		t.Fatalf("expected headerHtml=%q, got %v", "<p>Привет!</p>", resp.Settings["headerHtml"])
	}
	if resp.Settings["customFooterHtml"] != "<p>Футер</p>" {
		t.Fatalf("expected customFooterHtml=%q, got %v", "<p>Футер</p>", resp.Settings["customFooterHtml"])
	}
	// The surfaces rework removed the bilingual banner and the per-theme
	// backgrounds from the snapshot entirely.
	for _, removed := range []string{"welcomeMessage", "bgLight", "bgDark", "bgNeutral", "bgOpacityLight", "bgOpacityDark", "bgOpacityNeutral"} {
		if _, ok := resp.Settings[removed]; ok {
			t.Fatalf("settings must not contain %q", removed)
		}
	}
	// ... and the row must hold the plain string, not a bilingual map.
	if got := reloaded.GetString("forum_name"); got != "Мир Драконов" {
		t.Fatalf("expected forum_name=%q in db, got %q", "Мир Драконов", got)
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

// setTestUserTheme writes users.settings.theme for one fixture account
// ("" clears the key). The snapshot resolves the active card for the
// REQUESTING user, so the tests below set the theme on the record and then
// read the snapshot as that user.
func setTestUserTheme(t testing.TB, app *tests.TestApp, userID, theme string) {
	t.Helper()
	rec, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil {
		t.Fatalf("find user %s: %v", userID, err)
	}
	settings, err := decodeSettings(rec)
	if err != nil {
		t.Fatalf("decode user settings: %v", err)
	}
	if theme == "" {
		delete(settings, "theme")
	} else {
		settings["theme"] = theme
	}
	rec.Set("settings", settings)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save user theme: %v", err)
	}
}

// fetchSettingsActiveDesign reads GET /api/aerun/settings as one actor and
// returns the embedded activeDesign card. It fails the test when the
// snapshot carries no card: the chrome must never boot without one.
func fetchSettingsActiveDesign(t testing.TB, serverURL, token string) map[string]any {
	t.Helper()
	status, body := getAerunAuthed(t, serverURL+"/api/aerun/settings", token)
	if status != http.StatusOK {
		t.Fatalf("GET /settings = %d: %s", status, body)
	}
	var resp struct {
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("invalid settings json: %v", err)
	}
	card, _ := resp.Settings["activeDesign"].(map[string]any)
	if card == nil {
		t.Fatalf("settings must embed activeDesign: %s", body)
	}
	return card
}

// TestGlobalSettingsEmbedsActiveDesign pins the init payload: the snapshot
// carries the requesting visitor's resolved active card, so the chrome can
// apply it the moment the settings arrive instead of waiting for the full
// design lists.
//
// The seeded light card is «Светлая» (migration 1781000012): the brief's
// "Snow Mountains" is the name that card carries on the user's own stand,
// where it was renamed through the admin panel — the seed, and therefore
// this test, uses the seeded name.
func TestGlobalSettingsEmbedsActiveDesign(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Logged-in member with theme 'light' gets the light card embedded.
	setTestUserTheme(t, app, fixPlayerID, "light")
	card := fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("player theme light: activeDesign = %v, want the light default card", card)
	}
	if card["name"] != "Светлая" {
		t.Fatalf("player theme light: name = %v, want «Светлая»", card["name"])
	}
	// The card must carry everything the chrome needs — background URLs,
	// header/footer, title, favicon, placeholders, css/js and the
	// overwrite flags — not just an id the client would have to resolve.
	// (No bg_opacity assertion: item G removes the background-opacity
	// feature, so this test must not depend on it.)
	for _, field := range []string{
		"bg_default_url", "bg_tablet_url", "bg_mobile_url",
		"header_html", "custom_footer_html", "forum_title", "favicon_url",
		"placeholder_deleted_url", "placeholder_guest_url",
		"css", "js",
		"overwrite_header", "overwrite_footer", "overwrite_title",
		"overwrite_favicon", "overwrite_css", "overwrite_js",
		"overwrite_placeholder_deleted", "overwrite_placeholder_guest",
	} {
		if _, ok := card[field]; !ok {
			t.Errorf("activeDesign is missing %q", field)
		}
	}

	// Guest and member without a theme get the forum default. The seed
	// leaves default_design_id empty, so the forum default is unresolvable
	// and the ultimate fallback — the built-in dark card — applies.
	card = fetchSettingsActiveDesign(t, ts.URL, "")
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("guest: activeDesign = %v, want the dark fallback card", card)
	}
	setTestUserTheme(t, app, fixPlayerID, "")
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("member without theme: activeDesign = %v, want the dark fallback card", card)
	}
}

// TestGlobalSettingsActiveDesignFollowsForumDefault pins the guest path:
// with no theme of their own, a visitor gets the forum's configured
// default — and a member's own theme still wins over it.
func TestGlobalSettingsActiveDesignFollowsForumDefault(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings",
		`{"defaultDesignId":"light"}`, tokens["root"], "test-idem-settings-default-light")
	if status != http.StatusOK {
		t.Fatalf("admin set defaultDesignId = %d: %s", status, body)
	}
	// The PATCH response itself carries the snapshot, resolved for the
	// requesting admin (no theme of their own) — so it already shows the
	// new default.
	var patched struct {
		Settings map[string]any `json:"settings"`
	}
	if err := json.Unmarshal(body, &patched); err != nil {
		t.Fatal(err)
	}
	patchedCard, _ := patched.Settings["activeDesign"].(map[string]any)
	if patchedCard == nil || patchedCard["key"] != "light" {
		t.Fatalf("PATCH response activeDesign = %v, want the light card", patchedCard)
	}

	card := fetchSettingsActiveDesign(t, ts.URL, "")
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("guest: activeDesign = %v, want the forum default (light)", card)
	}
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("member without theme: activeDesign = %v, want the forum default (light)", card)
	}

	setTestUserTheme(t, app, fixPlayerID, "dark")
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("member theme dark: activeDesign = %v, want dark, not the forum default", card)
	}
}

// TestGlobalSettingsEmbedsActiveCustomDesign pins the custom-design branch:
// a member whose theme is a custom design id gets that design embedded,
// with its base theme — and a deactivated design falls back safely.
func TestGlobalSettingsEmbedsActiveCustomDesign(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	id := createTestDesign(t, ts.URL, tokens["root"], "MemberTheme")
	// New designs are born inactive (the admin panel creates with
	// is_active=false and activates explicitly), so activate it first —
	// otherwise the resolver correctly falls back to the forum default.
	status, _, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/designs/"+id,
		`{"is_active":true}`, tokens["root"], "test-idem-settings-activate-theme")
	if status != http.StatusOK {
		t.Fatalf("activate design = %d", status)
	}
	setTestUserTheme(t, app, fixPlayerID, id)

	card := fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "custom" || card["id"] != id {
		t.Fatalf("member custom theme: activeDesign = %v, want the custom design %s", card, id)
	}
	if card["name"] != "MemberTheme" {
		t.Fatalf("member custom theme: name = %v, want MemberTheme", card["name"])
	}
	if card["base_theme"] != "dark" {
		t.Fatalf("member custom theme: base_theme = %v, want dark (create default)", card["base_theme"])
	}

	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/designs/"+id,
		`{"is_active":false}`, tokens["root"], "test-idem-settings-deactivate-theme")
	if status != http.StatusOK {
		t.Fatalf("deactivate design = %d", status)
	}
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("deactivated custom theme: activeDesign = %v, want the dark fallback card", card)
	}
}

// TestGlobalSettingsActiveDesignFallbacks pins the fallback chain for
// targets that cannot be used: an unknown id, a built-in removed from the
// list, and — the exception that proves the rule — a forum default removed
// from the list, which stays usable as the fallback.
func TestGlobalSettingsActiveDesignFallbacks(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// Unknown/removed theme: a custom design id that was never created (or
	// has since been deleted) falls back to the forum default, then dark.
	setTestUserTheme(t, app, fixPlayerID, "design-that-does-not-exist")
	card := fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("unknown theme: activeDesign = %v, want the dark fallback card", card)
	}

	// Built-in removed from the list: hiding the light card un-lists it, so
	// a member who still has it selected falls back to the forum default.
	setTestUserTheme(t, app, fixPlayerID, "light")
	status, _, _ := categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/default-designs/light",
		`{"show_in_list":false}`, tokens["root"], "test-idem-settings-hide-light")
	if status != http.StatusOK {
		t.Fatalf("hide light card = %d", status)
	}
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "dark" {
		t.Fatalf("hidden light theme: activeDesign = %v, want the dark fallback card", card)
	}

	// Hidden forum default: the default itself stays usable as the fallback
	// even when removed from the list — it just can no longer be
	// (re-)selected. The member above keeps their (hidden) light theme as
	// the forum default now, so the snapshot must still embed it.
	status, _, _ = categoryCall(t, http.MethodPatch, ts.URL+"/api/aerun/admin/settings",
		`{"defaultDesignId":"light"}`, tokens["root"], "test-idem-settings-default-hidden-light")
	if status != http.StatusOK {
		t.Fatalf("set defaultDesignId to hidden light = %d", status)
	}
	card = fetchSettingsActiveDesign(t, ts.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("hidden forum default: activeDesign = %v, want the light card anyway", card)
	}
	card = fetchSettingsActiveDesign(t, ts.URL, "")
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("guest with hidden forum default: activeDesign = %v, want the light card", card)
	}
}
