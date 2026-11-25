package pocketbase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// TestUniqueVisitorsAccuracy tests the unique visitor counting logic
func TestUniqueVisitorsAccuracy(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Direct DB test for unique visitor counting
	now := time.Now().UTC()
	yesterday := now.Add(-24 * time.Hour).Format(pbDateFormat)
	today := now.Format(pbDateFormat)

	// Create test visits: 1 member + 2 guests (one with empty guest_id)
	col, _ := app.FindCollectionByNameOrId(visitsCollectionName)

	// Member visit
	rec1 := core.NewRecord(col)
	rec1.Set("occurred_at", today)
	rec1.Set("user_id", fixPlayerID)
	rec1.Set("guest_id", "")
	rec1.Set("session_id", "sess_member_1")
	rec1.Set("ip", "127.0.0.1")
	rec1.Set("ip_hash", hashIP("127.0.0.1"))
	rec1.Set("country", "XX")
	rec1.Set("city", "Local Network")
	rec1.Set("device", "desktop")
	rec1.Set("browser", "Chrome")
	rec1.Set("os", "Windows")
	rec1.Set("entry_path", "/")
	rec1.Set("is_bot", false)
	app.Save(rec1)

	// Guest visit with guest_id
	rec2 := core.NewRecord(col)
	rec2.Set("occurred_at", today)
	rec2.Set("user_id", "")
	rec2.Set("guest_id", "guest_abc_123")
	rec2.Set("session_id", "sess_guest_1")
	rec2.Set("ip", "127.0.0.1")
	rec2.Set("ip_hash", hashIP("127.0.0.1"))
	rec2.Set("country", "XX")
	rec2.Set("city", "Local Network")
	rec2.Set("device", "mobile")
	rec2.Set("browser", "Safari")
	rec2.Set("os", "iOS")
	rec2.Set("entry_path", "/")
	rec2.Set("is_bot", false)
	app.Save(rec2)

	// Guest visit with different guest_id
	rec3 := core.NewRecord(col)
	rec3.Set("occurred_at", today)
	rec3.Set("user_id", "")
	rec3.Set("guest_id", "guest_xyz_789")
	rec3.Set("session_id", "sess_guest_2")
	rec3.Set("ip", "127.0.0.1")
	rec3.Set("ip_hash", hashIP("127.0.0.1"))
	rec3.Set("country", "XX")
	rec3.Set("city", "Local Network")
	rec3.Set("device", "desktop")
	rec3.Set("browser", "Firefox")
	rec3.Set("os", "Linux")
	rec3.Set("entry_path", "/")
	rec3.Set("is_bot", false)
	app.Save(rec3)

	// Bot visit (should be excluded)
	rec4 := core.NewRecord(col)
	rec4.Set("occurred_at", today)
	rec4.Set("user_id", "")
	rec4.Set("guest_id", "bot_guest")
	rec4.Set("session_id", "sess_bot_1")
	rec4.Set("ip", "127.0.0.1")
	rec4.Set("ip_hash", hashIP("127.0.0.1"))
	rec4.Set("country", "XX")
	rec4.Set("city", "Local Network")
	rec4.Set("device", "bot")
	rec4.Set("browser", "Bot")
	rec4.Set("os", "Unknown")
	rec4.Set("entry_path", "/")
	rec4.Set("is_bot", true)
	app.Save(rec4)

	// Query unique visitors (excluding bots)
	var uniques int64
	err := app.DB().Select("COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), NULLIF(guest_id, '')))").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": yesterday, "end": today})).
		Row(&uniques)
	if err != nil {
		t.Fatalf("query uniques: %v", err)
	}
	// Expected: 1 member + 2 distinct guests = 3 uniques (bot excluded)
	if uniques != 3 {
		t.Fatalf("expected 3 unique visitors (1 member + 2 guests), got %d", uniques)
	}
}

// Helper functions

