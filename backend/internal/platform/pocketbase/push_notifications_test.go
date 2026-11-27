package pocketbase

// Tests for the Web Push enqueue/dispatch contract (migration 1780100000,
// finished after the first commit).
//
// The first commit's maybeEnqueuePushNotification double-wrapped the payload
// and used a millisecond timestamp as the dedupe key, so the dispatcher
// always read empty title/body/url and deduping never triggered. These tests
// pin the flat shape and the event-identity dedupe, and the well-formed
// VAPID subject (the first commit built "mailto:https://…/admin").

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// enablePushInSettings turns the forum-level push switch on for a fresh test
// app, mirroring what ensureVAPIDKeys does on first boot in production.
func enablePushInSettings(t testing.TB, app *tests.TestApp) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		t.Fatalf("forum_settings collection missing: %v", err)
	}
	rec, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || rec == nil {
		rec = core.NewRecord(col)
		rec.Set("id", forumSettingsID)
	}
	rec.Set("push_enabled", true)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to enable push in settings: %v", err)
	}
}

func countOutboxRows(t testing.TB, app *tests.TestApp, dedupeKey string) int {
	t.Helper()
	rows, err := app.FindRecordsByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:k}",
		"created",
		10, 0,
		dbx.Params{"k": dedupeKey},
	)
	if err != nil {
		t.Fatalf("failed to read outbox rows: %v", err)
	}
	return len(rows)
}

func TestPushEnqueueStoresFlatPayloadAndDedupes(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	enablePushInSettings(t, app)

	content := PushContent{
		Title: "New reply in: Test Topic",
		Body:  "PlayerOne",
		URL:   "/topic/topic00000001?post=post000000001",
	}
	if err := maybeEnqueuePushNotification(app, fixPlayerID, "push:notification", "push:test:1", content); err != nil {
		t.Fatalf("enqueue failed: %v", err)
	}

	rows, err := app.FindRecordsByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:k}",
		"created",
		10, 0,
		dbx.Params{"k": "push:test:1"},
	)
	if err != nil {
		t.Fatalf("failed to read outbox rows: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected exactly 1 outbox row, got %d", len(rows))
	}

	// The stored payload is flat: title/body/url at the top level, and no
	// nested "payload" object — the double-wrap that made every dispatched
	// notification arrive empty.
	var stored map[string]any
	raw := rows[0].Get("payload")
	switch p := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(p), &stored); err != nil {
			t.Fatalf("stored payload is not JSON: %v", err)
		}
	default:
		data, _ := json.Marshal(p)
		if err := json.Unmarshal(data, &stored); err != nil {
			t.Fatalf("stored payload is not JSON: %v", err)
		}
	}
	if stored["title"] != content.Title {
		t.Fatalf("top-level title = %v, want %q", stored["title"], content.Title)
	}
	if stored["body"] != content.Body {
		t.Fatalf("top-level body = %v, want %q", stored["body"], content.Body)
	}
	if stored["url"] != content.URL {
		t.Fatalf("top-level url = %v, want %q", stored["url"], content.URL)
	}
	if _, nested := stored["payload"]; nested {
		t.Fatalf("stored payload must not contain a nested \"payload\" object")
	}

	// The dispatch-side parser reads the same row back unchanged.
	recipientID, title, body, url, _, err := parsePushPayload(rows[0].Get("payload"))
	if err != nil {
		t.Fatalf("parsePushPayload failed: %v", err)
	}
	if recipientID != fixPlayerID || title != content.Title || body != content.Body || url != content.URL {
		t.Fatalf("round-trip mismatch: got (%q, %q, %q, %q)", recipientID, title, body, url)
	}

	// The same triggering event enqueued twice is still one row: the dedupe
	// key is the event, not a timestamp.
	if err := maybeEnqueuePushNotification(app, fixPlayerID, "push:notification", "push:test:1", content); err != nil {
		t.Fatalf("second enqueue failed: %v", err)
	}
	if n := countOutboxRows(t, app, "push:test:1"); n != 1 {
		t.Fatalf("dedupe failed: expected 1 row after a repeat enqueue, got %d", n)
	}
}

