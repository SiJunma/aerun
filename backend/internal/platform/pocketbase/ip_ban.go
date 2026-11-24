package pocketbase

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

const ipBansCollectionName = "ip_bans"

// IPBanEntry is an in-memory cache representation of an active ban.
type IPBanEntry struct {
	ID         string
	IPOrSubnet string
	StartHex   string
	EndHex     string
	Reason     string
	BannedBy   string
	ExpiresAt  *time.Time
}

var (
	banCacheMu     sync.RWMutex
	banCacheLoaded bool
	banCacheList   []IPBanEntry
)

// IPToNormalized16 converts an IPv4 or IPv6 into a 16-byte canonical slice.
func IPToNormalized16(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	return ip.To16()
}

// IPToHex encodes an IP into a 32-character hex string representing its 16-byte canonical form.
func IPToHex(ip net.IP) string {
	b := IPToNormalized16(ip)
	if b == nil {
		return ""
	}
	return hex.EncodeToString(b)
}

// ParseIPRange parses an IP or CIDR subnet into (startHex, endHex).
func ParseIPRange(ipOrSubnet string) (string, string, error) {
	clean := strings.TrimSpace(ipOrSubnet)
	if clean == "" {
		return "", "", errors.New("empty IP or subnet")
	}

	if strings.Contains(clean, "/") {
		_, ipNet, err := net.ParseCIDR(clean)
		if err != nil {
			return "", "", fmt.Errorf("invalid CIDR subnet %q: %w", clean, err)
		}
		start := ipNet.IP.Mask(ipNet.Mask).To16()
		if start == nil {
			return "", "", fmt.Errorf("unsupported IP family in CIDR %q", clean)
		}
		end := make(net.IP, 16)
		mask := ipNet.Mask
		if len(mask) == 4 {
			// Convert IPv4 mask to IPv4-mapped IPv6 mask
			newMask := make(net.IPMask, 16)
			copy(newMask[12:], mask)
			for i := 0; i < 12; i++ {
				newMask[i] = 0xff
			}
			mask = newMask
		}
		for i := 0; i < 16; i++ {
			end[i] = start[i] | (^mask[i])
		}
		return hex.EncodeToString(start), hex.EncodeToString(end), nil
	}

	singleIP := net.ParseIP(clean)
	if singleIP == nil {
		return "", "", fmt.Errorf("invalid IP address %q", clean)
	}
	h := IPToHex(singleIP)
	return h, h, nil
}

// IsSafeListedIP returns true if the IP is a loopback or unspecified address that cannot be banned.
func IsSafeListedIP(ipStr string) bool {
	parsed := net.ParseIP(strings.TrimSpace(ipStr))
	if parsed == nil {
		return false
	}
	return parsed.IsLoopback() || parsed.IsUnspecified()
}

// IsSafeListedRange returns true if [startHex, endHex] overlaps any protected loopback/unspecified address
// (prevents CIDR catch-alls like 0.0.0.0/0, ::/0, or 127.0.0.0/8 from banning protected hosts).
func IsSafeListedRange(startHex, endHex string) bool {
	protected := []string{"127.0.0.1", "::1", "0.0.0.0", "::"}
	for _, p := range protected {
		h := IPToHex(net.ParseIP(p))
		if h != "" && startHex <= h && h <= endHex {
			return true
		}
	}
	return false
}

// InvalidateIPBanCache clears the memory cache of active bans.
func InvalidateIPBanCache() {
	banCacheMu.Lock()
	defer banCacheMu.Unlock()
	banCacheLoaded = false
	banCacheList = nil
}

// refreshBanCacheLocked loads all currently active bans into memory.
func refreshBanCacheLocked(app core.App) error {
	col, err := app.FindCollectionByNameOrId(ipBansCollectionName)
	if err != nil || col == nil {
		return nil
	}

	now := time.Now().UTC().Format(pbDateFormat)
	records, err := app.FindAllRecords(
		col,
		dbx.NewExp(
			"is_active = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at > {:now})",
			dbx.Params{"now": now},
		),
	)
	if err != nil {
		return err
	}

	list := make([]IPBanEntry, 0, len(records))
	for _, r := range records {
		var expPtr *time.Time
		if dt := r.GetDateTime("expires_at"); !dt.IsZero() {
			t := dt.Time()
			expPtr = &t
		}

		list = append(list, IPBanEntry{
			ID:         r.Id,
			IPOrSubnet: r.GetString("ip_or_subnet"),
			StartHex:   r.GetString("ip_start"),
			EndHex:     r.GetString("ip_end"),
			Reason:     r.GetString("reason"),
			BannedBy:   r.GetString("banned_by"),
			ExpiresAt:  expPtr,
		})
	}

	banCacheList = list
	banCacheLoaded = true
	return nil
}

