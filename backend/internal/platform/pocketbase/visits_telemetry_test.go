package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestTelemetryVisitHandler_Suite covers POST /api/aerun/telemetry/visit contract.
func TestTelemetryVisitHandler_Suite(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	_ = seedIdentityFixtures(t, app)

	t.Run("creates a visit row for anonymous guest", func(t *testing.T) {
		body := `{"session_id":"sess1234567890","guest_id":"guestabcdef123","entry_path":"/","referrer":""}`
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/telemetry/visit", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		payload, _ := io.ReadAll(res.Body)

		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", res.StatusCode, payload)
		}

		var resp map[string]any
		if err := json.Unmarshal(payload, &resp); err != nil {
			t.Fatalf("unreadable response: %v", err)
		}
		if resp["status"] != "recorded" {
			t.Fatalf("expected status=recorded, got %v", resp["status"])
		}

		records, err := app.FindRecordsByFilter(visitsCollectionName, "session_id = 'sess1234567890'", "", 1, 0)
		if err != nil {
			t.Fatalf("query visits: %v", err)
		}
		if len(records) != 1 {
			t.Fatalf("expected 1 visit record, got %d", len(records))
		}
		r := records[0]
		if r.GetString("session_id") != "sess1234567890" {
			t.Fatalf("session_id mismatch: %s", r.GetString("session_id"))
		}
		if r.GetString("guest_id") != "guestabcdef123" {
			t.Fatalf("guest_id mismatch: %s", r.GetString("guest_id"))
		}
		if r.GetString("entry_path") != "/" {
			t.Fatalf("entry_path mismatch: %s", r.GetString("entry_path"))
		}
		if r.GetBool("is_bot") {
			t.Fatal("is_bot should be false for normal UA")
		}
		if r.GetString("device") != "desktop" {
			t.Fatalf("device mismatch: %s", r.GetString("device"))
		}
	})
}
