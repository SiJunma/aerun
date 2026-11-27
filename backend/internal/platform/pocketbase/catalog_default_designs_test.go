package pocketbase

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Tests for the default-designs surface (PLAN_DESIGNS_TAB_SURFACES.md §7.3):
// public list/get of the three seeded cards, admin PATCH with the contract
// whitelist, 405 on create/delete, and the card background / placeholder /
// favicon uploads for both custom and default designs.

func createTestDesign(t testing.TB, serverURL, token, name string) string {
	t.Helper()
	status, body := postAerunWithHeaders(t, serverURL+"/api/aerun/designs", `{"name":"`+name+`"}`, map[string]string{
		"Authorization":   token,
		"Idempotency-Key": "test-idem-design-create-" + name,
	})
	if status != http.StatusCreated {
		t.Fatalf("POST /designs = %d: %s", status, body)
	}
	var created map[string]any
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatalf("created design has no id: %s", body)
	}
	return id
}

func TestDefaultDesignsPublicListAndGet(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	status, body := getAerun(t, server.URL+"/api/aerun/default-designs")
	if status != http.StatusOK {
		t.Fatalf("GET /default-designs = %d: %s", status, body)
	}
	var resp struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 3 {
		t.Fatalf("expected 3 default designs, got %d: %s", len(resp.Items), body)
	}
	want := []struct{ key, name string }{
		{"dark", "Тёмная"},
		{"light", "Светлая"},
		{"neutral", "Нейтральная"},
	}
	for i, w := range want {
		got := resp.Items[i]
		if got["key"] != w.key {
			t.Errorf("item %d key = %v, want %q", i, got["key"], w.key)
		}
		if got["name"] != w.name {
			t.Errorf("item %d name = %v, want %q", i, got["name"], w.name)
		}
		if got["show_in_list"] != true {
			t.Errorf("item %d show_in_list = %v, want true", i, got["show_in_list"])
		}
		// List items are summaries: exactly id, key, name, show_in_list,
		// bg_default_url. The heavy fields live only on the single GET.
		for _, present := range []string{"id", "bg_default_url"} {
			if _, ok := got[present]; !ok {
				t.Errorf("item %d must carry %q", i, present)
			}
		}
		for _, absent := range []string{
			"is_active", "base_theme",
			"css", "js", "header_html", "custom_footer_html", "forum_title",
			"favicon_url", "placeholder_deleted_url", "placeholder_guest_url",
			"description", "bg_tablet_url", "bg_mobile_url", "bg_opacity",
			"created_at", "updated_at",
			"overwrite_header", "overwrite_footer", "overwrite_title",
			"overwrite_favicon", "overwrite_css", "overwrite_js",
			"overwrite_placeholder_deleted", "overwrite_placeholder_guest",
		} {
			if _, ok := got[absent]; ok {
				t.Errorf("item %d must not carry %q", i, absent)
			}
		}
	}

	status, body = getAerun(t, server.URL+"/api/aerun/default-designs/dark")
	if status != http.StatusOK {
		t.Fatalf("GET /default-designs/dark = %d: %s", status, body)
	}
	var one map[string]any
	if err := json.Unmarshal(body, &one); err != nil {
		t.Fatal(err)
	}
	if one["key"] != "dark" || one["name"] != "Тёмная" {
		t.Fatalf("GET dark = %v", one)
	}
	// The single GET still returns the FULL record, including the heavy
	// fields the list summaries drop.
	for _, present := range []string{
		"css", "js", "header_html", "custom_footer_html", "forum_title",
		"favicon_url", "placeholder_deleted_url", "placeholder_guest_url",
		"description", "bg_default_url", "bg_tablet_url", "bg_mobile_url",
		"bg_opacity", "overwrite_header", "created_at", "updated_at",
	} {
		if _, ok := one[present]; !ok {
			t.Errorf("single GET dark must carry %q", present)
		}
	}

	status, _ = getAerun(t, server.URL+"/api/aerun/default-designs/nope")
	if status != http.StatusNotFound {
		t.Fatalf("GET unknown default design = %d, want 404", status)
	}
}

