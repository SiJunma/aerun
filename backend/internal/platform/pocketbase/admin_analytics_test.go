package pocketbase

import (
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
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