// TestDynamicManifestServesSettings pins the admin-owned manifest
// (migration 1780100001): the endpoint serves the built-in defaults on an
// unconfigured forum, and the stored values once the admin sets them.
func TestDynamicManifestServesSettings(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	ts := newTestServer(t, app)
	defer ts.Close()

	getManifest := func(query string) map[string]any {
		t.Helper()
		res, err := http.Get(ts.URL + "/api/aerun/manifest.webmanifest" + query)
		if err != nil {
			t.Fatalf("GET manifest failed: %v", err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET manifest = %d, want 200", res.StatusCode)
		}
		if ct := res.Header.Get("Content-Type"); ct != manifestContentType {
			t.Fatalf("manifest Content-Type = %q, want %q", ct, manifestContentType)
		}
		body, _ := io.ReadAll(res.Body)
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatalf("manifest is not JSON: %v", err)
		}
		return m
	}

	// Unconfigured: the built-in defaults, and no icons (the admin has not
	// uploaded any yet — the manifest is honest about that instead of
	// pointing at files that do not exist). The colours and the language
	// follow the viewer: no query means the forum default theme (dark) and
	// the forum default language (en).
	m := getManifest("")
	if m["name"] != defaultPWAName {
		t.Fatalf("manifest name = %v, want %q", m["name"], defaultPWAName)
	}
	if m["theme_color"] != "#080d1e" {
		t.Fatalf("manifest theme_color = %v, want the dark theme's --nav-bg", m["theme_color"])
	}
	if m["background_color"] != "#0f172a" {
		t.Fatalf("manifest background_color = %v, want the dark theme's --bg-color", m["background_color"])
	}
	if m["lang"] != "en" {
		t.Fatalf("manifest lang = %v, want %q", m["lang"], "en")
	}
	if icons, _ := m["icons"].([]any); len(icons) != 0 {
		t.Fatalf("manifest icons = %v, want none on an unconfigured forum", icons)
	}

	// The viewer's own theme and locale drive the colours and the language:
	// a light-theme Russian viewer gets the light palette in Russian.
	m = getManifest("?theme=light&lang=ru")
	if m["theme_color"] != "#212529" || m["background_color"] != "#f4f6f8" || m["lang"] != "ru" {
		t.Fatalf("manifest for ?theme=light&lang=ru = (%v, %v, %v), want (#212529, #f4f6f8, ru)",
			m["theme_color"], m["background_color"], m["lang"])
	}

	// An unknown theme falls back to the forum default instead of failing.
	m = getManifest("?theme=bogus&lang=xx")
	if m["theme_color"] != "#080d1e" || m["lang"] != "en" {
		t.Fatalf("manifest for unknown theme/lang = (%v, %v), want (#080d1e, en)",
			m["theme_color"], m["lang"])
	}

	// The admin renames the app: the next fetch serves the stored value.
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		t.Fatalf("forum_settings collection missing: %v", err)
	}
	rec, err := app.FindRecordById(forumSettingsCollectionName, forumSettingsID)
	if err != nil || rec == nil {
		rec = core.NewRecord(col)
		rec.Set("id", forumSettingsID)
	}
	rec.Set("pwa_name", "Test Forum")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to store pwa settings: %v", err)
	}

	m = getManifest("")
	if m["name"] != "Test Forum" {
		t.Fatalf("manifest name after admin edit = %v, want %q", m["name"], "Test Forum")
	}
}

func TestDeriveVAPIDSubjectIsWellFormed(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	settings := app.Settings()
	settings.Meta.AppURL = "https://aerun-world.com"
	if err := app.Save(settings); err != nil {
		t.Fatalf("failed to set AppURL: %v", err)
	}

	if got := deriveVAPIDSubject(app); got != "mailto:admin@aerun-world.com" {
		t.Fatalf("deriveVAPIDSubject = %q, want %q", got, "mailto:admin@aerun-world.com")
	}

	// A public URL with a port still yields a bare host: a port in the
	// mailbox would be a malformed subject.
	settings.Meta.AppURL = "https://aerun-world.com:8090"
	if err := app.Save(settings); err != nil {
		t.Fatalf("failed to set AppURL with port: %v", err)
	}
	if got := deriveVAPIDSubject(app); got != "mailto:admin@aerun-world.com" {
		t.Fatalf("deriveVAPIDSubject with port = %q, want %q", got, "mailto:admin@aerun-world.com")
	}
}
