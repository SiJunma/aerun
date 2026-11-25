package pocketbase

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// maskIP masks an IP address unless the viewer has PermViewRawIP.
func maskIP(ip string) string {
	clean := strings.TrimSpace(ip)
	if clean == "" {
		return ""
	}
	if strings.Contains(clean, ".") {
		parts := strings.Split(clean, ".")
		if len(parts) == 4 {
			return parts[0] + "." + parts[1] + ".***.***"
		}
		return clean[:len(clean)/2] + "***"
	}
	if strings.Contains(clean, ":") {
		parts := strings.Split(clean, ":")
		if len(parts) >= 2 {
			return parts[0] + ":" + parts[1] + ":****:****"
		}
	}
	return clean
}

// resolvePeriodBounds returns (currentStart, currentEnd, prevStart, prevEnd) formatted in
// PocketBase's native SQLite DateTime format ("2006-01-02 15:04:05.000Z") so string
// range comparisons in SQLite match stored DateField values accurately.
//
// When fromStr/toStr (or dateStr for a single day) are provided, it validates:
//   - YYYY-MM-DD format for both bounds
//   - start <= end
//   - end is not in the future (UTC date <= today UTC)
//
// and computes the previous period as an equal-length span immediately preceding curStart.
func resolvePeriodBounds(period, fromStr, toStr, dateStr string) (string, string, string, string, error) {
	now := time.Now().UTC()
	todayUTC := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	fromStr = strings.TrimSpace(fromStr)
	toStr = strings.TrimSpace(toStr)
	dateStr = strings.TrimSpace(dateStr)

	if dateStr != "" && fromStr == "" && toStr == "" {
		fromStr = dateStr
		toStr = dateStr
	}

	if fromStr != "" || toStr != "" || period == "custom" {
		if fromStr == "" || toStr == "" {
			return "", "", "", "", fmt.Errorf("both 'from' and 'to' dates are required")
		}
		fromDate, err := time.Parse("2006-01-02", fromStr)
		if err != nil {
			return "", "", "", "", fmt.Errorf("invalid 'from' date format; expected YYYY-MM-DD")
		}
		toDate, err := time.Parse("2006-01-02", toStr)
		if err != nil {
			return "", "", "", "", fmt.Errorf("invalid 'to' date format; expected YYYY-MM-DD")
		}
		fromDate = time.Date(fromDate.Year(), fromDate.Month(), fromDate.Day(), 0, 0, 0, 0, time.UTC)
		toDate = time.Date(toDate.Year(), toDate.Month(), toDate.Day(), 0, 0, 0, 0, time.UTC)

		if fromDate.After(toDate) {
			return "", "", "", "", fmt.Errorf("start date cannot be after end date")
		}
		if toDate.After(todayUTC) {
			return "", "", "", "", fmt.Errorf("end date cannot be in the future")
		}

		days := int(toDate.Sub(fromDate)/(24*time.Hour)) + 1
		span := time.Duration(days) * 24 * time.Hour
		curStart := fromDate
		curEnd := curStart.Add(span - time.Millisecond)
		prevStart := curStart.Add(-span)
		prevEnd := curStart.Add(-time.Millisecond)

		return curStart.Format(pbDateFormat), curEnd.Format(pbDateFormat), prevStart.Format(pbDateFormat), prevEnd.Format(pbDateFormat), nil
	}

	var curStart, curEnd, prevStart, prevEnd time.Time

	switch period {
	case "today":
		curStart = todayUTC
		curEnd = now
		duration := curEnd.Sub(curStart)
		prevEnd = curStart
		prevStart = prevEnd.Add(-duration)
	case "7d":
		curEnd = now
		curStart = now.Add(-7 * 24 * time.Hour)
		prevEnd = curStart
		prevStart = curStart.Add(-7 * 24 * time.Hour)
	default: // "30d"
		curEnd = now
		curStart = now.Add(-30 * 24 * time.Hour)
		prevEnd = curStart
		prevStart = curStart.Add(-30 * 24 * time.Hour)
	}

	return curStart.Format(pbDateFormat), curEnd.Format(pbDateFormat), prevStart.Format(pbDateFormat), prevEnd.Format(pbDateFormat), nil
}

