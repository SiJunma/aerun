package pocketbase

import (
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// adminAnalyticsIPDossierHandler returns detailed intelligence about a given IP or ip_hash.
func adminAnalyticsIPDossierHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	canViewRawIP := auth.Has(acc.Permissions, auth.PermViewRawIP)
	canManageBans := auth.Has(acc.Permissions, auth.PermManageIPBans)

	targetIP := strings.TrimSpace(e.Request.URL.Query().Get("ip"))
	targetHash := strings.TrimSpace(e.Request.URL.Query().Get("ip_hash"))

	// If caller passed a masked IP placeholder (e.g. "192.168.***.***"), ignore it as a raw address.
	if strings.Contains(targetIP, "*") {
		targetIP = ""
	}

	if targetIP == "" && targetHash == "" {
		return validationError("Either ip or ip_hash is required")
	}

	if targetHash == "" && targetIP != "" {
		targetHash = hashIPWithApp(e.App, targetIP)
	}

	// 1. Resolve country, city, and stored raw IP from recent visit for this ip_hash.
	type GeoRow struct {
		IP      string `db:"ip"`
		Country string `db:"country"`
		City    string `db:"city"`
	}
	var geo GeoRow
	_ = e.App.DB().NewQuery(`
		SELECT ip, country, city 
		FROM visits 
		WHERE ip_hash = {:hash} 
		ORDER BY occurred_at DESC 
		LIMIT 1
	`).Bind(dbx.Params{"hash": targetHash}).One(&geo)

	resolvedRawIP := targetIP
	if resolvedRawIP == "" {
		resolvedRawIP = geo.IP
	}

	// 2. Check if banned using the resolved raw IP server-side (never expose unmasked IP if denied).
	isBanned := false
	var banInfo map[string]any
	if resolvedRawIP != "" {
		banned, entry := CheckIPBanned(e.App, resolvedRawIP)
		if banned && entry != nil {
			isBanned = true
			banLabel := entry.IPOrSubnet
			if !canViewRawIP {
				banLabel = maskIP(banLabel)
			}
			banInfo = map[string]any{
				"id":           entry.ID,
				"ip_or_subnet": banLabel,
				"reason":       entry.Reason,
				"banned_by":    entry.BannedBy,
				"expires_at":   entry.ExpiresAt,
			}
		}
	}

	displayIP := resolvedRawIP
	if !canViewRawIP && displayIP != "" {
		displayIP = maskIP(displayIP)
	}

	// 3. Find all associated registered accounts
	type AccountRow struct {
		UserID    string `db:"user_id"`
		FirstSeen string `db:"first_seen"`
		LastSeen  string `db:"last_seen"`
		Visits    int64  `db:"visits"`
	}
	var accRows []AccountRow
	_ = e.App.DB().NewQuery(`
		SELECT 
			user_id,
			MIN(occurred_at) as first_seen,
			MAX(occurred_at) as last_seen,
			COUNT(*) as visits
		FROM visits
		WHERE ip_hash = {:hash} AND user_id IS NOT NULL AND user_id != ''
		GROUP BY user_id
		ORDER BY visits DESC
	`).Bind(dbx.Params{"hash": targetHash}).All(&accRows)

	uIDs := make([]string, len(accRows))
	for i, r := range accRows {
		uIDs[i] = r.UserID
	}

	userMap := make(map[string]map[string]any)
	if len(uIDs) > 0 {
		usersCol, err := e.App.FindCollectionByNameOrId(usersCollectionName)
		if err == nil {
			uRecs, err := e.App.FindRecordsByIds(usersCol, uIDs)
			if err == nil {
				for _, ur := range uRecs {
					userMap[ur.Id] = map[string]any{
						"id":       ur.Id,
						"nickname": ur.GetString("nickname"),
						"avatar":   ur.GetString("avatar"),
						"role":     ur.GetString("role"),
						"status":   ur.GetString("status"),
						"created":  ur.GetString("created"),
					}
				}
			}
		}
	}

	associatedAccounts := make([]map[string]any, 0, len(accRows))
	for _, r := range accRows {
		uData, ok := userMap[r.UserID]
		if !ok {
			uData = map[string]any{
				"id":       r.UserID,
				"nickname": "Unknown",
				"role":     "player",
				"status":   "active",
			}
		}
		associatedAccounts = append(associatedAccounts, map[string]any{
			"user":       uData,
			"first_seen": r.FirstSeen,
			"last_seen":  r.LastSeen,
			"visits":     r.Visits,
		})
	}

	// 4. Guest session count
	var guestCount int64
	_ = e.App.DB().Select("COUNT(DISTINCT NULLIF(guest_id, ''))").From("visits").
		Where(dbx.NewExp("ip_hash = {:hash} AND (user_id IS NULL OR user_id = '')", dbx.Params{"hash": targetHash})).
		Row(&guestCount)

	// 5. Recent 50 visits (serialized with snake_case keys and enriched user profile)
	type VisitRow struct {
		ID         string `db:"id"`
		OccurredAt string `db:"occurred_at"`
		UserID     string `db:"user_id"`
		GuestID    string `db:"guest_id"`
		Device     string `db:"device"`
		Browser    string `db:"browser"`
		OS         string `db:"os"`
		EntryPath  string `db:"entry_path"`
		IsBot      bool   `db:"is_bot"`
	}
	var visitRows []VisitRow
	_ = e.App.DB().NewQuery(`
		SELECT id, occurred_at, user_id, guest_id, device, browser, os, entry_path, is_bot
		FROM visits
		WHERE ip_hash = {:hash}
		ORDER BY occurred_at DESC
		LIMIT 50
	`).Bind(dbx.Params{"hash": targetHash}).All(&visitRows)

	recentVisits := make([]map[string]any, 0, len(visitRows))
	for _, r := range visitRows {
		var userProfile any
		if r.UserID != "" {
			if u, ok := userMap[r.UserID]; ok {
				userProfile = map[string]any{
					"id":       u["id"],
					"nickname": u["nickname"],
					"avatar":   u["avatar"],
					"role":     u["role"],
				}
			}
		}
		recentVisits = append(recentVisits, map[string]any{
			"id":          r.ID,
			"occurred_at": r.OccurredAt,
			"user_id":     r.UserID,
			"guest_id":    r.GuestID,
			"device":      r.Device,
			"browser":     r.Browser,
			"os":          r.OS,
			"entry_path":  r.EntryPath,
			"is_bot":      r.IsBot,
			"user":        userProfile,
		})
	}

	resp := map[string]any{
		"ip":                  displayIP,
		"ip_hash":             targetHash,
		"can_view_raw":        canViewRawIP,
		"can_manage_bans":     canManageBans,
		"country":             geo.Country,
		"city":                geo.City,
		"is_banned":           isBanned,
		"ban_info":            nil,
		"associated_accounts": associatedAccounts,
		"guest_count":         guestCount,
		"recent_visits":       recentVisits,
	}
	if isBanned && banInfo != nil {
		resp["ban_info"] = banInfo
	}

	return e.JSON(http.StatusOK, resp)
}