// TestDesignsListReturnsSummaries pins the custom-design list contract:
// GET /api/aerun/designs returns lightweight summaries — exactly id, name,
// show_in_list, bg_default_url, is_active, base_theme — even when the
// design carries heavy fields, while the single GET returns the full record.
func TestDesignsListReturnsSummaries(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	id := createTestDesign(t, server.URL, tokens["root"], "ListSummary")
	status, body, _ := categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/designs/"+id,
		`{"description":"A heavy design","css":".x{color:red}","js":"window.__x=1;","forum_title":"Heavy","favicon_url":"/api/files/fav.png","header_html":"<p>Head</p>","custom_footer_html":"<p>Foot</p>","placeholder_deleted_url":"/api/files/del.png","placeholder_guest_url":"/api/files/guest.png","overwrite_header":true,"overwrite_footer":true,"overwrite_title":true,"overwrite_favicon":true,"overwrite_css":true,"overwrite_js":true,"overwrite_placeholder_deleted":true,"overwrite_placeholder_guest":true,"bg_opacity":0.5,"is_active":true,"base_theme":"light","show_in_list":true}`,
		tokens["root"], "test-idem-design-list-summary-patch")
	if status != http.StatusOK {
		t.Fatalf("PATCH heavy fields = %d: %s", status, body)
	}

	status, body = getAerun(t, server.URL+"/api/aerun/designs")
	if status != http.StatusOK {
		t.Fatalf("GET /designs = %d: %s", status, body)
	}
	var resp struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	var item map[string]any
	for _, it := range resp.Items {
		if it["id"] == id {
			item = it
			break
		}
	}
	if item == nil {
		t.Fatalf("list must include the created design %s: %s", id, body)
	}
	for key, want := range map[string]any{
		"name": "ListSummary", "show_in_list": true,
		"bg_default_url": "", "is_active": true, "base_theme": "light",
	} {
		if item[key] != want {
			t.Errorf("list item[%q] = %v, want %v", key, item[key], want)
		}
	}
	for _, absent := range []string{
		"css", "js", "header_html", "custom_footer_html", "forum_title",
		"favicon_url", "placeholder_deleted_url", "placeholder_guest_url",
		"description", "bg_tablet_url", "bg_mobile_url", "bg_opacity",
		"created_at", "updated_at",
		"overwrite_header", "overwrite_footer", "overwrite_title",
		"overwrite_favicon", "overwrite_css", "overwrite_js",
		"overwrite_placeholder_deleted", "overwrite_placeholder_guest",
	} {
		if _, ok := item[absent]; ok {
			t.Errorf("list item must not carry %q", absent)
		}
	}

	// The single GET still returns the FULL record with the heavy values.
	status, body = getAerun(t, server.URL+"/api/aerun/designs/"+id)
	if status != http.StatusOK {
		t.Fatalf("GET /designs/%s = %d: %s", id, status, body)
	}
	var one map[string]any
	if err := json.Unmarshal(body, &one); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"description": "A heavy design", "css": ".x{color:red}",
		"js": "window.__x=1;", "forum_title": "Heavy",
		"favicon_url": "/api/files/fav.png", "header_html": "<p>Head</p>",
		"custom_footer_html": "<p>Foot</p>",
		"placeholder_deleted_url": "/api/files/del.png",
		"placeholder_guest_url":   "/api/files/guest.png",
		"overwrite_header": true, "overwrite_css": true,
		"bg_opacity": float64(0.5),
	} {
		if one[key] != want {
			t.Errorf("single GET[%q] = %v, want %v", key, one[key], want)
		}
	}
}

