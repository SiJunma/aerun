package pocketbase

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestAdminIPDossierHandler(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// Seed a visit from a public test IP with member identity, device, browser, and entry_path.
	testIP := "203.0.113.42"
	testHash := hashIPWithApp(app, testIP)
	col, err := app.FindCollectionByNameOrId(visitsCollectionName)
	if err != nil || col == nil {
		t.Fatalf("visits collection missing: %v", err)
	}

	now := time.Now().UTC().Format(pbDateFormat)
	rec := core.NewRecord(col)
	rec.Set("occurred_at", now)
	rec.Set("user_id", fixPlayerID)
	rec.Set("guest_id", "")
	rec.Set("session_id", "sess_dossier_1")
	rec.Set("ip", testIP)
	rec.Set("ip_hash", testHash)
	rec.Set("country", "DE")
	rec.Set("city", "Berlin")
	rec.Set("device", "desktop")
	rec.Set("browser", "Firefox")
	rec.Set("os", "Linux")
	rec.Set("entry_path", "/topic/hello")
	rec.Set("is_bot", false)
	if err := app.Save(rec); err != nil {
		t.Fatalf("save visit: %v", err)
	}

	t.Run("unbanned IP returns is_banned=false, nil ban_info, and snake_case recent_visits with user nickname", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/ip-dossier?ip_hash="+testHash, tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}

		var resp map[string]any
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("invalid json: %v", err)
		}

		if resp["is_banned"] != false {
			t.Fatalf("expected is_banned=false, got %v", resp["is_banned"])
		}
		if resp["ban_info"] != nil {
			t.Fatalf("expected ban_info=nil for unbanned IP, got %#v", resp["ban_info"])
		}

		recent, ok := resp["recent_visits"].([]any)
		if !ok || len(recent) != 1 {
			t.Fatalf("expected 1 recent_visit, got %#v", resp["recent_visits"])
		}
		rv := recent[0].(map[string]any)
		if rv["id"] != rec.Id {
			t.Fatalf("expected snake_case id=%q, got %#v", rec.Id, rv["id"])
		}
		if rv["occurred_at"] != now {
			t.Fatalf("expected occurred_at=%q, got %#v", now, rv["occurred_at"])
		}
		if rv["user_id"] != fixPlayerID {
			t.Fatalf("expected user_id=%q, got %#v", fixPlayerID, rv["user_id"])
		}
		if rv["device"] != "desktop" || rv["browser"] != "Firefox" {
			t.Fatalf("expected device=desktop browser=Firefox, got %#v / %#v", rv["device"], rv["browser"])
		}
		if rv["entry_path"] != "/topic/hello" {
			t.Fatalf("expected entry_path=/topic/hello, got %#v", rv["entry_path"])
		}
		userObj, ok := rv["user"].(map[string]any)
		if !ok || userObj["nickname"] == "" {
			t.Fatalf("expected enriched user nickname in recent_visits, got %#v", rv["user"])
		}
	})

	t.Run("banned IP returns is_banned=true with ban_info, then clears on unban", func(t *testing.T) {
		banStatus, banBody, _ := categoryCall(
			t, http.MethodPost, ts.URL+"/api/aerun/admin/ip-bans",
			`{"ip_or_subnet":"203.0.113.42","reason":"Spam test"}`,
			tokens["root"], "idem-dossier-ban-1",
		)
		if banStatus != http.StatusOK {
			t.Fatalf("create ban failed: %d %s", banStatus, banBody)
		}
		var banResp struct {
			Ban struct {
				ID string `json:"id"`
			} `json:"ban"`
		}
		if err := json.Unmarshal(banBody, &banResp); err != nil {
			t.Fatalf("decode ban response: %v", err)
		}

		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/ip-dossier?ip_hash="+testHash, tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp map[string]any
		_ = json.Unmarshal(body, &resp)
		if resp["is_banned"] != true {
			t.Fatalf("expected is_banned=true, got %v", resp["is_banned"])
		}
		banInfo, ok := resp["ban_info"].(map[string]any)
		if !ok || banInfo["reason"] != "Spam test" {
			t.Fatalf("expected ban_info with reason 'Spam test', got %#v", resp["ban_info"])
		}

		// Unban and re-check dossier
		unbanStatus, unbanBody, _ := categoryCall(
			t, http.MethodPost, ts.URL+"/api/aerun/admin/ip-bans/"+banResp.Ban.ID+"/unban",
			`{}`, tokens["root"], "idem-dossier-unban-1",
		)
		if unbanStatus != http.StatusOK {
			t.Fatalf("unban failed: %d %s", unbanStatus, unbanBody)
		}

		status, body = getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/ip-dossier?ip_hash="+testHash, tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200 after unban, got %d", status)
		}
		resp = map[string]any{}
		_ = json.Unmarshal(body, &resp)
		if resp["is_banned"] != false || resp["ban_info"] != nil {
			t.Fatalf("expected is_banned=false and ban_info=nil after unban, got %v / %#v", resp["is_banned"], resp["ban_info"])
		}
	})
}
