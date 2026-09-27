package pocketbase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// The guest presence contract: a public heartbeat keyed by a client-generated
// visitor id, a public counter/list windowed to guestPresenceWindow, an explicit
// leave, and a retention prune. The tests drive the real router over HTTP (so
// every beat crosses the access resolver and the error contract) and seed rows
// directly only when they need a row of a specific age.

// seedGuest writes a guest_presence row directly, which is how these tests set
// up "this visitor was last seen at T" without waiting for the window to pass.
func seedGuest(t testing.TB, app *tests.TestApp, guestID string, lastSeen time.Time) {
	t.Helper()

	collection, err := app.FindCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		t.Fatalf("guest_presence collection missing: %v", err)
	}
	record := core.NewRecord(collection)
	record.Set("guest_id", guestID)
	record.Set("first_seen", lastSeen)
	record.Set("last_seen", lastSeen)
	if err := app.Save(record); err != nil {
		t.Fatalf("seed guest %q: %v", guestID, err)
	}
}

// findGuest returns the row for guestID, seeding nothing.
func findGuest(t testing.TB, app *tests.TestApp, guestID string) *core.Record {
	t.Helper()

	record, err := app.FindFirstRecordByFilter(guestPresenceCollectionTable, "guest_id = {:guestID}", dbx.Params{"guestID": guestID})
	if err != nil {
		t.Fatalf("guest %q not found: %v", guestID, err)
	}
	return record
}

// countGuests returns every row in the table, fresh or stale.
func countGuests(t testing.TB, app *tests.TestApp) int {
	t.Helper()

	records, err := app.FindAllRecords(guestPresenceCollectionTable)
	if err != nil {
		t.Fatalf("read guest rows: %v", err)
	}
	return len(records)
}

// postAerun posts a JSON body and returns the status code and raw payload.
func postAerun(t testing.TB, path, body, token string) (int, []byte) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	payload, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, payload
}

// getAerun fetches a path and returns the status code and raw payload.
func getAerun(t testing.TB, path string) (int, []byte) {
	t.Helper()

	res, err := http.Get(path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	payload, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, payload
}

// guestsResponse mirrors GET /presence/guests.
type guestsResponse struct {
	Count  int `json:"count"`
	Guests []struct {
		ID       string `json:"id"`
		LastSeen string `json:"last_seen"`
	} `json:"guests"`
	WindowSeconds int `json:"window_seconds"`
}

// onlineUsersResponse mirrors the guest part of GET /presence/online-users.
type onlineUsersResponse struct {
	GuestsCount int `json:"guests_count"`
	TotalOnline int `json:"total_online"`
}

// guestBeat posts one anonymous heartbeat for guestID and fails on anything but
// a 200, so the tests below read as a sequence of beats.
func guestBeat(t testing.TB, baseURL, guestID string) {
	t.Helper()

	status, payload := postAerun(t, baseURL+"/api/aerun/presence/heartbeat", fmt.Sprintf(`{"guest_id":%q}`, guestID), "")
	if status != http.StatusOK {
		t.Fatalf("heartbeat for %q: expected 200, got %d: %s", guestID, status, payload)
	}
}

func TestGuestHeartbeatCreatesOneRowAndRefreshesIt(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	// Every anonymous beat draws on one process-wide budget; start clean.
	guestLimiter.reset()
	defer guestLimiter.reset()

	const guestID = "guestabc123456"
	guestBeat(t, ts.URL, guestID)

	if got := countGuests(t, app); got != 1 {
		t.Fatalf("first heartbeat must create exactly one row, got %d", got)
	}

	created := findGuest(t, app, guestID).GetDateTime("first_seen").Time()
	if delta := time.Since(created); delta > time.Minute || delta < -time.Minute {
		t.Fatalf("first_seen must be stamped at creation time, got %s", created)
	}

	// Age the row, then beat again: the second beat must reuse it.
	aged := time.Now().Add(-10 * time.Minute).UTC().Truncate(time.Millisecond)
	record := findGuest(t, app, guestID)
	record.Set("last_seen", aged)
	if err := app.Save(record); err != nil {
		t.Fatalf("age the guest row: %v", err)
	}

	guestBeat(t, ts.URL, guestID)

	if got := countGuests(t, app); got != 1 {
		t.Fatalf("a repeated heartbeat must update, not insert: %d rows", got)
	}
	refreshed := findGuest(t, app, guestID)
	if !refreshed.GetDateTime("last_seen").Time().After(aged) {
		t.Fatalf("last_seen was not refreshed, still %s", refreshed.GetDateTime("last_seen"))
	}
	if first := refreshed.GetDateTime("first_seen").Time(); !first.Equal(created) {
		t.Fatalf("first_seen must survive a refresh: %s became %s", created, first)
	}

	// A different visitor is a different row.
	guestBeat(t, ts.URL, "guestxyz987654")
	if got := countGuests(t, app); got != 2 {
		t.Fatalf("expected one row per visitor, got %d", got)
	}
}

func TestGuestHeartbeatRejectsMalformedVisitorIDs(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	guestLimiter.reset()
	defer guestLimiter.reset()

	cases := map[string]string{
		"missing":   `{}`,
		"too short": `{"guest_id":"guest"}`,
		"too long":  fmt.Sprintf(`{"guest_id":%q}`, strings.Repeat("a", guestIDMaxLen+1)),
		"uppercase": `{"guest_id":"GuestABC12345"}`,
		"dash":      `{"guest_id":"guest-abc12345"}`,
		"space":     `{"guest_id":"guest abc12345"}`,
		"unicode":   `{"guest_id":"гость1234567"}`,
	}

	for name, body := range cases {
		status, payload := postAerun(t, ts.URL+"/api/aerun/presence/heartbeat", body, "")
		if status != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d: %s", name, status, payload)
		}

		var envelope struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			t.Fatalf("%s: unreadable error envelope: %v", name, err)
		}
		if kind, _ := envelope.Data["kind"].(string); kind != errKindValidation {
			t.Fatalf("%s: expected kind %q, got %q", name, errKindValidation, kind)
		}
	}

	// This guard is what keeps a public endpoint from being a row-insert
	// primitive for arbitrary payloads.
	if got := countGuests(t, app); got != 0 {
		t.Fatalf("rejected heartbeats must write nothing, got %d rows", got)
	}
}