func TestDefaultDesignPatch(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	base := server.URL + "/api/aerun/default-designs/dark"

	if status, _, _ := categoryCall(t, http.MethodPatch, base, `{"name":"X"}`, "", "test-idem-dd-patch-anon"); status != http.StatusUnauthorized {
		t.Fatalf("anonymous PATCH = %d, want 401", status)
	}
	if status, _, _ := categoryCall(t, http.MethodPatch, base, `{"name":"X"}`, tokens["player"], "test-idem-dd-patch-player"); status != http.StatusForbidden {
		t.Fatalf("player PATCH = %d, want 403", status)
	}

	// welcome_message is rejected, like logo_url on custom designs.
	if status, body, _ := categoryCall(t, http.MethodPatch, base, `{"welcome_message":"hi"}`, tokens["root"], "test-idem-dd-patch-welcome"); status != http.StatusBadRequest {
		t.Fatalf("PATCH welcome_message = %d, want 400: %s", status, body)
	}
	// bg_opacity out of range is refused, not clamped.
	if status, _, _ := categoryCall(t, http.MethodPatch, base, `{"bg_opacity":2}`, tokens["root"], "test-idem-dd-patch-opacity"); status != http.StatusBadRequest {
		t.Fatalf("PATCH bg_opacity=2 = %d, want 400", status)
	}

	status, body, _ := categoryCall(t, http.MethodPatch, base,
		`{"name":"Тёмная+","show_in_list":false,"header_html":"<p>Хедер</p>","overwrite_header":true,"bg_opacity":0.75}`,
		tokens["root"], "test-idem-dd-patch-root")
	if status != http.StatusOK {
		t.Fatalf("root PATCH = %d: %s", status, body)
	}
	var patched map[string]any
	if err := json.Unmarshal(body, &patched); err != nil {
		t.Fatal(err)
	}
	if patched["name"] != "Тёмная+" || patched["show_in_list"] != false {
		t.Fatalf("patched = %v", patched)
	}
	if patched["header_html"] != "<p>Хедер</p>" {
		t.Fatalf("header_html = %v, want the patched HTML string", patched["header_html"])
	}
	if patched["overwrite_header"] != true {
		t.Fatalf("overwrite_header = %v, want true", patched["overwrite_header"])
	}
	if patched["bg_opacity"] != float64(0.75) {
		t.Fatalf("bg_opacity = %v, want 0.75", patched["bg_opacity"])
	}

	// key / is_active / base_theme are not patchable: sent, ignored.
	status, body, _ = categoryCall(t, http.MethodPatch, base,
		`{"key":"light","is_active":true,"base_theme":"light"}`,
		tokens["root"], "test-idem-dd-patch-immutable")
	if status != http.StatusOK {
		t.Fatalf("PATCH immutable keys = %d: %s", status, body)
	}
	if err := json.Unmarshal(body, &patched); err != nil {
		t.Fatal(err)
	}
	if patched["key"] != "dark" {
		t.Fatalf("key changed to %v, must stay dark", patched["key"])
	}

	// Persistence: a fresh GET shows the PATCH.
	status, body = getAerun(t, base)
	if status != http.StatusOK {
		t.Fatalf("GET after PATCH = %d: %s", status, body)
	}
	if !bytes.Contains(body, []byte(`"name":"Тёмная+"`)) {
		t.Fatalf("GET after PATCH missing new name: %s", body)
	}
}

func TestDefaultDesignCreateDeleteMethodNotAllowed(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/default-designs", `{"key":"custom","name":"Custom"}`, map[string]string{
		"Authorization":   tokens["root"],
		"Idempotency-Key": "test-idem-dd-create",
	})
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("POST /default-designs = %d, want 405", status)
	}

	status, _, _ = categoryCall(t, http.MethodDelete, server.URL+"/api/aerun/default-designs/dark", "", tokens["root"], "test-idem-dd-delete")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /default-designs/dark = %d, want 405", status)
	}
}