// CheckIPBanned returns (isBanned, entry) for an IP string.
func CheckIPBanned(app core.App, ipStr string) (bool, *IPBanEntry) {
	parsed := net.ParseIP(strings.TrimSpace(ipStr))
	if parsed == nil || parsed.IsLoopback() {
		return false, nil
	}

	targetHex := IPToHex(parsed)
	if targetHex == "" {
		return false, nil
	}

	banCacheMu.RLock()
	loaded := banCacheLoaded
	list := banCacheList
	banCacheMu.RUnlock()

	if !loaded {
		banCacheMu.Lock()
		if !banCacheLoaded {
			_ = refreshBanCacheLocked(app)
		}
		list = banCacheList
		banCacheMu.Unlock()
	}

	now := time.Now().UTC()
	for _, entry := range list {
		if entry.ExpiresAt != nil && entry.ExpiresAt.Before(now) {
			continue
		}
		if entry.StartHex <= targetHex && targetHex <= entry.EndHex {
			eCopy := entry
			return true, &eCopy
		}
	}

	return false, nil
}

// CreateIPBanRequest defines the payload for creating a new IP ban.
type CreateIPBanRequest struct {
	IPOrSubnet string `json:"ip_or_subnet"`
	Reason     string `json:"reason"`
	ExpiresAt  string `json:"expires_at"` // Optional RFC3339 or empty for permanent
}

// adminCreateIPBanHandler creates an IP or subnet ban atomically with audit logging and idempotency.
func adminCreateIPBanHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	var req CreateIPBanRequest
	if err := e.BindBody(&req); err != nil {
		return validationError("Invalid request body")
	}

	req.IPOrSubnet = strings.TrimSpace(req.IPOrSubnet)
	req.Reason = strings.TrimSpace(req.Reason)
	if req.IPOrSubnet == "" {
		return validationError("IP or subnet is required")
	}
	if req.Reason == "" {
		return validationError("Reason is required")
	}
	if len([]rune(req.Reason)) > 255 {
		return validationError("Reason must be at most 255 characters")
	}

	if IsSafeListedIP(req.IPOrSubnet) {
		return validationError("Cannot ban localhost or protected safelist addresses")
	}

	startHex, endHex, err := ParseIPRange(req.IPOrSubnet)
	if err != nil {
		return validationError(err.Error())
	}
	if IsSafeListedRange(startHex, endHex) {
		return validationError("IP range overlaps protected safelist or loopback addresses")
	}

	// Chief Admin Immunity: do not allow banning chief admin's current IP
	callerIP := e.RealIP()
	callerHex := IPToHex(net.ParseIP(callerIP))
	acc := AccessFrom(e)
	if acc.Role == auth.RoleRoot && callerHex != "" {
		if startHex <= callerHex && callerHex <= endHex {
			return validationError("Cannot ban current chief administrator IP address")
		}
	}

	var expiresTime *time.Time
	if req.ExpiresAt != "" {
		parsedExp, err := time.Parse(time.RFC3339, req.ExpiresAt)
		if err != nil {
			return validationError("Invalid expires_at format; expected RFC3339")
		}
		utcExp := parsedExp.UTC()
		expiresTime = &utcExp
	}

	callerID := e.Auth.Id
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		col, err := txApp.FindCollectionByNameOrId(ipBansCollectionName)
		if err != nil || col == nil {
			return 0, nil, internalError("ip_bans collection unavailable", err)
		}

		now := time.Now().UTC()
		record := core.NewRecord(col)
		record.Set("ip_or_subnet", req.IPOrSubnet)
		record.Set("ip_start", startHex)
		record.Set("ip_end", endHex)
		record.Set("reason", req.Reason)
		record.Set("banned_by", callerID)
		record.Set("created_at", now)
		if expiresTime != nil {
			record.Set("expires_at", *expiresTime)
		}
		record.Set("is_active", true)

		if err := txApp.Save(record); err != nil {
			return 0, nil, internalError("failed to save IP ban", err)
		}

		if err := recordAuditLog(txApp, "ip_ban_created", callerID, map[string]any{
			"ban_id":       record.Id,
			"ip_or_subnet": req.IPOrSubnet,
			"reason":       req.Reason,
			"expires_at":   record.GetString("expires_at"),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"success": true,
			"ban": map[string]any{
				"id":           record.Id,
				"ip_or_subnet": req.IPOrSubnet,
				"reason":       req.Reason,
				"banned_by":    record.GetString("banned_by"),
				"created_at":   record.GetString("created_at"),
				"expires_at":   record.GetString("expires_at"),
				"is_active":    record.GetBool("is_active"),
			},
		}, nil
	})
	if err == nil {
		InvalidateIPBanCache()
	}
	return writeCommandResult(e, outcome, err)
}