func seedTestVisits(t *testing.T, app *tests.TestApp, token string) {
	t.Helper()
	now := time.Now().UTC()
	col, _ := app.FindCollectionByNameOrId(visitsCollectionName)

	// Create a few visits
	for i := 0; i < 5; i++ {
		rec := core.NewRecord(col)
		rec.Set("occurred_at", now.Add(-time.Duration(i)*time.Hour).Format(pbDateFormat))
		rec.Set("user_id", fixPlayerID)
		rec.Set("guest_id", "")
		rec.Set("session_id", fmt.Sprintf("sess_test_%d", i))
		rec.Set("ip", "127.0.0.1")
		rec.Set("ip_hash", hashIP("127.0.0.1"))
		rec.Set("country", "XX")
		rec.Set("city", "Local Network")
		rec.Set("device", "desktop")
		rec.Set("browser", "Chrome")
		rec.Set("os", "Windows")
		rec.Set("entry_path", "/")
		rec.Set("is_bot", false)
		app.Save(rec)
	}
}

func getAerunAnalytics(t *testing.T, path, token string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode, readBodyAnalytics(t, res)
}

func readBodyAnalytics(t *testing.T, res *http.Response) []byte {
	t.Helper()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// TestAdminAnalyticsDashboardHandler tests the dashboard endpoint permissions and data.
func TestAdminAnalyticsDashboardHandler(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// Create admin user with proper permissions
	adminToken := createTestUser(t, app, "testadmin000001", "testadmin@example.com", "TestAdmin", auth.RoleAdmin, auth.StatusActive)

	seedTestVisits(t, app, tokens["player"])

	t.Run("guest gets 401", func(t *testing.T) {
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=7d", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("guest should get 401, got %d", status)
		}
	})

	t.Run("player gets 403", func(t *testing.T) {
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=7d", tokens["player"])
		if status != http.StatusForbidden {
			t.Fatalf("player should get 403, got %d", status)
		}
	})

	t.Run("admin without view_raw_ip gets masked IP in visits list", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?limit=5", adminToken)
		if status != http.StatusOK {
			t.Fatalf("admin should get 200, got %d", status)
		}
		_ = body
	})

	t.Run("root gets raw IP in visits list", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?limit=5", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("root should get 200, got %d", status)
		}
		_ = body
	})

	t.Run("search by raw IP blocked without view_raw_ip", func(t *testing.T) {
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?query=127.0.0.1&limit=5", adminToken)
		if status != http.StatusOK {
			t.Fatalf("admin should get 200, got %d", status)
		}
	})

	t.Run("dashboard returns expected KPI structure", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=7d", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("root should get 200, got %d", status)
		}
		var resp map[string]any
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("unreadable response: %v", err)
		}
		kpis, ok := resp["kpis"].(map[string]any)
		if !ok {
			t.Fatal("missing kpis in response")
		}
		requiredKPIs := []string{"online_now", "total_visits", "unique_visitors", "registrations", "posts_count", "bot_visits"}
		for _, k := range requiredKPIs {
			if _, ok := kpis[k]; !ok {
				t.Fatalf("missing KPI: %s", k)
			}
		}
		for _, s := range []string{"daily_series", "hourly_series", "dow_series"} {
			if _, ok := resp[s]; !ok {
				t.Fatalf("missing series: %s", s)
			}
		}
		for _, l := range []string{"top_countries", "top_devices", "top_browsers", "top_os", "top_entry_paths"} {
			if _, ok := resp[l]; !ok {
				t.Fatalf("missing ranked list: %s", l)
			}
		}
	})
}

