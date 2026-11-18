package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// F-1: registration must wake the forum-state readers, not only the staff
// inbox and the online list. The account row is written before the nudge, so
// a client that re-reads GET /api/aerun/forum-stats after the signal sees the
// newcomer as newestUser and the member count already moved.
func TestRegistrationPublishesPresenceUpdateAndStatsShowNewestUser(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	watcher := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))

	status, payload := postAerun(t, server.URL+"/api/aerun/auth/register",
		`{"email":"newest.member@example.com","password":"CorrectHorse1!","nickname":"NewestMember"}`,
		"")
	if status != http.StatusCreated {
		t.Fatalf("register: expected 201, got %d: %s", status, payload)
	}

	msg, ok := awaitSignal(t, watcher, 5*time.Second)
	if !ok {
		t.Fatal("registration did not publish a presence.update signal")
	}
	if body := signalBody(t, msg); !strings.Contains(body, realtimeSignalPresenceUpdate) {
		t.Fatalf("registration signal is not presence.update: %s", body)
	}

	var registered struct {
		ID       string `json:"id"`
		Nickname string `json:"nickname"`
	}
	if err := json.Unmarshal(payload, &registered); err != nil {
		t.Fatalf("decode register response: %v (%s)", err, payload)
	}

	stats := fetchForumStats(t, server.URL, tokens["player"])
	if stats.Stats.NewestUser == nil {
		t.Fatal("stats.newestUser is missing after registration")
	}
	if stats.Stats.NewestUser.ID != registered.ID || stats.Stats.NewestUser.Nickname != "NewestMember" {
		t.Fatalf("newestUser = %+v, want the newly registered account %s", stats.Stats.NewestUser, registered.ID)
	}

	rows, err := app.FindAllRecords(realtimeSignalsCollection, nil)
	if err != nil {
		t.Fatalf("read signals: %v", err)
	}
	found := false
	for _, row := range rows {
		if row.GetString("topic") == realtimeSignalPresenceUpdate {
			found = true
		}
	}
	if !found {
		t.Fatal("no stored presence.update signal after registration")
	}
}
