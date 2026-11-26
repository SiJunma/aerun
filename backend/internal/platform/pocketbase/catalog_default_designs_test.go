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
		if got["overwrite_header"] != false {
			t.Errorf("item %d overwrite_header = %v, want false", i, got["overwrite_header"])
		}
		for _, absent := range []string{"is_active", "base_theme"} {
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

	status, _ = getAerun(t, server.URL+"/api/aerun/default-designs/nope")
	if status != http.StatusNotFound {
		t.Fatalf("GET unknown default design = %d, want 404", status)
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

// TestCardBgOpacity pins the opacity read rule through the real API: only an
// UNSET value reads as 0.5 (a fresh card must not render its background fully
// transparent just because nobody touched the slider yet); an explicit 0 is a
// real value and reads back as 0, and out-of-range values are refused, not
// clamped (see TestDefaultDesignPatch for the 400 case).
func TestCardBgOpacity(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	id := createTestDesign(t, server.URL, tokens["root"], "opacity")
	base := server.URL + "/api/aerun/designs/" + id

	getOpacity := func(t testing.TB) float64 {
		t.Helper()
		status, body := getAerun(t, base)
		if status != http.StatusOK {
			t.Fatalf("GET design = %d: %s", status, body)
		}
		var got map[string]any
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatal(err)
		}
		v, _ := got["bg_opacity"].(float64)
		return v
	}
	if got := getOpacity(t); got != 0.5 {
		t.Fatalf("fresh design bg_opacity = %v, want 0.5", got)
	}

	patchOpacity := func(t testing.TB, key, payload string) float64 {
		t.Helper()
		status, body, _ := categoryCall(t, http.MethodPatch, base, payload, tokens["root"], "test-idem-opacity-"+key)
		if status != http.StatusOK {
			t.Fatalf("PATCH %s = %d: %s", payload, status, body)
		}
		var patched map[string]any
		if err := json.Unmarshal(body, &patched); err != nil {
			t.Fatal(err)
		}
		v, _ := patched["bg_opacity"].(float64)
		return v
	}
	if got := patchOpacity(t, "zero", `{"bg_opacity":0}`); got != 0 {
		t.Fatalf("PATCH bg_opacity=0 returned %v, want 0", got)
	}
	if got := getOpacity(t); got != 0 {
		t.Fatalf("GET after PATCH bg_opacity=0 returned %v, want 0", got)
	}
	if got := patchOpacity(t, "quarter", `{"bg_opacity":0.25}`); got != 0.25 {
		t.Fatalf("PATCH bg_opacity=0.25 returned %v, want 0.25", got)
	}
}