func TestDesignHeaderRenameAndSurfaceFields(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// welcome_message is rejected on create and on update.
	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/designs", `{"name":"Old","welcome_message":"hi"}`, map[string]string{
		"Authorization":   tokens["root"],
		"Idempotency-Key": "test-idem-design-welcome-create",
	})
	if status != http.StatusBadRequest {
		t.Fatalf("POST welcome_message = %d, want 400", status)
	}

	id := createTestDesign(t, server.URL, tokens["root"], "SurfaceFields")
	status, _, _ = categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/designs/"+id, `{"welcome_message":"hi"}`, tokens["root"], "test-idem-design-welcome-patch")
	if status != http.StatusBadRequest {
		t.Fatalf("PATCH welcome_message = %d, want 400", status)
	}

	// The new fields are accepted on PATCH; bg_default_url is upload-only
	// and must be ignored.
	status, body, _ := categoryCall(t, http.MethodPatch, server.URL+"/api/aerun/designs/"+id,
		`{"header_html":"<p>Хедер</p>","custom_footer_html":"<p>Футер</p>","overwrite_header":true,"overwrite_footer":true,"placeholder_deleted_url":"/api/files/x","bg_opacity":0.25,"bg_default_url":"https://example.invalid/bg.jpg"}`,
		tokens["root"], "test-idem-design-surface-patch")
	if status != http.StatusOK {
		t.Fatalf("PATCH surface fields = %d: %s", status, body)
	}
	var patched map[string]any
	if err := json.Unmarshal(body, &patched); err != nil {
		t.Fatal(err)
	}
	if patched["overwrite_header"] != true || patched["overwrite_footer"] != true {
		t.Fatalf("overwrite toggles = %v", patched)
	}
	if patched["header_html"] != "<p>Хедер</p>" || patched["custom_footer_html"] != "<p>Футер</p>" {
		t.Fatalf("header/footer = %v / %v", patched["header_html"], patched["custom_footer_html"])
	}
	if patched["placeholder_deleted_url"] != "/api/files/x" {
		t.Fatalf("placeholder_deleted_url = %v", patched["placeholder_deleted_url"])
	}
	if patched["bg_opacity"] != float64(0.25) {
		t.Fatalf("bg_opacity = %v, want 0.25", patched["bg_opacity"])
	}
	if patched["bg_default_url"] != "" {
		t.Fatalf("bg_default_url = %v, must stay empty (upload-only)", patched["bg_default_url"])
	}
	if _, ok := patched["welcome_message"]; ok {
		t.Fatalf("payload must not carry welcome_message: %v", patched)
	}
}