// adminAnalyticsDashboardHandler returns high-level KPI and chart data for the visits dashboard.
func adminAnalyticsDashboardHandler(e *core.RequestEvent) error {
	q := e.Request.URL.Query()
	period := q.Get("period")
	fromStr := q.Get("from")
	toStr := q.Get("to")
	dateStr := q.Get("date")
	if period == "" {
		if fromStr != "" || toStr != "" || dateStr != "" {
			period = "custom"
		} else {
			period = "30d"
		}
	}

	curStart, curEnd, prevStart, prevEnd, err := resolvePeriodBounds(period, fromStr, toStr, dateStr)
	if err != nil {
		return validationError(err.Error())
	}

	// Reuse the single source of truth for Online Now (matches GET /api/aerun/status).
	now := time.Now()
	membersOnline := int64(len(activeMembersAt(now, e.App)))
	var guestsOnline int64
	if guestRecords, err := activeGuestRecords(e.App, now); err == nil {
		guestsOnline = int64(len(guestRecords))
	}

	// Current period visits and uniques.
	// Note: PocketBase TextField stores empty string "", NOT NULL, so COALESCE requires NULLIF(..., '').
	const uniqueVisitorExpr = "COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), NULLIF(guest_id, '')))"

	var curTotalVisits, curUniques, curBotVisits, curMemberVisits, curGuestVisits int64
	_ = e.App.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curTotalVisits)

	_ = e.App.DB().Select(uniqueVisitorExpr).From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curUniques)

	_ = e.App.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 1", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curBotVisits)

	_ = e.App.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0 AND user_id IS NOT NULL AND user_id != ''", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curMemberVisits)

	curGuestVisits = curTotalVisits - curMemberVisits
	if curGuestVisits < 0 {
		curGuestVisits = 0
	}

	// Current period registrations and posts
	var curRegistrations, curPosts int64
	_ = e.App.DB().Select("COUNT(*)").From("users").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end}", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curRegistrations)

	_ = e.App.DB().Select("COUNT(*)").From("posts").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end} AND (is_draft = false OR is_draft IS NULL)", dbx.Params{"start": curStart, "end": curEnd})).
		Row(&curPosts)

	// Previous period metrics for delta calculation
	var prevTotalVisits, prevUniques, prevRegistrations, prevPosts int64
	_ = e.App.DB().Select("COUNT(*)").From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": prevStart, "end": prevEnd})).
		Row(&prevTotalVisits)

	_ = e.App.DB().Select(uniqueVisitorExpr).From("visits").
		Where(dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0", dbx.Params{"start": prevStart, "end": prevEnd})).
		Row(&prevUniques)

	_ = e.App.DB().Select("COUNT(*)").From("users").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end}", dbx.Params{"start": prevStart, "end": prevEnd})).
		Row(&prevRegistrations)

	_ = e.App.DB().Select("COUNT(*)").From("posts").
		Where(dbx.NewExp("created >= {:start} AND created <= {:end} AND (is_draft = false OR is_draft IS NULL)", dbx.Params{"start": prevStart, "end": prevEnd})).
		Row(&prevPosts)

	// Daily series: GROUP BY date(occurred_at)
	type DailyPoint struct {
		Date    string `db:"day"`
		Visits  int64  `db:"visits"`
		Uniques int64  `db:"uniques"`
		Bots    int64  `db:"bots"`
	}
	var dailyPoints []DailyPoint
	_ = e.App.DB().NewQuery(`
		SELECT 
			substr(occurred_at, 1, 10) as day,
			SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) as visits,
			COUNT(DISTINCT CASE WHEN is_bot = 0 THEN COALESCE(NULLIF(user_id, ''), NULLIF(guest_id, '')) END) as uniques,
			SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) as bots
		FROM visits
		WHERE occurred_at >= {:start} AND occurred_at <= {:end}
		GROUP BY day
		ORDER BY day ASC
	`).Bind(dbx.Params{"start": curStart, "end": curEnd}).All(&dailyPoints)

	// Hourly distribution (0-23)
	type HourPoint struct {
		Hour  int   `db:"hr"`
		Count int64 `db:"cnt"`
	}
	var hourPoints []HourPoint
	_ = e.App.DB().NewQuery(`
		SELECT 
			CAST(strftime('%H', occurred_at) AS INTEGER) as hr,
			COUNT(*) as cnt
		FROM visits
		WHERE occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0
		GROUP BY hr
		ORDER BY hr ASC
	`).Bind(dbx.Params{"start": curStart, "end": curEnd}).All(&hourPoints)

	hourlySeries := make([]int64, 24)
	for _, p := range hourPoints {
		if p.Hour >= 0 && p.Hour < 24 {
			hourlySeries[p.Hour] = p.Count
		}
	}

	// Day of week distribution (0 = Sunday .. 6 = Saturday)
	type DOWPoint struct {
		DOW   int   `db:"dow"`
		Count int64 `db:"cnt"`
	}
	var dowPoints []DOWPoint
	_ = e.App.DB().NewQuery(`
		SELECT 
			CAST(strftime('%w', occurred_at) AS INTEGER) as dow,
			COUNT(*) as cnt
		FROM visits
		WHERE occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0
		GROUP BY dow
		ORDER BY dow ASC
	`).Bind(dbx.Params{"start": curStart, "end": curEnd}).All(&dowPoints)

	dowSeries := make([]int64, 7)
	for _, p := range dowPoints {
		if p.DOW >= 0 && p.DOW < 7 {
			dowSeries[p.DOW] = p.Count
		}
	}

	// Helper for ranked lists
	queryRankedList := func(field string, limit int) []map[string]any {
		type Row struct {
			Key   string `db:"k"`
			Count int64  `db:"c"`
		}
		var rows []Row
		extraWhere := ""
		if field == "entry_path" {
			// Exclude admin panel routes from visitor entry paths ranking.
			extraWhere = " AND entry_path != '/admin' AND entry_path NOT LIKE '/admin/%' AND entry_path NOT LIKE '/admin?%' AND entry_path NOT LIKE '/admin#%'"
		}
		q := fmt.Sprintf(`
			SELECT COALESCE(NULLIF(%s, ''), 'Other') as k, COUNT(*) as c
			FROM visits
			WHERE occurred_at >= {:start} AND occurred_at <= {:end} AND is_bot = 0%s
			GROUP BY k
			ORDER BY c DESC
			LIMIT %d
		`, field, extraWhere, limit)
		_ = e.App.DB().NewQuery(q).Bind(dbx.Params{"start": curStart, "end": curEnd}).All(&rows)

		result := make([]map[string]any, 0, len(rows))
		for _, r := range rows {
			result = append(result, map[string]any{
				"name":  r.Key,
				"count": r.Count,
			})
		}
		return result
	}

	topCountries := queryRankedList("country", 10)
	topDevices := queryRankedList("device", 5)
	topBrowsers := queryRankedList("browser", 10)
	topOS := queryRankedList("os", 10)
	topEntryPaths := queryRankedList("entry_path", 10)
	geoipAvailable := geoIPDatabaseExists(e.App.DataDir())


	return e.JSON(http.StatusOK, map[string]any{
		"period": period,
		"kpis": map[string]any{
			"online_now":      membersOnline + guestsOnline,
			"members_online":  membersOnline,
			"guests_online":   guestsOnline,
			"total_visits":    curTotalVisits,
			"prev_visits":     prevTotalVisits,
			"unique_visitors": curUniques,
			"prev_uniques":    prevUniques,
			"registrations":   curRegistrations,
			"prev_reg":        prevRegistrations,
			"posts_count":     curPosts,
			"prev_posts":      prevPosts,
			"bot_visits":      curBotVisits,
			"member_visits":   curMemberVisits,
			"guest_visits":    curGuestVisits,
		},
		"daily_series":    dailyPoints,
		"hourly_series":   hourlySeries,
		"dow_series":      dowSeries,
		"top_countries":   topCountries,
		"top_devices":     topDevices,
		"top_browsers":    topBrowsers,
		"top_os":          topOS,
		"top_entry_paths": topEntryPaths,
		"geoip_available":  geoipAvailable,
	})
}

