package pocketbase

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const (
	visitsCollectionName      = "visits"
	topicVisitsCollectionName = "topic_visits"
	sessionTTL                = 30 * time.Minute
	saltFallback              = "aerun-telemetry-server-salt-2026"
	pbDateFormat              = "2006-01-02 15:04:05.000Z"
)

type sessionTouch struct {
	lastSeen time.Time
	userID   string
}

var (
	sessionMu          sync.RWMutex
	sessionTouches     = make(map[string]sessionTouch)
	topicVisitsMu      sync.RWMutex
	topicVisitsTouches = make(map[string]time.Time)
)

func ipHashSalt() string {
	if s := strings.TrimSpace(os.Getenv("AERUN_IP_HASH_SALT")); s != "" {
		return s
	}
	if s := strings.TrimSpace(os.Getenv("AERUN_ENCRYPTION_KEY")); s != "" {
		return s
	}
	return saltFallback
}

// hashIP computes a salted HMAC-SHA256 hex digest of an IP string for privacy and indexing.
func hashIP(ip string) string {
	mac := hmac.New(sha256.New, []byte(ipHashSalt()))
	mac.Write([]byte(strings.TrimSpace(ip)))
	return hex.EncodeToString(mac.Sum(nil))
}

// TelemetryVisitRequest represents the incoming JSON payload for recording a visit.
type TelemetryVisitRequest struct {
	SessionID string `json:"session_id"`
	GuestID   string `json:"guest_id"`
	EntryPath string `json:"entry_path"`
	Referrer  string `json:"referrer"`
}

// telemetryVisitHandler handles POST /api/aerun/telemetry/visit.
// It deduplicates multiple touches within a 30-minute session window, and upgrades
// a guest visit row when the user signs in mid-session.
func telemetryVisitHandler(e *core.RequestEvent) error {
	var req TelemetryVisitRequest
	if err := e.BindBody(&req); err != nil {
		return validationError("Invalid request body")
	}

	req.SessionID = strings.TrimSpace(req.SessionID)
	if req.SessionID == "" {
		return validationError("session_id is required")
	}
	if len(req.SessionID) > 64 {
		req.SessionID = req.SessionID[:64]
	}

	// Determine user or guest identity first so mid-session login upgrade works.
	var userID string
	var guestID string
	if e.Auth != nil && e.Auth.Collection().Name == usersCollectionName {
		userID = e.Auth.Id
	} else {
		// Prefer cryptographically verified guest principal cookie
		principalID := guestPrincipalIDFromRequest(e)
		if principalID != "" {
			guestID = principalID
		} else {
			guestID = strings.TrimSpace(req.GuestID)
		}
		if len(guestID) > 64 {
			guestID = guestID[:64]
		}
	}

	now := time.Now().UTC()
	cacheKey := req.SessionID
	if userID != "" {
		cacheKey = req.SessionID + ":u:" + userID
	}

	// Check in-memory 30m session cache
	sessionMu.Lock()
	// First check whether this browser session was opened as a guest earlier in the same 30m window.
	if userID != "" {
		if guestTouch, hasGuest := sessionTouches[req.SessionID]; hasGuest && guestTouch.userID == "" && now.Sub(guestTouch.lastSeen) <= sessionTTL {
			sessionTouches[req.SessionID] = sessionTouch{lastSeen: now, userID: userID}
			sessionTouches[cacheKey] = sessionTouch{lastSeen: now, userID: userID}
			sessionMu.Unlock()

			// Attach authenticated user_id to the active guest visit row so login telemetry stays 1 row = 1 visit.
			_, _ = e.App.DB().NewQuery(
				"UPDATE visits SET user_id = {:uid} WHERE session_id = {:sid} AND (user_id IS NULL OR user_id = '')",
			).Bind(dbx.Params{"uid": userID, "sid": req.SessionID}).Execute()
			return e.JSON(http.StatusOK, map[string]any{"status": "upgraded"})
		}
	}

	if existing, exists := sessionTouches[cacheKey]; exists && now.Sub(existing.lastSeen) <= sessionTTL {
		sessionTouches[cacheKey] = sessionTouch{lastSeen: now, userID: userID}
		sessionMu.Unlock()
		return e.JSON(http.StatusOK, map[string]any{"status": "touched"})
	}
	sessionTouches[cacheKey] = sessionTouch{lastSeen: now, userID: userID}

	// Housekeeping if map grows too large
	if len(sessionTouches) > 10000 {
		for k, v := range sessionTouches {
			if now.Sub(v.lastSeen) > sessionTTL {
				delete(sessionTouches, k)
			}
		}
	}
	sessionMu.Unlock()

	rawIP := e.RealIP()
	ipHash := hashIP(rawIP)
	country, city := ResolveLocation(rawIP)
	uaInfo := ParseUserAgent(e.Request.UserAgent())

	entryPath := strings.TrimSpace(req.EntryPath)
	if entryPath == "" {
		entryPath = "/"
	}
	if len(entryPath) > 255 {
		entryPath = entryPath[:255]
	}

	referrer := strings.TrimSpace(req.Referrer)
	if len(referrer) > 255 {
		referrer = referrer[:255]
	}

	col, err := e.App.FindCollectionByNameOrId(visitsCollectionName)
	if err != nil || col == nil {
		return internalError("visits collection unavailable", err)
	}

	record := core.NewRecord(col)
	record.Set("occurred_at", now)
	if userID != "" {
		record.Set("user_id", userID)
	}
	if guestID != "" {
		record.Set("guest_id", guestID)
	}
	record.Set("session_id", req.SessionID)
	record.Set("ip", rawIP)
	record.Set("ip_hash", ipHash)
	record.Set("country", country)
	record.Set("city", city)
	record.Set("device", uaInfo.Device)
	record.Set("browser", uaInfo.Browser)
	record.Set("os", uaInfo.OS)
	record.Set("entry_path", entryPath)
	if referrer != "" {
		record.Set("referrer", referrer)
	}
	record.Set("is_bot", uaInfo.IsBot)

	if err := e.App.Save(record); err != nil {
		e.App.Logger().Warn("Failed to persist visit record", "error", err)
	}

	return e.JSON(http.StatusOK, map[string]any{"status": "recorded"})
}

// recordTopicVisit records a topic visit with 30m in-memory session deduplication.
func recordTopicVisit(app core.App, sessionID, topicID, userID, guestID string) {
	if topicID == "" || sessionID == "" {
		return
	}

	key := sessionID + ":" + topicID
	now := time.Now().UTC()

	topicVisitsMu.Lock()
	lastSeen, exists := topicVisitsTouches[key]
	if exists && now.Sub(lastSeen) <= sessionTTL {
		topicVisitsTouches[key] = now
		topicVisitsMu.Unlock()
		return
	}
	topicVisitsTouches[key] = now

	if len(topicVisitsTouches) > 10000 {
		for k, v := range topicVisitsTouches {
			if now.Sub(v) > sessionTTL {
				delete(topicVisitsTouches, k)
			}
		}
	}
	topicVisitsMu.Unlock()

	col, err := app.FindCollectionByNameOrId(topicVisitsCollectionName)
	if err != nil || col == nil {
		return
	}

	record := core.NewRecord(col)
	record.Set("topic_id", topicID)
	record.Set("occurred_at", now)
	if userID != "" {
		record.Set("user_id", userID)
	}
	if guestID != "" {
		record.Set("guest_id", guestID)
	}
	record.Set("session_id", sessionID)

	if err := app.Save(record); err != nil {
		app.Logger().Warn("Failed to persist topic visit", "topic_id", topicID, "error", err)
	}
}