func TestDesignBackgroundUpload(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	id := createTestDesign(t, server.URL, tokens["root"], "BgUpload")
	base := server.URL + "/api/aerun/designs/" + id + "/background/"

	if st, _ := putFaviconMultipart(t, base+"default", "", "bg.png", uploadPNGBytes); st != http.StatusUnauthorized {
		t.Fatalf("guest background upload = %d, want 401", st)
	}
	if st, _ := putFaviconMultipart(t, base+"default", tokens["player"], "bg.png", uploadPNGBytes); st != http.StatusForbidden {
		t.Fatalf("player background upload = %d, want 403", st)
	}
	if st, _ := putFaviconMultipart(t, base+"huge", tokens["root"], "bg.png", uploadPNGBytes); st != http.StatusBadRequest {
		t.Fatalf("bad background kind = %d, want 400", st)
	}
	if st, _ := putFaviconMultipart(t, base+"default", tokens["root"], "bg.txt", []byte("not an image")); st != http.StatusBadRequest {
		t.Fatalf("non-image background = %d, want 400", st)
	}

	for _, kind := range []string{"default", "tablet", "mobile"} {
		st, raw := putFaviconMultipart(t, base+kind, tokens["root"], "bg.png", uploadPNGBytes)
		if st != http.StatusOK {
			t.Fatalf("upload background %s = %d: %s", kind, st, raw)
		}
		var parsed struct {
			Design map[string]any `json:"design"`
		}
		var flat map[string]any
		if err := json.Unmarshal(raw, &flat); err != nil {
			t.Fatal(err)
		}
		urlKey := "bg_" + kind + "_url"
		url, _ := flat[urlKey].(string)
		if !strings.HasPrefix(url, "/api/files/") || !strings.HasSuffix(url, ".png") {
			t.Fatalf("%s = %q, want /api/files/....png", urlKey, url)
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Design[urlKey] != url {
			t.Fatalf("design.%s = %v, want %q", urlKey, parsed.Design[urlKey], url)
		}
	}

	// Oversize: a file over 10 MB is refused (the old 2 MB cap would have
	// refused anything over 2 MB — a 5 MB background must pass, a >10 MB one
	// must not).
	oversized := append(append([]byte{}, uploadPNGBytes...), make([]byte, backgroundUploadMaxBytes)...)
	if st, _ := putFaviconMultipart(t, base+"default", tokens["root"], "big.png", oversized); st != http.StatusBadRequest {
		t.Fatalf("oversize background = %d, want 400", st)
	}
	fiveMB := append(append([]byte{}, uploadPNGBytes...), make([]byte, 5<<20)...)
	if st, raw := putFaviconMultipart(t, base+"default", tokens["root"], "five.png", fiveMB); st != http.StatusOK {
		t.Fatalf("5 MB background = %d, want 200 (10 MB cap, not 2 MB): %s", st, raw)
	}
}

func TestDefaultDesignUploads(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	base := server.URL + "/api/aerun/default-designs/dark"

	// Background on the default card.
	st, raw := putFaviconMultipart(t, base+"/background/tablet", tokens["root"], "bg.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("default background upload = %d: %s", st, raw)
	}
	var parsed struct {
		URL           string         `json:"bg_tablet_url"`
		DefaultDesign map[string]any `json:"default_design"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parsed.URL, "/api/files/") || !strings.HasSuffix(parsed.URL, ".png") {
		t.Fatalf("bg_tablet_url = %q, want /api/files/....png", parsed.URL)
	}
	if parsed.DefaultDesign["bg_tablet_url"] != parsed.URL {
		t.Fatalf("default_design.bg_tablet_url = %v, want %q", parsed.DefaultDesign["bg_tablet_url"], parsed.URL)
	}
	if st, _ := putFaviconMultipart(t, base+"/background/wrong", tokens["root"], "bg.png", uploadPNGBytes); st != http.StatusBadRequest {
		t.Fatalf("bad default background kind = %d, want 400", st)
	}

	// Placeholder on the default card.
	st, raw = putFaviconMultipart(t, base+"/placeholder/deleted", tokens["root"], "ph.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("default placeholder upload = %d: %s", st, raw)
	}
	var ph struct {
		URL string `json:"placeholder_deleted_url"`
	}
	if err := json.Unmarshal(raw, &ph); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(ph.URL, "/api/files/") {
		t.Fatalf("placeholder_deleted_url = %q, want /api/files/...", ph.URL)
	}
	if st, _ := putFaviconMultipart(t, base+"/placeholder/other", tokens["root"], "ph.png", uploadPNGBytes); st != http.StatusBadRequest {
		t.Fatalf("bad default placeholder kind = %d, want 400", st)
	}

	// Favicon on the default card (mirrors the design endpoint).
	st, raw = putFaviconMultipart(t, base+"/favicon", tokens["root"], "icon.svg", uploadSVGBytes)
	if st != http.StatusOK {
		t.Fatalf("default favicon upload = %d: %s", st, raw)
	}
	var fav struct {
		URL           string         `json:"favicon_url"`
		DefaultDesign map[string]any `json:"default_design"`
	}
	if err := json.Unmarshal(raw, &fav); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(fav.URL, ".svg") {
		t.Fatalf("favicon_url = %q, want ....svg", fav.URL)
	}
	if fav.DefaultDesign["favicon_url"] != fav.URL {
		t.Fatalf("default_design.favicon_url = %v, want %q", fav.DefaultDesign["favicon_url"], fav.URL)
	}

	// Unknown default card: 404, not a 500.
	if st, _ := putFaviconMultipart(t, server.URL+"/api/aerun/default-designs/nope/background/default", tokens["root"], "bg.png", uploadPNGBytes); st != http.StatusNotFound {
		t.Fatalf("unknown default background upload = %d, want 404", st)
	}
}

func TestDesignPlaceholderUpload(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	id := createTestDesign(t, server.URL, tokens["root"], "PhUpload")
	base := server.URL + "/api/aerun/designs/" + id + "/placeholder/"

	st, raw := putFaviconMultipart(t, base+"guest", tokens["root"], "ph.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("design placeholder upload = %d: %s", st, raw)
	}
	var parsed struct {
		URL    string         `json:"placeholder_guest_url"`
		Design map[string]any `json:"design"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(parsed.URL, "/api/files/") || !strings.HasSuffix(parsed.URL, ".png") {
		t.Fatalf("placeholder_guest_url = %q, want /api/files/....png", parsed.URL)
	}
	if parsed.Design["placeholder_guest_url"] != parsed.URL {
		t.Fatalf("design.placeholder_guest_url = %v, want %q", parsed.Design["placeholder_guest_url"], parsed.URL)
	}
	if st, _ := putFaviconMultipart(t, base+"other", tokens["root"], "ph.png", uploadPNGBytes); st != http.StatusBadRequest {
		t.Fatalf("bad design placeholder kind = %d, want 400", st)
	}
}

// TestDefaultDesignLightBackgroundResolves proves the background-switch path
// for the reported case: backgrounds uploaded to the "Snow Mountains"
// default design (key 'light') are stored on THAT card and come back with
// its bg URLs and opacity — so resolveActiveDesign can hand them to
// ForumBackground when the active theme is 'light'. Uploading to 'light'
// does not switch anyone to it: the 'dark' card keeps no background at all,
// which is why the forum (active theme 'dark', "Space", no background)
// showed no background despite the uploads.
func TestDefaultDesignLightBackgroundResolves(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	lightBase := server.URL + "/api/aerun/default-designs/light"

	// Upload all three breakpoint variants to the 'light' card.
	for _, kind := range []string{"default", "tablet", "mobile"} {
		st, raw := putFaviconMultipart(t, lightBase+"/background/"+kind, tokens["root"], "bg.png", uploadPNGBytes)
		if st != http.StatusOK {
			t.Fatalf("upload light background %s = %d: %s", kind, st, raw)
		}
	}

	// Opacity is a card field, set via PATCH.
	status, body, _ := categoryCall(t, http.MethodPatch, lightBase, `{"bg_opacity":0.6}`, tokens["root"], "test-idem-dd-light-opacity")
	if status != http.StatusOK {
		t.Fatalf("PATCH light bg_opacity = %d: %s", status, body)
	}

	// A fresh GET returns the card with its bg URLs and opacity.
	status, body = getAerun(t, lightBase)
	if status != http.StatusOK {
		t.Fatalf("GET light = %d: %s", status, body)
	}
	var light map[string]any
	if err := json.Unmarshal(body, &light); err != nil {
		t.Fatal(err)
	}
	if light["key"] != "light" {
		t.Fatalf("light card key = %v, want light", light["key"])
	}
	for _, key := range []string{"bg_default_url", "bg_tablet_url", "bg_mobile_url"} {
		url, _ := light[key].(string)
		if !strings.HasPrefix(url, "/api/files/") || !strings.HasSuffix(url, ".png") {
			t.Fatalf("light %s = %q, want /api/files/....png", key, url)
		}
	}
	if light["bg_opacity"] != float64(0.6) {
		t.Fatalf("light bg_opacity = %v, want 0.6", light["bg_opacity"])
	}

	// The 'dark' card is untouched: no background on it, so with theme
	// 'dark' ForumBackground renders no <picture> — the reported symptom.
	status, body = getAerun(t, server.URL+"/api/aerun/default-designs/dark")
	if status != http.StatusOK {
		t.Fatalf("GET dark = %d: %s", status, body)
	}
	var dark map[string]any
	if err := json.Unmarshal(body, &dark); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"bg_default_url", "bg_tablet_url", "bg_mobile_url"} {
		if url, _ := dark[key].(string); url != "" {
			t.Fatalf("dark %s = %q, want empty (uploads went to the light card)", key, url)
		}
	}
}

// TestDefaultDesignBackgroundFileServes reproduces the reported bug: the
// upload answers a /api/files/... URL, but the file itself does not serve —
// the browser's <img> gets an error and the background never appears even
// though the light theme is active and the card resolves. A plain,
// unauthenticated GET (exactly what a browser does for an <img> src) must
// return 200 with the uploaded bytes.
func TestDefaultDesignBackgroundFileServes(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	st, raw := putFaviconMultipart(t, server.URL+"/api/aerun/default-designs/light/background/default", tokens["root"], "bg.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("upload light background = %d: %s", st, raw)
	}
	var uploaded struct {
		URL string `json:"bg_default_url"`
	}
	if err := json.Unmarshal(raw, &uploaded); err != nil {
		t.Fatal(err)
	}
	if uploaded.URL == "" {
		t.Fatalf("upload returned no bg_default_url: %s", raw)
	}

	status, body := getAerun(t, server.URL+uploaded.URL)
	if status != http.StatusOK {
		t.Fatalf("GET %s = %d, want 200 (body %d bytes)", uploaded.URL, status, len(body))
	}
	if !bytes.Equal(body, uploadPNGBytes) {
		t.Fatalf("GET %s returned %d bytes, want the %d uploaded PNG bytes", uploaded.URL, len(body), len(uploadPNGBytes))
	}

	// Same file, same URL shape, through the custom-design twin: the
	// designs collection carries the same server-only rules, so if the
	// default card fails here the custom card fails the same way.
	id := createTestDesign(t, server.URL, tokens["root"], "BgServes")
	st, raw = putFaviconMultipart(t, server.URL+"/api/aerun/designs/"+id+"/background/default", tokens["root"], "bg.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("upload custom background = %d: %s", st, raw)
	}
	if err := json.Unmarshal(raw, &uploaded); err != nil {
		t.Fatal(err)
	}
	status, body = getAerun(t, server.URL+uploaded.URL)
	if status != http.StatusOK {
		t.Fatalf("GET custom %s = %d, want 200 (body %d bytes)", uploaded.URL, status, len(body))
	}
	if !bytes.Equal(body, uploadPNGBytes) {
		t.Fatalf("GET custom %s returned %d bytes, want the %d uploaded PNG bytes", uploaded.URL, len(body), len(uploadPNGBytes))
	}
}

// TestActiveDesignEmbedsFullCard pins that the card embedded in the settings
// snapshot is the WHOLE card, not an id: after customising the light card
// (scalar fields via PATCH, background and placeholder via upload), the
// snapshot a member with theme 'light' reads mirrors every value the chrome
// needs — so no consumer has to fetch the lists to render it.
//
// File URLs stay exactly as stored (relative /api/files/...): the client
// resolves them against pbUrl (resolveAvatarUrl pattern) — the server must
// not absolutise them, or the dev-origin split (Vite :5173 vs PocketBase
// :8090) breaks them.
func TestActiveDesignEmbedsFullCard(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	base := server.URL + "/api/aerun/default-designs/light"

	status, body, _ := categoryCall(t, http.MethodPatch, base,
		`{"header_html":"<p>Светлый хедер</p>","custom_footer_html":"<p>Светлый футер</p>","forum_title":"Светлый форум","favicon_url":"/api/files/light-favicon.png","css":".x{color:#fff}","js":"window.__light=1;","overwrite_header":true,"overwrite_footer":true,"overwrite_title":true,"overwrite_favicon":true,"overwrite_css":true,"overwrite_js":true}`,
		tokens["root"], "test-idem-dd-active-full-patch")
	if status != http.StatusOK {
		t.Fatalf("PATCH light card = %d: %s", status, body)
	}
	st, raw := putFaviconMultipart(t, base+"/background/default", tokens["root"], "bg.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("upload light background = %d: %s", st, raw)
	}
	st, raw = putFaviconMultipart(t, base+"/placeholder/deleted", tokens["root"], "ph.png", uploadPNGBytes)
	if st != http.StatusOK {
		t.Fatalf("upload light placeholder = %d: %s", st, raw)
	}

	setTestUserTheme(t, app, fixPlayerID, "light")
	card := fetchSettingsActiveDesign(t, server.URL, tokens["player"])
	if card["kind"] != "default" || card["key"] != "light" {
		t.Fatalf("activeDesign = %v, want the light card", card)
	}
	want := map[string]any{
		"header_html":        "<p>Светлый хедер</p>",
		"custom_footer_html": "<p>Светлый футер</p>",
		"forum_title":        "Светлый форум",
		"favicon_url":        "/api/files/light-favicon.png",
		"css":                ".x{color:#fff}",
		"js":                 "window.__light=1;",
	}
	for key, value := range want {
		if card[key] != value {
			t.Errorf("activeDesign[%q] = %v, want %v", key, card[key], value)
		}
	}
	for _, toggle := range []string{
		"overwrite_header", "overwrite_footer", "overwrite_title",
		"overwrite_favicon", "overwrite_css", "overwrite_js",
	} {
		if card[toggle] != true {
			t.Errorf("activeDesign[%q] = %v, want true", toggle, card[toggle])
		}
	}
	// Uploaded file URLs arrive as stored: relative /api/files/... paths,
	// never absolutised server-side.
	for _, field := range []string{"bg_default_url", "placeholder_deleted_url"} {
		url, _ := card[field].(string)
		if !strings.HasPrefix(url, "/api/files/") || !strings.HasSuffix(url, ".png") {
			t.Errorf("activeDesign[%q] = %q, want a stored relative /api/files/....png URL", field, url)
		}
		if strings.HasPrefix(url, "http") {
			t.Errorf("activeDesign[%q] = %q, must not be an absolute URL", field, url)
		}
	}
}