// adminUnbanIPHandler deactivates an active IP ban atomically with audit logging.
func adminUnbanIPHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	id := strings.TrimSpace(e.Request.PathValue("id"))
	if id == "" {
		return validationError("Ban ID required")
	}

	callerID := e.Auth.Id
	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		record, err := txApp.FindRecordById(ipBansCollectionName, id)
		if err != nil || record == nil {
			return 0, nil, notFoundError("Ban record not found")
		}

		record.Set("is_active", false)
		if err := txApp.Save(record); err != nil {
			return 0, nil, internalError("failed to remove IP ban", err)
		}

		if err := recordAuditLog(txApp, "ip_ban_removed", callerID, map[string]any{
			"ban_id":       record.Id,
			"ip_or_subnet": record.GetString("ip_or_subnet"),
			"reason":       record.GetString("reason"),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"success": true,
		}, nil
	})
	if err == nil {
		InvalidateIPBanCache()
	}
	return writeCommandResult(e, outcome, err)
}

// adminListIPBansHandler returns a paginated list of IP bans, respecting PermViewRawIP masking.
func adminListIPBansHandler(e *core.RequestEvent) error {
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
	statusFilter := e.Request.URL.Query().Get("status") // "active" (default), "all"

	col, err := e.App.FindCollectionByNameOrId(ipBansCollectionName)
	if err != nil || col == nil {
		return internalError("ip_bans collection unavailable", err)
	}

	var exp dbx.Expression
	if statusFilter == "active" || statusFilter == "" {
		now := time.Now().UTC().Format(pbDateFormat)
		exp = dbx.NewExp(
			"is_active = 1 AND (expires_at IS NULL OR expires_at = '' OR expires_at > {:now})",
			dbx.Params{"now": now},
		)
	}

	query := e.App.RecordQuery(col).OrderBy("created_at DESC")
	if exp != nil {
		query.Where(exp)
	}

	countQuery := e.App.DB().Select("COUNT(*)").From(ipBansCollectionName)
	if exp != nil {
		countQuery.Where(exp)
	}
	var total int64
	_ = countQuery.Row(&total)

	offset := (page - 1) * limit
	query.Limit(limit).Offset(offset)

	records := []*core.Record{}
	if err := query.All(&records); err != nil {
		return internalError("failed to query ip bans", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, r := range records {
		target := r.GetString("ip_or_subnet")
		if !canViewRawIP {
			target = maskIP(target)
		}
		items = append(items, map[string]any{
			"id":           r.Id,
			"ip_or_subnet": target,
			"reason":       r.GetString("reason"),
			"banned_by":    r.GetString("banned_by"),
			"created_at":   r.GetString("created_at"),
			"expires_at":   r.GetString("expires_at"),
			"is_active":    r.GetBool("is_active"),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items": items,
		"total": total,
		"page":  page,
		"limit": limit,
	})
}

// registerIPBanAuthHook intercepts user authentication (password, OAuth2, refresh) and rejects banned IPs.
func registerIPBanAuthHook(app core.App) {
	app.OnRecordAuthRequest().BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if e.Record != nil && e.Record.Collection().Name == usersCollectionName {
			if banned, _ := CheckIPBanned(e.App, e.RealIP()); banned {
				return router.NewForbiddenError("Access denied", nil)
			}
		}
		return e.Next()
	})
}
