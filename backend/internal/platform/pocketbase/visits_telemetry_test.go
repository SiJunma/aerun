package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
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

// TestRecordTopicVisit covers topic_visits recording and session deduplication.
func TestRecordTopicVisit(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	_ = seedIdentityFixtures(t, app)

	// Create a test topic
	catID := getGeneralCategoryID(t, app)
	topicRec := seedTopicIn(t, app, "test-topic-visits", catID, fixPlayerID, time.Now())
	topicID := topicRec.Id

	sessionID := "sess_topic_1"
	userID := fixPlayerID
	guestID := ""

	// First visit - should record
	recordTopicVisit(app, sessionID, topicID, userID, guestID)

	records, err := app.FindRecordsByFilter(topicVisitsCollectionName, "session_id = '"+sessionID+"' && topic_id = '"+topicID+"'", "", 10, 0)
	if err != nil {
		t.Fatalf("query topic_visits: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 topic_visit record, got %d", len(records))
	}

	// Second visit within same session - should be deduplicated
	recordTopicVisit(app, sessionID, topicID, userID, guestID)

	records, err = app.FindRecordsByFilter(topicVisitsCollectionName, "session_id = '"+sessionID+"' && topic_id = '"+topicID+"'", "", 10, 0)
	if err != nil {
		t.Fatalf("query topic_visits: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 topic_visit record after dedup, got %d", len(records))
	}

	// Different session - should record new
	recordTopicVisit(app, "sess_topic_2", topicID, userID, guestID)

	records, err = app.FindRecordsByFilter(topicVisitsCollectionName, "topic_id = '"+topicID+"'", "", 10, 0)
	if err != nil {
		t.Fatalf("query topic_visits: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 topic_visit records for different sessions, got %d", len(records))
	}
}

// TestTelemetryVisitValidation covers input validation for the telemetry endpoint.
func TestTelemetryVisitValidation(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	_ = seedIdentityFixtures(t, app)

	// session_id too long should be truncated
	t.Run("truncates session_id longer than 64 chars", func(t *testing.T) {
		longSessionID := strings.Repeat("a", 100)
		body := `{"session_id":"` + longSessionID + `","guest_id":"guest_valid","entry_path":"/","referrer":""}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/telemetry/visit", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var resp map[string]any
		json.NewDecoder(res.Body).Decode(&resp)
		if resp["status"] != "recorded" {
			t.Fatalf("expected recorded, got %v", resp["status"])
		}

		records, err := app.FindRecordsByFilter(visitsCollectionName, "session_id = '"+longSessionID[:64]+"'", "", 1, 0)
		if err != nil {
			t.Fatalf("query visits: %v", err)
		}
		if len(records) != 1 {
			t.Fatalf("expected 1 visit record with truncated session_id, got %d", len(records))
		}
	})

	// entry_path defaults to "/"
	t.Run("defaults entry_path to / when empty", func(t *testing.T) {
		body := `{"session_id":"sess_path_1","guest_id":"guest_path_1","entry_path":"","referrer":""}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/telemetry/visit", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var resp map[string]any
		json.NewDecoder(res.Body).Decode(&resp)
		if resp["status"] != "recorded" {
			t.Fatalf("expected recorded, got %v", resp["status"])
		}

		records, err := app.FindRecordsByFilter(visitsCollectionName, "session_id = 'sess_path_1'", "", 1, 0)
		if err != nil {
			t.Fatalf("query visits: %v", err)
		}
		if len(records) != 1 {
			t.Fatalf("expected 1 visit record, got %d", len(records))
		}
		if records[0].GetString("entry_path") != "/" {
			t.Fatalf("expected entry_path '/', got %s", records[0].GetString("entry_path"))
		}
	})
}

// TestResolveLocationGeoIP tests the ResolveLocation function directly.
func TestResolveLocationGeoIP(t *testing.T) {
	// Loopback
	cc, city := ResolveLocation("127.0.0.1")
	if cc != "XX" || city != "Local Network" {
		t.Fatalf("loopback: expected XX/Local Network, got %s/%s", cc, city)
	}

	// IPv6 loopback
	cc, city = ResolveLocation("::1")
	if cc != "XX" || city != "Local Network" {
		t.Fatalf("ipv6 loopback: expected XX/Local Network, got %s/%s", cc, city)
	}

	// Private IP
	cc, city = ResolveLocation("192.168.1.1")
	if cc != "XX" || city != "Local Network" {
		t.Fatalf("private IP: expected XX/Local Network, got %s/%s", cc, city)
	}

	// Invalid IP
	cc, city = ResolveLocation("not-an-ip")
	if cc != "XX" || city != "Unknown" {
		t.Fatalf("invalid IP: expected XX/Unknown, got %s/%s", cc, city)
	}

	// Empty IP
	cc, city = ResolveLocation("")
	if cc != "XX" || city != "Unknown" {
		t.Fatalf("empty IP: expected XX/Unknown, got %s/%s", cc, city)
	}
}

// TestTelemetryDurableDeduplicationAcrossRestart verifies Task 6:
// wiping the in-memory sessionTouches map (simulating a backend restart)
// must not create duplicate visit rows for the same session within 30 minutes,
// and mid-session login upgrade also works across a restart.
func TestTelemetryDurableDeduplicationAcrossRestart(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	sendPing := func(sessionID, token string) map[string]any {
		body := `{"session_id":"` + sessionID + `","guest_id":"guest_durable_1","entry_path":"/","referrer":""}`
		req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/telemetry/visit", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var resp map[string]any
		if err := json.NewDecoder(res.Body).Decode(&resp); err != nil {
			t.Fatalf("decode resp: %v", err)
		}
		return resp
	}

	// 1. First visit -> recorded
	resp1 := sendPing("sess_restart_1", "")
	if resp1["status"] != "recorded" {
		t.Fatalf("expected recorded, got %v", resp1["status"])
	}

	// 2. Simulate backend restart by clearing in-memory cache
	sessionMu.Lock()
	sessionTouches = make(map[string]sessionTouch)
	sessionMu.Unlock()

	// 3. Same session guest ping within 30m -> touched (NO new row)
	resp2 := sendPing("sess_restart_1", "")
	if resp2["status"] != "touched" {
		t.Fatalf("expected touched after restart, got %v", resp2["status"])
	}

	// 4. Simulate another restart, then user signs in -> upgraded (NO new row)
	sessionMu.Lock()
	sessionTouches = make(map[string]sessionTouch)
	sessionMu.Unlock()

	resp3 := sendPing("sess_restart_1", tokens["player"])
	if resp3["status"] != "upgraded" {
		t.Fatalf("expected upgraded after restart, got %v", resp3["status"])
	}

	records, err := app.FindRecordsByFilter(visitsCollectionName, "session_id = 'sess_restart_1'", "", 10, 0)
	if err != nil {
		t.Fatalf("query visits: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("expected exactly 1 visit row across restarts, got %d", len(records))
	}
	if records[0].GetString("user_id") != fixPlayerID {
		t.Fatalf("expected user_id=%q on upgraded row, got %q", fixPlayerID, records[0].GetString("user_id"))
	}

	// 5. New tab (new session_id) still creates a separate visit
	resp4 := sendPing("sess_restart_2", tokens["player"])
	if resp4["status"] != "recorded" {
		t.Fatalf("expected recorded for new session/tab, got %v", resp4["status"])
	}
}
