package pocketbase

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// registerVisitsDailyAggregationCron aggregates the previous day's visits into daily_visits_summary.
func registerVisitsDailyAggregationCron(app core.App) error {
	return app.Cron().Add("visitsDailyAggregation", "0 2 * * *", func() {
		runVisitsDailyAggregation(app)
	})
}

// runVisitsDailyAggregation calculates yesterday's stats and saves to daily_visits_summary.
func runVisitsDailyAggregation(app core.App) {
	yesterday := time.Now().UTC().Add(-24 * time.Hour)
	dayStr := yesterday.Format("2006-01-02")
	start := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, time.UTC).Format(pbDateFormat)
	end := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 23, 59, 59, 999999999, time.UTC).Format(pbDateFormat)

	var totalVisits, uniques, uniqueMembers, uniqueGuests, botVisits, newRegs, postsCount int64

	_ = app.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": start, "end": end})).
		Row(&totalVisits)

	_ = app.DB().Select("COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), NULLIF(guest_id, '')))").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": start, "end": end})).
		Row(&uniques)

	_ = app.DB().Select("COUNT(DISTINCT NULLIF(user_id, ''))").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0 AND user_id IS NOT NULL AND user_id != ''", dbx.Params{"start": start, "end": end})).
		Row(&uniqueMembers)

	_ = app.DB().Select("COUNT(DISTINCT NULLIF(guest_id, ''))").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0 AND (user_id IS NULL OR user_id = '')", dbx.Params{"start": start, "end": end})).
		Row(&uniqueGuests)

	_ = app.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 1", dbx.Params{"start": start, "end": end})).
		Row(&botVisits)

	_ = app.DB().Select("COUNT(*)").From("users").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end}", dbx.Params{"start": start, "end": end})).
		Row(&newRegs)

	_ = app.DB().Select("COUNT(*)").From("posts").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end} AND (is_draft = false OR is_draft IS NULL)", dbx.Params{"start": start, "end": end})).
		Row(&postsCount)

	type RankedItem struct {
		Key   string `db:"k"`
		Count int64  `db:"c"`
	}

	fetchBreakdown := func(field string) types.JSONRaw {
		items := []RankedItem{}
		q := fmt.Sprintf(`
			SELECT COALESCE(NULLIF(%s, ''), 'Other') as k, COUNT(*) as c
			FROM visits
			WHERE occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0
			GROUP BY k
			ORDER BY c DESC
			LIMIT 15
		`, field)
		_ = app.DB().NewQuery(q).Bind(dbx.Params{"start": start, "end": end}).All(&items)
		raw, _ := json.Marshal(items)
		return types.JSONRaw(raw)
	}

	countriesJSON := fetchBreakdown("country")
	devicesJSON := fetchBreakdown("device")
	entryPathsJSON := fetchBreakdown("entry_path")

	col, err := app.FindCollectionByNameOrId("daily_visits_summary")
	if err != nil || col == nil {
		app.Logger().Warn("daily_visits_summary collection not found for aggregation", "error", err)
		return
	}

	rec, _ := app.FindFirstRecordByFilter("daily_visits_summary", "date = {:day}", dbx.Params{"day": dayStr})
	if rec == nil {
		rec = core.NewRecord(col)
		rec.Set("date", dayStr)
	}

	rec.Set("total_visits", totalVisits)
	rec.Set("unique_visitors", uniques)
	rec.Set("unique_members", uniqueMembers)
	rec.Set("unique_guests", uniqueGuests)
	rec.Set("bot_visits", botVisits)
	rec.Set("new_registrations", newRegs)
	rec.Set("posts_count", postsCount)
	rec.Set("countries_json", countriesJSON)
	rec.Set("devices_json", devicesJSON)
	rec.Set("entry_paths_json", entryPathsJSON)

	if err := app.Save(rec); err != nil {
		app.Logger().Warn("Failed to save daily visits summary", "date", dayStr, "error", err)
	} else {
		app.Logger().Info("Daily visits summary aggregated successfully", "date", dayStr, "uniques", uniques)
	}
}

// registerVisitsRetentionCron registers the 90-day retention cleanup job.
func registerVisitsRetentionCron(app core.App) error {
	return app.Cron().Add("visitsRetentionCleanup", "0 3 * * *", func() {
		runVisitsRetentionCleanup(app)
	})
}

// runVisitsRetentionCleanup anonymizes raw IP on visits older than 90 days and deletes old topic_visits.
// Note: PocketBase TextFields store "" (empty string, NOT NULL) by default, so ip is cleared to ”.
func runVisitsRetentionCleanup(app core.App) {
	threshold := time.Now().UTC().Add(-90 * 24 * time.Hour).Format(pbDateFormat)

	resVisits, err := app.DB().NewQuery(
		"UPDATE visits SET ip = '' WHERE occurred_at < {:threshold} AND ip != ''",
	).Bind(dbx.Params{"threshold": threshold}).Execute()

	if err != nil {
		app.Logger().Warn("Retention: failed to anonymize old visits IP", "error", err)
	} else if resVisits != nil {
		if rows, _ := resVisits.RowsAffected(); rows > 0 {
			app.Logger().Info("Retention: anonymized raw IPs in visits", "rows", rows)
		}
	}

	resTopics, err := app.DB().NewQuery(
		"DELETE FROM topic_visits WHERE occurred_at < {:threshold}",
	).Bind(dbx.Params{"threshold": threshold}).Execute()

	if err != nil {
		app.Logger().Warn("Retention: failed to prune old topic_visits", "error", err)
	} else if resTopics != nil {
		if rows, _ := resTopics.RowsAffected(); rows > 0 {
			app.Logger().Info("Retention: pruned old topic_visits", "rows", rows)
		}
	}
}