// adminAnalyticsSuspiciousHandler identifies potential abuse, multies, registration bursts, and anomalies.
func adminAnalyticsSuspiciousHandler(e *core.RequestEvent) error {
	acc := AccessFrom(e)
	canViewRawIP := auth.Has(acc.Permissions, auth.PermViewRawIP)

	now := time.Now().UTC()
	twentyFourHoursAgo := now.Add(-24 * time.Hour).Format(pbDateFormat)
	oneHourAgo := now.Add(-1 * time.Hour).Format(pbDateFormat)

	// 1. One IP — Multiple Accounts (>= 3 distinct user IDs)
	type MultiAccRow struct {
		IPHash       string `db:"ip_hash"`
		IP           string `db:"ip"`
		AccountCount int64  `db:"account_count"`
		Country      string `db:"country"`
		City         string `db:"city"`
	}
	var multiAccounts []MultiAccRow
	_ = e.App.DB().NewQuery(`
		SELECT 
			ip_hash,
			MAX(ip) as ip,
			COUNT(DISTINCT user_id) as account_count,
			MAX(country) as country,
			MAX(city) as city
		FROM visits
		WHERE user_id IS NOT NULL AND user_id != ''
		GROUP BY ip_hash
		HAVING account_count >= 3
		ORDER BY account_count DESC
		LIMIT 20
	`).All(&multiAccounts)

	multiAccResults := make([]map[string]any, 0, len(multiAccounts))
	for _, m := range multiAccounts {
		dispIP := m.IP
		if !canViewRawIP {
			dispIP = maskIP(dispIP)
		}
		multiAccResults = append(multiAccResults, map[string]any{
			"ip_hash":       m.IPHash,
			"ip":            dispIP,
			"account_count": m.AccountCount,
			"country":       m.Country,
			"city":          m.City,
		})
	}

	// 2. Registration Bursts (>= 2 new accounts linked to visits from same IP in last 24h)
	type RegBurstRow struct {
		IPHash   string `db:"ip_hash"`
		IP       string `db:"ip"`
		RegCount int64  `db:"reg_count"`
		Country  string `db:"country"`
		City     string `db:"city"`
	}
	var regBursts []RegBurstRow
	_ = e.App.DB().NewQuery(`
		SELECT
			v.ip_hash,
			MAX(v.ip) as ip,
			COUNT(DISTINCT v.user_id) as reg_count,
			MAX(v.country) as country,
			MAX(v.city) as city
		FROM visits v
		INNER JOIN users u ON u.id = v.user_id
		WHERE v.user_id IS NOT NULL AND v.user_id != '' AND u.created >= {:time}
		GROUP BY v.ip_hash
		HAVING reg_count >= 2
		ORDER BY reg_count DESC
		LIMIT 20
	`).Bind(dbx.Params{"time": twentyFourHoursAgo}).All(&regBursts)

	regBurstResults := make([]map[string]any, 0, len(regBursts))
	for _, r := range regBursts {
		dispIP := r.IP
		if !canViewRawIP {
			dispIP = maskIP(dispIP)
		}
		regBurstResults = append(regBurstResults, map[string]any{
			"ip_hash":   r.IPHash,
			"ip":        dispIP,
			"reg_count": r.RegCount,
			"country":   r.Country,
			"city":      r.City,
		})
	}

	// 3. One Account — Multiple IPs in last 24h (>= 4 distinct IP hashes)
	type MultiIPRow struct {
		UserID  string `db:"user_id"`
		IPCount int64  `db:"ip_count"`
	}
	var multiIPs []MultiIPRow
	_ = e.App.DB().NewQuery(`
		SELECT 
			user_id,
			COUNT(DISTINCT ip_hash) as ip_count
		FROM visits
		WHERE user_id IS NOT NULL AND user_id != '' AND occurred_at >= {:time}
		GROUP BY user_id
		HAVING ip_count >= 4
		ORDER BY ip_count DESC
		LIMIT 20
	`).Bind(dbx.Params{"time": twentyFourHoursAgo}).All(&multiIPs)

	multiIPResults := make([]map[string]any, 0, len(multiIPs))
	if len(multiIPs) > 0 {
		uIDs := make([]string, len(multiIPs))
		for i, m := range multiIPs {
			uIDs[i] = m.UserID
		}
		usersCol, _ := e.App.FindCollectionByNameOrId(usersCollectionName)
		uRecs, _ := e.App.FindRecordsByIds(usersCol, uIDs)
		userNickMap := make(map[string]string)
		for _, ur := range uRecs {
			userNickMap[ur.Id] = ur.GetString("nickname")
		}

		for _, m := range multiIPs {
			nick := userNickMap[m.UserID]
			if nick == "" {
				nick = "Unknown"
			}
			multiIPResults = append(multiIPResults, map[string]any{
				"user_id":  m.UserID,
				"nickname": nick,
				"ip_count": m.IPCount,
			})
		}
	}

	// 4. Guest Surges (>= 15 guest sessions from single IP in 1 hour)
	type GuestSurgeRow struct {
		IPHash     string `db:"ip_hash"`
		IP         string `db:"ip"`
		GuestCount int64  `db:"guest_count"`
		Country    string `db:"country"`
	}
	var guestSurges []GuestSurgeRow
	_ = e.App.DB().NewQuery(`
		SELECT 
			ip_hash,
			MAX(ip) as ip,
			COUNT(DISTINCT NULLIF(guest_id, '')) as guest_count,
			MAX(country) as country
		FROM visits
		WHERE (user_id IS NULL OR user_id = '') AND occurred_at >= {:time} AND is_bot = 0
		GROUP BY ip_hash
		HAVING guest_count >= 15
		ORDER BY guest_count DESC
		LIMIT 20
	`).Bind(dbx.Params{"time": oneHourAgo}).All(&guestSurges)

	guestSurgeResults := make([]map[string]any, 0, len(guestSurges))
	for _, g := range guestSurges {
		dispIP := g.IP
		if !canViewRawIP {
			dispIP = maskIP(dispIP)
		}
		guestSurgeResults = append(guestSurgeResults, map[string]any{
			"ip_hash":     g.IPHash,
			"ip":          dispIP,
			"guest_count": g.GuestCount,
			"country":     g.Country,
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"multiple_accounts":   multiAccResults,
		"registration_bursts": regBurstResults,
		"multi_ip_accounts":   multiIPResults,
		"guest_surges":        guestSurgeResults,
	})
}

// adminUserIPsHandler returns the recent distinct IPs used by a specific member (Sprint 3 §5.2).
func adminUserIPsHandler(e *core.RequestEvent) error {
	userID := strings.TrimSpace(e.Request.PathValue("id"))
	if userID == "" {
		return validationError("user id is required")
	}

	acc := AccessFrom(e)
	canViewRawIP := auth.Has(acc.Permissions, auth.PermViewRawIP)

	type UserIPRow struct {
		IPHash    string `db:"ip_hash"`
		IP        string `db:"ip"`
		Country   string `db:"country"`
		City      string `db:"city"`
		FirstSeen string `db:"first_seen"`
		LastSeen  string `db:"last_seen"`
		Visits    int64  `db:"visits"`
	}

	var rows []UserIPRow
	err := e.App.DB().NewQuery(`
		SELECT
			ip_hash,
			MAX(ip) as ip,
			MAX(country) as country,
			MAX(city) as city,
			MIN(occurred_at) as first_seen,
			MAX(occurred_at) as last_seen,
			COUNT(*) as visits
		FROM visits
		WHERE user_id = {:uid}
		GROUP BY ip_hash
		ORDER BY last_seen DESC
		LIMIT 10
	`).Bind(dbx.Params{"uid": userID}).All(&rows)
	if err != nil {
		return internalError("failed to query user IPs", err)
	}

	items := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		dispIP := r.IP
		if !canViewRawIP {
			dispIP = maskIP(dispIP)
		}
		items = append(items, map[string]any{
			"ip_hash":    r.IPHash,
			"ip":         dispIP,
			"country":    r.Country,
			"city":       r.City,
			"first_seen": r.FirstSeen,
			"last_seen":  r.LastSeen,
			"visits":     r.Visits,
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"user_id": userID,
		"items":   items,
	})
}
