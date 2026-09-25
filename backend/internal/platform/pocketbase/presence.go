package pocketbase

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

type userPresence struct {
	UserID    string    `json:"id"`
	Nickname  string    `json:"nickname"`
	AvatarURL string    `json:"avatar_url"`
	Role      string    `json:"role"`
	LastSeen  time.Time `json:"last_seen"`
}

var (
	presenceMu    sync.RWMutex
	onlineMembers = make(map[string]userPresence)
	onlineGuests  = make(map[string]time.Time)
	presenceTTL   = 75 * time.Second
)

type heartbeatForm struct {
	GuestID string `json:"guest_id"`
}

func heartbeatHandler(e *core.RequestEvent) error {
	var form heartbeatForm
	if e.Request.Body != nil {
		_ = json.NewDecoder(e.Request.Body).Decode(&form)
	}

	presenceMu.Lock()
	defer presenceMu.Unlock()

	now := time.Now()

	if e.Auth != nil {
		onlineMembers[e.Auth.Id] = userPresence{
			UserID:    e.Auth.Id,
			Nickname:  e.Auth.GetString("nickname"),
			AvatarURL: e.Auth.GetString("avatar_url"),
			Role:      e.Auth.GetString("role"),
			LastSeen:  now,
		}
	} else if form.GuestID != "" {
		onlineGuests[form.GuestID] = now
	}

	return e.JSON(http.StatusOK, map[string]any{
		"ok":         true,
		"request_id": requestIDFrom(e),
	})
}

func listOnlineUsersHandler(e *core.RequestEvent) error {
	presenceMu.Lock()
	defer presenceMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-presenceTTL)

	// Clean expired and collect active members
	activeMembers := []map[string]any{}
	for id, p := range onlineMembers {
		if p.LastSeen.Before(cutoff) {
			delete(onlineMembers, id)
		} else {
			activeMembers = append(activeMembers, map[string]any{
				"id":         p.UserID,
				"nickname":   p.Nickname,
				"avatar_url": p.AvatarURL,
				"role":       p.Role,
			})
		}
	}

	// Clean expired guests
	guestsCount := 0
	for gid, lastSeen := range onlineGuests {
		if lastSeen.Before(cutoff) {
			delete(onlineGuests, gid)
		} else {
			guestsCount++
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"users":        activeMembers,
		"guests_count": guestsCount,
		"total_online": len(activeMembers) + guestsCount,
		"request_id":   requestIDFrom(e),
	})
}