func TestGuestPresenceWindowDrivesBothEndpoints(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	now := time.Now()
	seedGuest(t, app, "guestfresh00001", now.Add(-time.Minute))
	seedGuest(t, app, "gueststale00001", now.Add(-guestPresenceWindow-time.Minute))

	status, payload := getAerun(t, ts.URL+"/api/aerun/presence/guests")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, payload)
	}

	var guests guestsResponse
	if err := json.Unmarshal(payload, &guests); err != nil {
		t.Fatal(err)
	}
	if guests.Count != 1 || len(guests.Guests) != 1 {
		t.Fatalf("only the row inside the window counts, got %+v", guests)
	}
	if guests.Guests[0].ID != "guestfresh00001" {
		t.Fatalf("wrong guest reported: %+v", guests.Guests[0])
	}
	if guests.Guests[0].LastSeen == "" {
		t.Fatal("the list must carry last_seen so the client can age the row out itself")
	}
	if guests.WindowSeconds != int(guestPresenceWindow.Seconds()) {
		t.Fatalf("window_seconds must publish the server window, got %d", guests.WindowSeconds)
	}

	// The stats panel reads the counter from the sibling endpoint; both have to
	// agree or the panel and the guest list would contradict each other.
	status, payload = getAerun(t, ts.URL+"/api/aerun/presence/online-users")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, payload)
	}
	var online onlineUsersResponse
	if err := json.Unmarshal(payload, &online); err != nil {
		t.Fatal(err)
	}
	if online.GuestsCount != guests.Count {
		t.Fatalf("guests_count (%d) disagrees with the guest list (%d)", online.GuestsCount, guests.Count)
	}
	if online.TotalOnline < online.GuestsCount {
		t.Fatalf("total_online (%d) must include the guests (%d)", online.TotalOnline, online.GuestsCount)
	}
}

func TestGuestLeaveRemovesPresenceAndIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	guestLimiter.reset()
	defer guestLimiter.reset()

	const guestID = "guestleaving001"
	guestBeat(t, ts.URL, guestID)
	if got := countGuests(t, app); got != 1 {
		t.Fatalf("setup: expected one row, got %d", got)
	}

	leave := ts.URL + "/api/aerun/presence/guest/leave"
	body := fmt.Sprintf(`{"guest_id":%q}`, guestID)

	status, payload := postAerun(t, leave, body, "")
	if status != http.StatusOK {
		t.Fatalf("leave: expected 200, got %d: %s", status, payload)
	}
	if got := countGuests(t, app); got != 0 {
		t.Fatalf("leave must delete the row, %d rows left", got)
	}

	// sendBeacon fires on pagehide and cannot know whether the row still
	// exists, so a second leave must be a no-op rather than an error.
	status, payload = postAerun(t, leave, body, "")
	if status != http.StatusOK {
		t.Fatalf("repeated leave: expected 200, got %d: %s", status, payload)
	}

	status, payload = postAerun(t, leave, `{"guest_id":"nope"}`, "")
	if status != http.StatusBadRequest {
		t.Fatalf("leave must validate the id, got %d: %s", status, payload)
	}
}

