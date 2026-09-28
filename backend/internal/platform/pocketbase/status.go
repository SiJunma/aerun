package pocketbase

import (
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// buildStatusSnapshot composes the current health status and presence view into
// a single atomic read. It is used by:
//   - GET /api/aerun/status (the consolidated ping & poll endpoint)
//   - POST /api/aerun/presence/heartbeat (so beating tabs get the latest presence
//     state returned in the heartbeat response without an extra poll)
//
// The presence slice mirrors listOnlineUsersHandler: active members from memory
// (windowed to presenceTTL) and active guests from the collection (windowed to
// guestPresenceWindow). If guest presence storage is unreachable, it logs a
// warning and degrades to guests_count = 0 with a degraded flag instead of
// failing the entire status payload.
func buildStatusSnapshot(app core.App, now time.Time) (map[string]any, error) {
	activeMembers := activeMembersAt(now)

	guestsCount := 0
	guestDegraded := false
	guestList := []map[string]any{}
	if records, err := activeGuestRecords(app, now); err != nil {
		app.Logger().Warn("guest count unavailable during status snapshot", "error", err)
		guestDegraded = true
	} else {
		guestsCount = len(records)
		for _, record := range records {
			guestList = append(guestList, map[string]any{
				"id":        record.GetString("guest_id"),
				"last_seen": record.GetDateTime("last_seen").String(),
			})
		}
	}

	presence := map[string]any{
		"users":          activeMembers,
		"guests":         guestList,
		"guests_count":   guestsCount,
		"total_online":   len(activeMembers) + guestsCount,
		"window_seconds": int(guestPresenceWindow.Seconds()),
	}
	if guestDegraded {
		presence["guests_degraded"] = true
	}

	return map[string]any{
		"status":   "pass",
		"time":     now.UTC().Format(time.RFC3339),
		"presence": presence,
	}, nil
}

// statusHandler serves GET /api/aerun/status. It is public, unauthenticated and
// side-effect-free, replacing the separate polling loops for /health,
// /presence/online-users, and /presence/guests.
func statusHandler(e *core.RequestEvent) error {
	now := time.Now()
	snapshot, err := buildStatusSnapshot(e.App, now)
	if err != nil {
		return internalError("status could not be built", err)
	}
	snapshot["ok"] = true
	snapshot["request_id"] = requestIDFrom(e)
	return e.JSON(http.StatusOK, snapshot)
}