// adminAnalyticsTopicsHandler returns topics ranked by unique readers and views.
func adminAnalyticsTopicsHandler(e *core.RequestEvent) error {
	q := e.Request.URL.Query()
	period := q.Get("period")
	fromStr := q.Get("from")
	toStr := q.Get("to")
	dateStr := q.Get("date")
	if period == "" {
		if fromStr != "" || toStr != "" || dateStr != "" {
			period = "custom"
		} else {
			period = "30d"
		}
	}
	limitStr := q.Get("limit")
	limit := 20
	if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	curStart, curEnd, _, _, err := resolvePeriodBounds(period, fromStr, toStr, dateStr)
	if err != nil {
		return validationError(err.Error())
	}

	type TopicVisitAgg struct {
		TopicID       string `db:"topic_id"`
		Views         int64  `db:"views"`
		UniqueReaders int64  `db:"uniques"`
		LastVisited   string `db:"last_visited"`
	}

	var aggs []TopicVisitAgg
	err = e.App.DB().NewQuery(`
		SELECT 
			topic_id,
			COUNT(*) as views,
			COUNT(DISTINCT COALESCE(NULLIF(user_id, ''), NULLIF(guest_id, ''))) as uniques,
			MAX(occurred_at) as last_visited
		FROM topic_visits
		WHERE occurred_at >= {:start} AND occurred_at <= {:end}
		GROUP BY topic_id
		ORDER BY uniques DESC, views DESC
		LIMIT {:limit}
	`).Bind(dbx.Params{"start": curStart, "end": curEnd, "limit": limit}).All(&aggs)

	if err != nil {
		return internalError("failed to query topic visits", err)
	}

	topicIDs := make([]string, len(aggs))
	for i, a := range aggs {
		topicIDs[i] = a.TopicID
	}

	topicsCol, err := e.App.FindCollectionByNameOrId(topicsCollectionName)
	topicMap := make(map[string]map[string]any)
	if err == nil && len(topicIDs) > 0 {
		records, err := e.App.FindRecordsByIds(topicsCol, topicIDs)
		if err == nil {
			for _, rec := range records {
				topicMap[rec.Id] = map[string]any{
					"id":          rec.Id,
					"title":       rec.GetString("title"),
					"category_id": rec.GetString("category_id"),
				}
			}
		}
	}

	items := make([]map[string]any, 0, len(aggs))
	for _, a := range aggs {
		title := "Unknown Topic"
		categoryID := ""
		if t, ok := topicMap[a.TopicID]; ok {
			title = t["title"].(string)
			categoryID = t["category_id"].(string)
		}
		items = append(items, map[string]any{
			"topic_id":       a.TopicID,
			"title":          title,
			"category_id":    categoryID,
			"views":          a.Views,
			"unique_readers": a.UniqueReaders,
			"last_visited":   a.LastVisited,
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items": items,
	})
}

// adminAnalyticsVisitsHandler returns paginated recent visits with IP masking according to RBAC.
func adminAnalyticsVisitsHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	canViewRawIP := auth.Has(acc.Permissions, auth.PermViewRawIP)

	page := int64(1)
	if p, err := strconv.ParseInt(e.Request.URL.Query().Get("page"), 10, 64); err == nil && p > 0 {
		page = p
	}
	limit := int64(25)
	if l, err := strconv.ParseInt(e.Request.URL.Query().Get("limit"), 10, 64); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	q := e.Request.URL.Query()
	filter := q.Get("filter") // all, members, guests, bots
	query := strings.TrimSpace(q.Get("query"))
	period := q.Get("period")
	fromStr := q.Get("from")
	toStr := q.Get("to")
	dateStr := q.Get("date")

	col, err := e.App.FindCollectionByNameOrId(visitsCollectionName)
	if err != nil || col == nil {
		return internalError("visits collection unavailable", err)
	}

	recordQuery := e.App.RecordQuery(col).OrderBy("occurred_at DESC")
	countQuery := e.App.DB().Select("COUNT(*)").From(visitsCollectionName)

	if period != "" || fromStr != "" || toStr != "" || dateStr != "" {
		if period == "" {
			period = "custom"
		}
		curStart, curEnd, _, _, err := resolvePeriodBounds(period, fromStr, toStr, dateStr)
		if err != nil {
			return validationError(err.Error())
		}
		dateExp := dbx.NewExp("occurred_at >= {:start} AND occurred_at <= {:end}", dbx.Params{"start": curStart, "end": curEnd})
		recordQuery.AndWhere(dateExp)
		countQuery.AndWhere(dateExp)
	}

	switch filter {
	case "members":
		recordQuery.AndWhere(dbx.NewExp("user_id IS NOT NULL AND user_id != ''"))
		countQuery.AndWhere(dbx.NewExp("user_id IS NOT NULL AND user_id != ''"))
	case "guests":
		recordQuery.AndWhere(dbx.NewExp("(user_id IS NULL OR user_id = '') AND is_bot = 0"))
		countQuery.AndWhere(dbx.NewExp("(user_id IS NULL OR user_id = '') AND is_bot = 0"))
	case "bots":
		recordQuery.AndWhere(dbx.NewExp("is_bot = 1"))
		countQuery.AndWhere(dbx.NewExp("is_bot = 1"))
	default: // all
	}

	if query != "" {
		var likeExp dbx.Expression
		params := dbx.Params{"q": "%" + query + "%"}
		if canViewRawIP {
			likeExp = dbx.NewExp(
				"country LIKE {:q} OR city LIKE {:q} OR entry_path LIKE {:q} OR ip LIKE {:q} OR user_id IN (SELECT id FROM users WHERE nickname LIKE {:q})",
				params,
			)
		} else {
			// Without PermViewRawIP, do not let search act as an oracle for raw IP addresses.
			likeExp = dbx.NewExp(
				"country LIKE {:q} OR city LIKE {:q} OR entry_path LIKE {:q} OR user_id IN (SELECT id FROM users WHERE nickname LIKE {:q})",
				params,
			)
		}
		recordQuery.AndWhere(likeExp)
		countQuery.AndWhere(likeExp)
	}

	var total int64
	_ = countQuery.Row(&total)

	offset := (page - 1) * limit
	recordQuery.Limit(limit).Offset(offset)

	records := []*core.Record{}
	if err := recordQuery.All(&records); err != nil {
		return internalError("failed to query visits", err)
	}

	// Collect user IDs for nickname enrichment
	userIDs := make([]string, 0, len(records))
	for _, r := range records {
		uid := r.GetString("user_id")
		if uid != "" {
			userIDs = append(userIDs, uid)
		}
	}

	userMap := make(map[string]map[string]string)
	if len(userIDs) > 0 {
		usersCol, err := e.App.FindCollectionByNameOrId(usersCollectionName)
		if err == nil {
			uRecords, err := e.App.FindRecordsByIds(usersCol, userIDs)
			if err == nil {
				for _, ur := range uRecords {
					userMap[ur.Id] = map[string]string{
						"nickname": ur.GetString("nickname"),
						"avatar":   ur.GetString("avatar"),
						"role":     ur.GetString("role"),
					}
				}
			}
		}
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		rawIP := r.GetString("ip")
		displayIP := rawIP
		if !canViewRawIP {
			displayIP = maskIP(rawIP)
		}

		uid := r.GetString("user_id")
		var userProfile any
		if u, ok := userMap[uid]; ok {
			userProfile = u
		}

		items = append(items, map[string]any{
			"id":          r.Id,
			"occurred_at": r.GetString("occurred_at"),
			"user_id":     uid,
			"guest_id":    r.GetString("guest_id"),
			"session_id":  r.GetString("session_id"),
			"ip":          displayIP,
			"ip_hash":     r.GetString("ip_hash"),
			"country":     r.GetString("country"),
			"city":        r.GetString("city"),
			"device":      r.GetString("device"),
			"browser":     r.GetString("browser"),
			"os":          r.GetString("os"),
			"entry_path":  r.GetString("entry_path"),
			"referrer":    r.GetString("referrer"),
			"is_bot":      r.GetBool("is_bot"),
			"user":        userProfile,
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items": items,
		"total": total,
		"page":  page,
		"limit": limit,
	})
}
