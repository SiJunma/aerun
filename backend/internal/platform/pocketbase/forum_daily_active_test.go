package pocketbase

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
)

// The "Visited today" row of the stats panel.
//
// It is a DIFFERENT clock from the "Online now" row directly above it, and for
// a long time both read the same array: the client exported
// `subscribeToDailyActiveUsers` as a one-line alias of the online subscription,
// so the panel restated the connected-now members under a second label. Two
// consequences, and the second is the one that lies:
//
//   - the two rows could never disagree, so the second told you nothing; and
//   - a member who visited earlier and had already left was reported as NOT
//     active today, which is the opposite of what the row claims.
//
// Presence cannot answer a question about a day at all — the in-process map is
// windowed to presenceTTL and is empty after a restart — so this list is served
// from the durable users.last_seen column instead.

// setLastSeen writes a member's durable visit clock directly, so a test can
// place an account at an exact age without waiting a day for it.
func seedMemberLastSeen(t testing.TB, app *tests.TestApp, id string, at time.Time) {
	t.Helper()

	record, err := app.FindRecordById(usersCollectionName, id)
	if err != nil {
		t.Fatalf("read user %s: %v", id, err)
	}
	record.Set(userLastSeenField, at.UTC())
	if err := app.Save(record); err != nil {
		t.Fatalf("set last_seen for %s: %v", id, err)
	}
}

// dailyStatsResponse mirrors the two daily keys inside GET /forum-stats.
type dailyStatsResponse struct {
	Stats struct {
		DailyActiveUsers []struct {
			ID       string `json:"id"`
			Nickname string `json:"nickname"`
			// The key the panel colours by. It was `role_id` here until the
			// stats handler stopped emitting it: the Go test struct never
			// looked at the value, so the rename had no witness and the
			// admin/mod colour silently vanished from the frontend.
			Role string `json:"role"`
		} `json:"dailyActiveUsers"`
		// newestUser is asserted too, for the same reason: the domain fixture
		// list can make a staff account the newest one, and the frontend
		// colours it off this very key.
		NewestUser *struct {
			ID       string `json:"id"`
			Nickname string `json:"nickname"`
			Role     string `json:"role"`
		} `json:"newestUser"`
		DailyActiveUserCount int `json:"dailyActiveUserCount"`
	} `json:"stats"`
}

func fetchForumStats(t testing.TB, baseURL, token string) dailyStatsResponse {
	t.Helper()

	status, payload := getAerunAuthed(t, baseURL+"/api/aerun/forum-stats", token)
	if status != http.StatusOK {
		t.Fatalf("forum-stats: expected 200, got %d: %s", status, payload)
	}
	var out dailyStatsResponse
	if err := json.Unmarshal(payload, &out); err != nil {
		t.Fatalf("decode forum-stats: %v (%s)", err, payload)
	}
	return out
}

func TestDailyActiveCountsVisitsInsideTheDayWindow(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)

	// One member seen two hours ago, one seen three days ago.
	seedMemberLastSeen(t, app, fixPlayerID, time.Now().Add(-2*time.Hour))
	seedMemberLastSeen(t, app, fixModeratorID, time.Now().Add(-72*time.Hour))

	stats := fetchForumStats(t, server.URL, tokens["player"])

	names := map[string]bool{}
	for _, entry := range stats.Stats.DailyActiveUsers {
		names[entry.Nickname] = true
	}
	if !names["PlayerOne"] {
		t.Error("a member seen 2 hours ago must appear in the daily list")
	}
	if names["ModOne"] {
		t.Error("a member last seen 3 days ago must NOT appear in a 24-hour list — the window " +
			"is the entire point of this row")
	}
	if got := stats.Stats.DailyActiveUserCount; got != 1 {
		t.Errorf("dailyActiveUserCount = %d, want 1 (only the member seen inside the window)", got)
	}
}