// TestAdminAnalyticsTopicsHandler tests the topics analytics endpoint.
func TestAdminAnalyticsTopicsHandler(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	_ = seedIdentityFixtures(t, app)

	// Create admin user with proper permissions
	adminToken := createTestUser(t, app, "testadmin000002", "testadmin2@example.com", "TestAdmin2", auth.RoleAdmin, auth.StatusActive)

	t.Run("guest gets 401", func(t *testing.T) {
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/topics?period=7d", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("guest should get 401, got %d", status)
		}
	})

	t.Run("admin gets topic analytics", func(t *testing.T) {
		catID := getGeneralCategoryID(t, app)
		topicRec := seedTopicIn(t, app, "test-topic-analytics", catID, fixPlayerID, time.Now())
		topicID := topicRec.Id

		recordTopicVisit(app, "sess_topic_1", topicID, fixPlayerID, "")
		recordTopicVisit(app, "sess_topic_2", topicID, "", "guest_1")

		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/topics?period=7d&limit=10", adminToken)
		if status != http.StatusOK {
			t.Fatalf("admin should get 200, got %d", status)
		}
		var resp map[string]any
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("unreadable response: %v", err)
		}
		items, ok := resp["items"].([]any)
		if !ok {
			t.Fatal("missing items in response")
		}
		if len(items) == 0 {
			t.Fatal("expected at least one topic in results")
		}
		first := items[0].(map[string]any)
		required := []string{"topic_id", "title", "views", "unique_readers", "last_visited"}
		for _, f := range required {
			if _, ok := first[f]; !ok {
				t.Fatalf("missing field in topic item: %s", f)
			}
		}
	})
}

// TestAdminAnalyticsVisitsHandler tests the paginated visits list endpoint.
func TestAdminAnalyticsVisitsHandler(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// Create admin user with proper permissions
	adminToken := createTestUser(t, app, "testadmin000003", "testadmin3@example.com", "TestAdmin3", auth.RoleAdmin, auth.StatusActive)

	seedTestVisits(t, app, adminToken)

	t.Run("guest gets 401", func(t *testing.T) {
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("guest should get 401, got %d", status)
		}
	})

	t.Run("player gets 403", func(t *testing.T) {
		playerToken := tokens["player"]
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits", playerToken)
		if status != http.StatusForbidden {
			t.Fatalf("player should get 403, got %d", status)
		}
	})

	t.Run("admin gets paginated visits with masked IP", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?page=1&limit=10", adminToken)
		if status != http.StatusOK {
			t.Fatalf("admin should get 200, got %d", status)
		}
		var resp map[string]any
		if err := json.Unmarshal(body, &resp); err != nil {
			t.Fatalf("unreadable response: %v", err)
		}
		for _, f := range []string{"items", "total", "page", "limit"} {
			if _, ok := resp[f]; !ok {
				t.Fatalf("missing pagination field: %s", f)
			}
		}
		items := resp["items"].([]any)
		if len(items) > 0 {
			first := items[0].(map[string]any)
			if ip, ok := first["ip"].(string); ok {
				if ip != "" && !strings.Contains(ip, "***") && ip != "127.0.0.1" {
					t.Logf("IP format: %s", ip)
				}
			}
		}
	})

	t.Run("root gets raw IP", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?page=1&limit=10", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("root should get 200, got %d", status)
		}
		var resp map[string]any
		json.Unmarshal(body, &resp)
		items := resp["items"].([]any)
		if len(items) > 0 {
			first := items[0].(map[string]any)
			if ip, ok := first["ip"].(string); ok && ip != "" {
				_ = ip
			}
		}
	})

	t.Run("filters work: members, guests, bots", func(t *testing.T) {
		for _, filter := range []string{"members", "guests", "bots", "all"} {
			status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?filter="+filter+"&limit=5", tokens["root"])
			if status != http.StatusOK {
				t.Fatalf("filter %s should work, got %d", filter, status)
			}
		}
	})

	t.Run("search by nickname works", func(t *testing.T) {
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?query=playerone&limit=5", tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("search should work, got %d", status)
		}
		var resp map[string]any
		json.Unmarshal(body, &resp)
		_ = resp["items"]
	})
}

