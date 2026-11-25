package pocketbase

import (
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// TestVisitsRetention tests the daily aggregation and 90-day retention cleanup.
func TestVisitsRetention(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	_ = seedIdentityFixtures(t, app)

	// Create test visits: some old (>90 days), some recent (<90 days), some for yesterday (for aggregation)
	col, _ := app.FindCollectionByNameOrId(visitsCollectionName)
	topicCol, _ := app.FindCollectionByNameOrId(topicVisitsCollectionName)

	now := time.Now().UTC()
	oldDate := now.Add(-91 * 24 * time.Hour).Format(pbDateFormat)
	recentDate := now.Add(-30 * 24 * time.Hour).Format(pbDateFormat)
	yesterdayDate := now.Add(-24 * time.Hour).Format(pbDateFormat)

	// Old visit (>90 days) - should have IP cleared
	oldVisit := core.NewRecord(col)
	oldVisit.Set("occurred_at", oldDate)
	oldVisit.Set("user_id", fixPlayerID)
	oldVisit.Set("guest_id", "")
	oldVisit.Set("session_id", "sess_old_1")
	oldVisit.Set("ip", "192.0.2.100")
	oldVisit.Set("ip_hash", hashIP("192.0.2.100"))
	oldVisit.Set("country", "US")
	oldVisit.Set("city", "New York")
	oldVisit.Set("device", "desktop")
	oldVisit.Set("browser", "Chrome")
	oldVisit.Set("os", "Windows")
	oldVisit.Set("entry_path", "/")
	oldVisit.Set("is_bot", false)
	app.Save(oldVisit)

	// Recent visit (<90 days) - should keep IP
	recentVisit := core.NewRecord(col)
	recentVisit.Set("occurred_at", recentDate)
	recentVisit.Set("user_id", fixPlayerID)
	recentVisit.Set("guest_id", "")
	recentVisit.Set("session_id", "sess_recent_1")
	recentVisit.Set("ip", "192.0.2.101")
	recentVisit.Set("ip_hash", hashIP("192.0.2.101"))
	recentVisit.Set("country", "US")
	recentVisit.Set("city", "Boston")
	recentVisit.Set("device", "mobile")
	recentVisit.Set("browser", "Safari")
	recentVisit.Set("os", "iOS")
	recentVisit.Set("entry_path", "/topic/1")
	recentVisit.Set("is_bot", false)
	app.Save(recentVisit)

	// Visit for yesterday - for daily aggregation
	yesterdayVisit := core.NewRecord(col)
	yesterdayVisit.Set("occurred_at", yesterdayDate)
	yesterdayVisit.Set("user_id", fixPlayerID)
	yesterdayVisit.Set("guest_id", "")
	yesterdayVisit.Set("session_id", "sess_yesterday_1")
	yesterdayVisit.Set("ip", "192.0.2.102")
	yesterdayVisit.Set("ip_hash", hashIP("192.0.2.102"))
	yesterdayVisit.Set("country", "DE")
	yesterdayVisit.Set("city", "Berlin")
	yesterdayVisit.Set("device", "desktop")
	yesterdayVisit.Set("browser", "Firefox")
	yesterdayVisit.Set("os", "Linux")
	yesterdayVisit.Set("entry_path", "/topic/2")
	yesterdayVisit.Set("is_bot", false)
	app.Save(yesterdayVisit)

	// Old topic_visit (>90 days) - should be deleted
	oldTopicVisit := core.NewRecord(topicCol)
	oldTopicVisit.Set("topic_id", "topic-old-1")
	oldTopicVisit.Set("occurred_at", oldDate)
	oldTopicVisit.Set("user_id", fixPlayerID)
	oldTopicVisit.Set("guest_id", "")
	oldTopicVisit.Set("session_id", "sess_topic_old_1")
	if err := app.Save(oldTopicVisit); err != nil {
		t.Fatalf("failed to save old topic_visit: %v", err)
	}

	// Recent topic_visit (<90 days) - should be kept
	recentTopicVisit := core.NewRecord(topicCol)
	recentTopicVisit.Set("topic_id", "topic-recent-1")
	recentTopicVisit.Set("occurred_at", recentDate)
	recentTopicVisit.Set("user_id", fixPlayerID)
	recentTopicVisit.Set("guest_id", "")
	recentTopicVisit.Set("session_id", "sess_topic_recent_1")
	if err := app.Save(recentTopicVisit); err != nil {
		t.Fatalf("failed to save recent topic_visit: %v", err)
	}

	// Topic visit for yesterday
	yesterdayTopicVisit := core.NewRecord(topicCol)
	yesterdayTopicVisit.Set("topic_id", "topic-yest-1")
	yesterdayTopicVisit.Set("occurred_at", yesterdayDate)
	yesterdayTopicVisit.Set("user_id", fixPlayerID)
	yesterdayTopicVisit.Set("guest_id", "")
	yesterdayTopicVisit.Set("session_id", "sess_topic_yest_1")
	if err := app.Save(yesterdayTopicVisit); err != nil {
		t.Fatalf("failed to save yesterday topic_visit: %v", err)
	}

	// Run daily aggregation (for yesterday)
	runVisitsDailyAggregation(app)

	// Check that daily_visits_summary was created
	yesterday := now.Add(-24 * time.Hour).Format("2006-01-02")
	summary, err := app.FindFirstRecordByFilter("daily_visits_summary", "date = {:date}", dbx.Params{"date": yesterday})
	if err != nil || summary == nil {
		t.Fatalf("daily_visits_summary not created for yesterday: %v", err)
	}
	if summary.GetInt("total_visits") == 0 {
		t.Fatal("expected total_visits > 0 in daily summary")
	}
	if summary.GetInt("unique_visitors") == 0 {
		t.Fatal("expected unique_visitors > 0 in daily summary")
	}
	if summary.GetString("countries_json") == "" {
		t.Fatal("expected countries_json to be populated")
	}
	if summary.GetString("devices_json") == "" {
		t.Fatal("expected devices_json to be populated")
	}
	if summary.GetString("entry_paths_json") == "" {
		t.Fatal("expected entry_paths_json to be populated")
	}

	// Run retention cleanup
	runVisitsRetentionCleanup(app)

	// Check that old visit IP was cleared
	oldVisits, _ := app.FindRecordsByFilter(visitsCollectionName, "session_id = 'sess_old_1'", "", 1, 0)
	if len(oldVisits) != 1 {
		t.Fatalf("expected 1 old visit, got %d", len(oldVisits))
	}
	if oldVisits[0].GetString("ip") != "" {
		t.Fatalf("expected old visit IP to be cleared, got %s", oldVisits[0].GetString("ip"))
	}

	// Check that recent visit IP is preserved
	recentVisits, _ := app.FindRecordsByFilter(visitsCollectionName, "session_id = 'sess_recent_1'", "", 1, 0)
	if len(recentVisits) != 1 {
		t.Fatalf("expected 1 recent visit, got %d", len(recentVisits))
	}
	if recentVisits[0].GetString("ip") != "192.0.2.101" {
		t.Fatalf("expected recent visit IP to be preserved, got %s", recentVisits[0].GetString("ip"))
	}

	// Check that old topic_visit was deleted
	oldTopicVisits, _ := app.FindRecordsByFilter(topicVisitsCollectionName, "session_id = 'sess_topic_old_1'", "", 1, 0)
	if len(oldTopicVisits) != 0 {
		t.Fatalf("expected old topic_visit to be deleted, got %d", len(oldTopicVisits))
	}

	// Check that recent topic_visit is preserved
	recentTopicVisits, _ := app.FindRecordsByFilter(topicVisitsCollectionName, "session_id = 'sess_topic_recent_1'", "", 1, 0)
	if len(recentTopicVisits) != 1 {
		t.Fatalf("expected recent topic_visit to be preserved, got %d", len(recentTopicVisits))
	}
}