func TestGuestHeartbeatFromAMemberWritesNoGuestRow(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	guestLimiter.reset()
	defer guestLimiter.reset()

	// A signed-in browser still carrying a stale guest id must be counted as a
	// member only: the heartbeat switches on the resolved auth record.
	status, payload := postAerun(t, ts.URL+"/api/aerun/presence/heartbeat", `{"guest_id":"guestloggedin01"}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("member heartbeat: expected 200, got %d: %s", status, payload)
	}
	if got := countGuests(t, app); got != 0 {
		t.Fatalf("an authenticated heartbeat must not create a guest row, got %d", got)
	}

	status, payload = getAerun(t, ts.URL+"/api/aerun/presence/online-users")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, payload)
	}
	var online struct {
		Users []struct {
			ID string `json:"id"`
		} `json:"users"`
		GuestsCount int `json:"guests_count"`
	}
	if err := json.Unmarshal(payload, &online); err != nil {
		t.Fatal(err)
	}

	found := false
	for _, user := range online.Users {
		if user.ID == fixPlayerID {
			found = true
		}
	}
	if !found {
		t.Fatalf("the member heartbeat must register the member, got %+v", online.Users)
	}
	if online.GuestsCount != 0 {
		t.Fatalf("expected no guests, got %d", online.GuestsCount)
	}
}

func TestGuestPresencePruneKeepsEverythingInsideRetention(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	now := time.Now()
	seedGuest(t, app, "guestcurrent0001", now.Add(-time.Minute))
	// Outside the online window but well inside the retention: it must stay,
	// because the counter's window and the table's retention are not the same
	// thing and conflating them would delete data a later feature may want.
	seedGuest(t, app, "guestretained001", now.Add(-guestPresenceWindow-time.Minute))
	seedGuest(t, app, "guestexpired0001", now.Add(-guestPresenceRetention-time.Minute))

	pruned, err := pruneGuestPresence(app, now)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if pruned != 1 {
		t.Fatalf("expected exactly one row past retention, pruned %d", pruned)
	}
	if got := countGuests(t, app); got != 2 {
		t.Fatalf("expected two surviving rows, got %d", got)
	}

	findGuest(t, app, "guestcurrent0001")
	findGuest(t, app, "guestretained001")
	if _, err := app.FindFirstRecordByFilter(guestPresenceCollectionTable, "guest_id = {:guestID}", dbx.Params{"guestID": "guestexpired0001"}); err == nil {
		t.Fatal("the row past retention survived the prune")
	}
}

func TestGuestPresencePruneIsRegisteredOnTheCron(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Binding OnServe more than once (which the tests do) must not duplicate
	// the job: a duplicated prune would just run the same delete twice.
	for i := 0; i < 2; i++ {
		if err := registerGuestPresenceCron(app); err != nil {
			t.Fatalf("register prune job: %v", err)
		}
	}

	matches := 0
	for _, job := range app.Cron().Jobs() {
		if job.Id() == guestPresencePruneJobID {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("expected exactly one prune job, found %d", matches)
	}
}

func TestGuestThrottleBudgetIsPerAddressAndPerWindow(t *testing.T) {
	throttle := newGuestThrottle(2, time.Minute)
	start := time.Now()

	if !throttle.allow("10.0.0.1", start) || !throttle.allow("10.0.0.1", start) {
		t.Fatal("the budget must allow exactly `limit` beats inside a window")
	}
	if throttle.allow("10.0.0.1", start.Add(time.Second)) {
		t.Fatal("the beat after the budget must be refused")
	}
	if !throttle.allow("10.0.0.2", start.Add(time.Second)) {
		t.Fatal("a different address has its own budget")
	}
	if !throttle.allow("10.0.0.1", start.Add(time.Minute)) {
		t.Fatal("the next window must restore the budget")
	}
	throttle.reset()
	if !throttle.allow("10.0.0.1", start.Add(2*time.Second)) {
		t.Fatal("reset must clear every bucket")
	}
}

func TestGuestHeartbeatIsRateLimitedOnceTheBudgetIsSpent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	guestLimiter.reset()
	defer guestLimiter.reset()

	const body = `{"guest_id":"guestflooding01"}`
	for i := 0; i < guestHeartbeatsPerMinute; i++ {
		status, payload := postAerun(t, ts.URL+"/api/aerun/presence/heartbeat", body, "")
		if status != http.StatusOK {
			t.Fatalf("beat %d/%d: expected 200, got %d: %s", i+1, guestHeartbeatsPerMinute, status, payload)
		}
	}

	status, payload := postAerun(t, ts.URL+"/api/aerun/presence/heartbeat", body, "")
	if status != http.StatusTooManyRequests {
		t.Fatalf("expected 429 once the budget is spent, got %d: %s", status, payload)
	}

	var envelope struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if kind, _ := envelope.Data["kind"].(string); kind != errKindRateLimited {
		t.Fatalf("expected kind %q, got %q", errKindRateLimited, kind)
	}
	if retryable, _ := envelope.Data["retryable"].(bool); !retryable {
		t.Fatal("a rate limited request must be flagged retryable")
	}
}