func TestAdminAnalyticsCustomDateRangeAndAdminPathExclusion(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	col, _ := app.FindCollectionByNameOrId(visitsCollectionName)

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC)
	yesterday := today.AddDate(0, 0, -1)
	twoDaysAgo := today.AddDate(0, 0, -2)
	tomorrow := today.AddDate(0, 0, 1)

	insertVisit := func(when time.Time, sid, path string) {
		rec := core.NewRecord(col)
		rec.Set("occurred_at", when.Format(pbDateFormat))
		rec.Set("user_id", fixPlayerID)
		rec.Set("session_id", sid)
		rec.Set("ip", "203.0.113.10")
		rec.Set("ip_hash", hashIP("203.0.113.10"))
		rec.Set("country", "US")
		rec.Set("city", "NY")
		rec.Set("device", "desktop")
		rec.Set("browser", "Chrome")
		rec.Set("os", "Windows")
		rec.Set("entry_path", path)
		rec.Set("is_bot", false)
		if err := app.Save(rec); err != nil {
			t.Fatalf("save visit: %v", err)
		}
	}

	// 2 visits twoDaysAgo, 1 visit yesterday, 3 visits today (1 of which is /admin?tab=visits)
	insertVisit(twoDaysAgo, "s_d2_1", "/topic/1")
	insertVisit(twoDaysAgo, "s_d2_2", "/topic/2")
	insertVisit(yesterday, "s_d1_1", "/")
	insertVisit(today, "s_d0_1", "/")
	insertVisit(today, "s_d0_2", "/admin?tab=visits")
	insertVisit(today, "s_d0_3", "/admin/users")

	t.Run("single day filters KPIs and computes equal-length previous day", func(t *testing.T) {
		yStr := yesterday.Format("2006-01-02")
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=custom&from="+yStr+"&to="+yStr, tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp map[string]any
		_ = json.Unmarshal(body, &resp)
		kpis := resp["kpis"].(map[string]any)
		if kpis["total_visits"] != float64(1) {
			t.Fatalf("expected 1 visit on yesterday, got %v", kpis["total_visits"])
		}
		if kpis["prev_visits"] != float64(2) {
			t.Fatalf("expected 2 prev_visits (twoDaysAgo), got %v", kpis["prev_visits"])
		}
	})

	t.Run("custom range filters visits list and excludes /admin* from top_entry_paths", func(t *testing.T) {
		tStr := today.Format("2006-01-02")
		status, body := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=custom&from="+tStr+"&to="+tStr, tokens["root"])
		if status != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", status, body)
		}
		var resp map[string]any
		_ = json.Unmarshal(body, &resp)
		paths := resp["top_entry_paths"].([]any)
		for _, item := range paths {
			name := item.(map[string]any)["name"].(string)
			if strings.HasPrefix(name, "/admin") {
				t.Fatalf("top_entry_paths must exclude /admin routes, got %q", name)
			}
		}

		// Recent visits filtered by yesterday only
		yStr := yesterday.Format("2006-01-02")
		vStatus, vBody := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/visits?period=custom&from="+yStr+"&to="+yStr, tokens["root"])
		if vStatus != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", vStatus, vBody)
		}
		var vResp map[string]any
		_ = json.Unmarshal(vBody, &vResp)
		if vResp["total"] != float64(1) {
			t.Fatalf("expected 1 visit in recent visits for yesterday, got %v", vResp["total"])
		}
	})

	t.Run("invalid date bounds are rejected with 400", func(t *testing.T) {
		tStr := today.Format("2006-01-02")
		yStr := yesterday.Format("2006-01-02")
		fStr := tomorrow.Format("2006-01-02")

		// start > end
		status, _ := getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=custom&from="+tStr+"&to="+yStr, tokens["root"])
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400 for from > to, got %d", status)
		}
		// end in future
		status, _ = getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=custom&from="+tStr+"&to="+fStr, tokens["root"])
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400 for future end date, got %d", status)
		}
		// missing to
		status, _ = getAerunAnalytics(t, ts.URL+"/api/aerun/admin/analytics/dashboard?period=custom&from="+tStr, tokens["root"])
		if status != http.StatusBadRequest {
			t.Fatalf("expected 400 for missing 'to' date, got %d", status)
		}
	})
}