// TestDailyActiveCarriesRole is the staff-colour contract for the row.
//
// The name in "Visited today" is coloured by `role` on the frontend (admin /
// root = red, moderator = green) so a staff member is recognisable at a
// glance. The handler once emitted `role_id` instead, the frontend read
// `.role`, got `undefined`, and every name silently fell back to the default
// colour -- while this test kept passing because its struct mirrored the
// wrong key and nobody asserted the value.
//
// The proof has to live on the wire shape, not in a comment: unmarshal the
// actual response, look the moderator (and root) up by id and require the
// `role` field to be exactly what the fixture set.
func TestDailyActiveCarriesRole(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)

	// One ordinary member and both staff roles inside the window, so every
	// branch of the frontend's colour ternary is exercised.
	seedMemberLastSeen(t, app, fixPlayerID, time.Now().Add(-2*time.Hour))
	seedMemberLastSeen(t, app, fixModeratorID, time.Now().Add(-time.Hour))
	seedMemberLastSeen(t, app, fixRootID, time.Now().Add(-3*time.Hour))

	stats := fetchForumStats(t, server.URL, tokens["player"])

	roles := map[string]string{}
	for _, entry := range stats.Stats.DailyActiveUsers {
		roles[entry.ID] = entry.Role
	}

	// The colour contract the panel depends on. `role` is absent under the
	// old `role_id` key, so an empty match here is a failure, not a detail.
	for id, want := range map[string]string{
		fixPlayerID:    "player",
		fixModeratorID: "moderator",
		fixRootID:      "root",
	} {
		if got := roles[id]; got != want {
			t.Errorf("dailyActiveUsers[%s].role = %q, want %q — "+
				"ForumStats colours the name off `role`; a missing or wrong "+
				"key paints a staff member in the default colour and nothing "+
				"else fails", id, got, want)
		}
	}

	// newestUser is the same contract on the "latest registered" line.
	// The fixtures register newest-first in the order player, pending,
	// banned, moderator, root, spectator, so `spectator` is newest here --
	// the assertion is that whatever account it is, its role arrives under
	// `role`, not under `role_id`.
	if got := stats.Stats.NewestUser; got == nil {
		t.Fatal("stats.newestUser is missing; ForumStats guards on it and the " +
			"latest-registered line never renders")
	} else if got.Role == "" {
		t.Errorf("newestUser.role is empty for %s — the same broken key as the "+
			"daily row would paint the latest registered member in the "+
			"default colour", got.ID)
	}
}

// TestDailyActiveSurvivesDeparture is why this row cannot come from presence.
// A member who signs out is gone from the online list within the same second —
// that is the whole point of /presence/leave — but they HAVE visited today, and
// the members table renders exactly that fact.
func TestDailyActiveSurvivesDeparture(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, server.URL, tokens["player"])

	status, payload := postAerun(t, server.URL+"/api/aerun/presence/leave", `{}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("leave: got %d, want 200 (%s)", status, payload)
	}
	if onlineMemberIDs(t, server.URL)[fixPlayerID] {
		t.Fatal("precondition: the member must be gone from the online list after leaving")
	}

	stats := fetchForumStats(t, server.URL, tokens["player"])
	if stats.Stats.DailyActiveUserCount < 1 {
		t.Error("a member who signed out a moment ago HAS visited today and must remain in the " +
			"daily list; dropping them makes the row disagree with the members table")
	}
}

// TestDailyActiveIncludesEveryAccountThatWasSeen pins the absence of a status
// filter. The row answers "who has been seen in the last day", and a ban or an
// unapproved registration changes what an account may DO — not whether it was
// seen. The member COUNT in the same payload agrees, so filtering here made the
// two rows of the panel disagree with each other and with the members table.
//
// This subtest previously demanded the opposite and was named
// TestDailyActiveExcludesNonMembers.
func TestDailyActiveIncludesEveryAccountThatWasSeen(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)

	// Fresh activity for every account, whatever its status.
	seedMemberLastSeen(t, app, fixPlayerID, time.Now().Add(-time.Hour))
	seedMemberLastSeen(t, app, fixPendingID, time.Now().Add(-time.Hour))
	seedMemberLastSeen(t, app, fixBannedID, time.Now().Add(-time.Hour))
	// One outside the window, to keep the window itself honest.
	seedMemberLastSeen(t, app, fixModeratorID, time.Now().Add(-72*time.Hour))

	stats := fetchForumStats(t, server.URL, tokens["player"])

	ids := map[string]bool{}
	for _, entry := range stats.Stats.DailyActiveUsers {
		ids[entry.ID] = true
	}
	for _, tc := range []struct {
		id   string
		name string
	}{
		{fixPlayerID, "an active account seen an hour ago"},
		{fixPendingID, "an unapproved account seen an hour ago — it is still an account"},
		{fixBannedID, "a banned account seen an hour ago — the ban limits actions, not existence"},
	} {
		if !ids[tc.id] {
			t.Errorf("%s must be listed in the daily-active row", tc.name)
		}
	}
	if ids[fixModeratorID] {
		t.Error("an account last seen 3 days ago must not be listed — the window still applies")
	}
	if got, want := stats.Stats.DailyActiveUserCount, 3; got != want {
		t.Errorf("dailyActiveUserCount = %d, want %d (every account seen inside the window, status included)", got, want)
	}
}
