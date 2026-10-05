package pocketbase

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// The durable member last-seen contract.
//
// The members table's LAST SEEN column used to depend on exactly one source:
// the in-process presence map, which drops a member presenceTTL (75s) after
// their last heartbeat and is empty entirely after a restart. The column
// therefore rendered "..." for every member who was not connected at that
// instant. These tests pin the properties that make it non-empty instead.

// getAerunAuthed is getAerun with an Authorization header, needed for the
// staff-only DTO.
func getAerunAuthed(t testing.TB, path, token string) (int, []byte) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, path, nil)
	if err != nil {
		t.Fatal(err)
	}
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

// memberBeat posts one authenticated heartbeat.
func memberBeat(t testing.TB, baseURL, token string) {
	t.Helper()

	status, payload := postAerun(t, baseURL+"/api/aerun/presence/heartbeat", `{}`, token)
	if status != http.StatusOK {
		t.Fatalf("member heartbeat: expected 200, got %d: %s", status, payload)
	}
}

func storedLastSeen(t testing.TB, app *tests.TestApp, userID string) time.Time {
	t.Helper()

	record, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil {
		t.Fatalf("read user %s: %v", userID, err)
	}
	return record.GetDateTime(userLastSeenField).Time()
}

// staffUserItem is one row of GET /api/aerun/admin/users.
type staffUserItem struct {
	ID       string `json:"id"`
	Created  string `json:"created"`
	LastSeen string `json:"last_seen"`
}

func fetchStaffUser(t testing.TB, baseURL, token, userID string) staffUserItem {
	t.Helper()

	status, payload := getAerunAuthed(t, baseURL+"/api/aerun/admin/users?perPage=30", token)
	if status != http.StatusOK {
		t.Fatalf("admin users: expected 200, got %d: %s", status, payload)
	}
	var list struct {
		Items []staffUserItem `json:"items"`
	}
	if err := json.Unmarshal(payload, &list); err != nil {
		t.Fatalf("decode admin users: %v (%s)", err, payload)
	}
	for _, item := range list.Items {
		if item.ID == userID {
			return item
		}
	}
	t.Fatalf("account %s missing from the staff list: %s", userID, payload)
	return staffUserItem{}
}

// TestMemberHeartbeatPersistsLastSeen is the core regression: a beat must leave
// a durable trace, not only an in-memory one.
func TestMemberHeartbeatPersistsLastSeen(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, ts.URL, tokens["player"])

	seen := storedLastSeen(t, app, fixPlayerID)
	if seen.IsZero() {
		t.Fatal("a heartbeat must persist users.last_seen; it stayed empty")
	}
	if delta := time.Since(seen); delta > time.Minute || delta < -time.Minute {
		t.Fatalf("last_seen must be stamped at beat time, got %s", seen)
	}
}

// TestMemberHeartbeatThrottlesLastSeenWrites guards the write amplification.
//
// The browser beats every 30s. Without the throttle this is 120 row updates per
// member per hour, each moving the `updated` autodate and firing a realtime
// event. The throttle must still let a session's FIRST beat through, because
// that is what stops "last seen" from predating the visit that produced it.
func TestMemberHeartbeatThrottlesLastSeenWrites(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, ts.URL, tokens["player"])
	first := storedLastSeen(t, app, fixPlayerID)
	if first.IsZero() {
		t.Fatal("the first beat of a session must always write")
	}

	// A second beat inside the interval must not move the column.
	memberBeat(t, ts.URL, tokens["player"])
	if second := storedLastSeen(t, app, fixPlayerID); !second.Equal(first) {
		t.Fatalf("a beat inside %s must be throttled, but last_seen moved %s -> %s",
			memberLastSeenWriteInterval, first, second)
	}

	// Once the stored value ages past the interval the next beat writes again,
	// which is what keeps an offline member's value fresh at the moment they
	// drop off.
	record, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	aged := time.Now().Add(-memberLastSeenWriteInterval - time.Minute).UTC()
	record.Set(userLastSeenField, aged)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	memberBeat(t, ts.URL, tokens["player"])
	if third := storedLastSeen(t, app, fixPlayerID); !third.After(aged) {
		t.Fatalf("a beat after the interval must write, last_seen is still %s", third)
	}
}

// TestOnlineMembersCarryTheirRealBeatTime pins the fix for the other half of
// the same column: the online list used to omit last_seen entirely, and the
// client substituted Date.now() for the gap, so every connected member read as
// "seen this exact second" no matter when they actually beat.
func TestOnlineMembersCarryTheirRealBeatTime(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	// Seed the map directly with a known beat time, so the assertion is about
	// the value the endpoint publishes and not about the wall clock. It has to
	// sit INSIDE presenceTTL, or the member is pruned before it is read — and
	// 30s back is comfortably distinguishable from "now", which is the whole
	// point: the old payload made every member look like they had just been
	// seen.
	beatAt := time.Now().Add(-30 * time.Second).UTC().Truncate(time.Second)
	presenceMu.Lock()
	onlineMembers[fixPlayerID] = userPresence{
		UserID:   fixPlayerID,
		Nickname: "PlayerOne",
		Role:     "player",
		LastSeen: beatAt,
	}
	presenceMu.Unlock()
	defer func() {
		presenceMu.Lock()
		delete(onlineMembers, fixPlayerID)
		presenceMu.Unlock()
	}()

	status, payload := getAerun(t, ts.URL+"/api/aerun/status")
	if status != http.StatusOK {
		t.Fatalf("status: expected 200, got %d: %s", status, payload)
	}

	var snapshot struct {
		Presence struct {
			Users []struct {
				ID       string `json:"id"`
				LastSeen string `json:"last_seen"`
			} `json:"users"`
		} `json:"presence"`
	}
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		t.Fatalf("decode status: %v (%s)", err, payload)
	}

	for _, u := range snapshot.Presence.Users {
		if u.ID != fixPlayerID {
			continue
		}
		if u.LastSeen == "" {
			t.Fatal("an online member must carry its real last_seen; the field was empty, " +
				"which is what made the client fabricate Date.now()")
		}
		// The online list is the one place that emits strict RFC 3339. The DTO
		// paths keep PocketBase's own layout (a space where ISO 8601 wants a
		// "T"), which is why the frontend normalises it; both are asserted here
		// so a future change to either cannot pass unnoticed.
		published, err := time.Parse(time.RFC3339, u.LastSeen)
		if err != nil {
			t.Fatalf("the online list must emit RFC 3339 so every browser can parse it, got %q: %v", u.LastSeen, err)
		}
		if !published.Equal(beatAt) {
			t.Fatalf("last_seen must be the time of the last beat (%s), got %s", beatAt, published)
		}
		return
	}
	t.Fatal("the beating member must appear in the online list")
}

// TestAdminUserListLastSeenIsNeverEmpty is the never-empty contract, asserted
// where the value is consumed. A row whose column is empty must still report a
// usable timestamp, and it must be the registration date — a real activity
// time, never a fabricated one.
func TestAdminUserListLastSeenIsNeverEmpty(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	// Blank the column the way a restore from a pre-migration backup would.
	record, err := app.FindRecordById(usersCollectionName, fixPendingID)
	if err != nil {
		t.Fatal(err)
	}
	record.Set(userLastSeenField, "")
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	item := fetchStaffUser(t, ts.URL, tokens["root"], fixPendingID)
	if item.LastSeen == "" || strings.HasPrefix(item.LastSeen, "0001-01-01") {
		t.Fatalf("last_seen must never be empty; account %s got %q", item.ID, item.LastSeen)
	}
	// It must be exactly the registration date, not "now": the fallback may
	// understate recency but must never invent a visit.
	if item.LastSeen != item.Created {
		t.Fatalf("an empty last_seen must fall back to created (%s), got %s", item.Created, item.LastSeen)
	}
	// The DTO serialises a date through types.DateTime, whose layout uses a
	// space where ISO 8601 wants a "T". That is exactly why the frontend
	// normalises it before handing the value to `new Date()`.
	if _, err := types.ParseDateTime(item.LastSeen); err != nil {
		t.Fatalf("last_seen must be a parseable PocketBase date, got %q: %v", item.LastSeen, err)
	}
}

// TestAdminUserListReportsThePersistedLastSeen ties the two halves together:
// what the heartbeat persisted is what the members table renders.
func TestAdminUserListReportsThePersistedLastSeen(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, ts.URL, tokens["player"])

	seen := storedLastSeen(t, app, fixPlayerID)
	if seen.IsZero() {
		t.Fatal("precondition: the beat must have persisted a timestamp")
	}

	item := fetchStaffUser(t, ts.URL, tokens["root"], fixPlayerID)
	if item.LastSeen == "" {
		t.Fatal("the DTO must report a timestamp for a member who has been active")
	}
	published, err := types.ParseDateTime(item.LastSeen)
	if err != nil {
		t.Fatalf("unparseable last_seen %q: %v", item.LastSeen, err)
	}
	if published.Time().Before(seen.Truncate(time.Second)) {
		t.Fatalf("the DTO reported %s, which predates the persisted %s", published, seen)
	}
}

// The member presence departure contract.
//
// A member could only stop beating, never leave: there was no route that
// removed an account from the online map, so a signed-out member stayed in
// "Online now" for the whole presenceTTL (75s). Worse, the client "fixed" this
// by sending a final HEARTBEAT on logout — which re-registers the very account
// it was trying to remove, extending the window to a full TTL from the moment
// of sign-out. Guests never had this problem because /presence/guest/leave
// removes the row. These tests pin the member counterpart.

// onlineMemberIDs reads the member half of GET /api/aerun/status.
func onlineMemberIDs(t testing.TB, baseURL string) map[string]bool {
	t.Helper()

	status, payload := getAerun(t, baseURL+"/api/aerun/status")
	if status != http.StatusOK {
		t.Fatalf("status: expected 200, got %d: %s", status, payload)
	}
	var snapshot struct {
		Presence struct {
			Users []struct {
				ID string `json:"id"`
			} `json:"users"`
		} `json:"presence"`
	}
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		t.Fatalf("decode status: %v (%s)", err, payload)
	}

	ids := make(map[string]bool, len(snapshot.Presence.Users))
	for _, u := range snapshot.Presence.Users {
		ids[u.ID] = true
	}
	return ids
}

// TestMemberLeaveRemovesThemFromTheOnlineList is the regression: signing out
// must take the account out of presence immediately, not one TTL later.
func TestMemberLeaveRemovesThemFromTheOnlineList(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, ts.URL, tokens["player"])

	if !onlineMemberIDs(t, ts.URL)[fixPlayerID] {
		t.Fatal("precondition: a beating member must appear in the online list")
	}

	status, payload := postAerun(t, ts.URL+"/api/aerun/presence/leave", `{}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("leave: expected 200, got %d: %s", status, payload)
	}

	if onlineMemberIDs(t, ts.URL)[fixPlayerID] {
		t.Fatal("a member who signed out is still counted as online — the leave route must " +
			"delete the presence row, not refresh it")
	}
}

// TestMemberLeaveStampsLastSeenUnthrottled pins the durable half.
//
// The heartbeat writes users.last_seen at most once per memberLastSeenWriteInterval
// (5 minutes), which is right for a 30s signal and wrong for a departure: the
// value the members table shows for somebody who just left must be the moment
// they left, so this write deliberately bypasses the throttle.
func TestMemberLeaveStampsLastSeenUnthrottled(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)
	memberBeat(t, ts.URL, tokens["player"])

	// Park the stored value INSIDE the throttle window, so a throttled writer
	// would leave it untouched.
	record, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	insideWindow := time.Now().Add(-time.Minute).UTC()
	record.Set(userLastSeenField, insideWindow)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	status, payload := postAerun(t, ts.URL+"/api/aerun/presence/leave", `{}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("leave: expected 200, got %d: %s", status, payload)
	}

	seen := storedLastSeen(t, app, fixPlayerID)
	if !seen.After(insideWindow) {
		t.Fatalf("a departure must stamp last_seen even inside the %s throttle window; it is "+
			"still %s, which was written before the sign-out", memberLastSeenWriteInterval, seen)
	}
	if delta := time.Since(seen); delta > time.Minute || delta < -time.Minute {
		t.Fatalf("last_seen must be stamped at departure time, got %s", seen)
	}
}

// TestMemberLeaveRequiresAuthentication guards the route: identity comes from
// the resolved auth record, never the body, so an anonymous call has nothing to
// remove and must be refused rather than silently succeeding.
func TestMemberLeaveRequiresAuthentication(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	status, payload := postAerun(t, ts.URL+"/api/aerun/presence/leave", `{}`, "")
	if status != http.StatusForbidden {
		t.Fatalf("an anonymous leave must be refused, got %d: %s", status, payload)
	}
}

// TestMemberLeaveIsIdempotent: a double submit (retry, two tabs, a slow click
// landing twice) is a normal outcome, not an error.
func TestMemberLeaveIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	ts := newTestServer(t, app)
	defer ts.Close()

	tokens := seedIdentityFixtures(t, app)

	for attempt := 1; attempt <= 2; attempt++ {
		status, payload := postAerun(t, ts.URL+"/api/aerun/presence/leave", `{}`, tokens["player"])
		if status != http.StatusOK {
			t.Fatalf("leave #%d: expected 200, got %d: %s", attempt, status, payload)
		}
	}
}

// TestLastSeenToWriteIsMonotonic is the release-day guard. Replaying a dump is a
// routine operation, and last_seen is a clock that has been running since the
// dump was taken: an unconditional write would rewind every account that has
// been active since, and the import would still report success.
func TestLastSeenToWriteIsMonotonic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	record, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}

	dumpTime := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	later := time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)

	// A row that has advanced past the dump keeps its newer value.
	record.Set(userLastSeenField, later)
	if got := lastSeenToWrite(record, dumpTime); !got.Time().Equal(later) {
		t.Fatalf("an older dump must not rewind a newer stored value: got %s, want %s", got.Time(), later)
	}

	// A dump that is genuinely newer wins.
	if got := lastSeenToWrite(record, later.Add(time.Hour)); !got.Time().Equal(later.Add(time.Hour)) {
		t.Fatalf("a newer dump must advance the value: got %s", got.Time())
	}

	// An empty stored value adopts the incoming one.
	record.Set(userLastSeenField, "")
	if got := lastSeenToWrite(record, dumpTime); !got.Time().Equal(dumpTime) {
		t.Fatalf("an empty column must adopt the dump value: got %s, want %s", got.Time(), dumpTime)
	}

	// An incoming zero never clears what is stored.
	record.Set(userLastSeenField, later)
	if got := lastSeenToWrite(record, time.Time{}); !got.Time().Equal(later) {
		t.Fatalf("a document with no last_seen must not clear the stored value: got %s", got.Time())
	}
}

// TestUserImportPreservesLiveLastSeen proves the guard end to end through the
// real writer: import, advance the column as a heartbeat would, re-import the
// same dump, and require that the second run neither rewinds nor reports a
// change.
func TestUserImportPreservesLiveLastSeen(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	dumpTime := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	// A 15 character derived id, as the mapping table produces. The validator
	// rejects anything else, which is the point of it.
	upsert := UserUpsert{
		LegacyUID: "legacy-player",
		TargetID:  "legacyplayer001",
		Email:     "legacy-player@example.com",
		Nickname:  "LegacyPlayer",
		Role:      "player",
		Status:    "active",
		Settings:  map[string]any{},
		CreatedAt: dumpTime,
		LastSeen:  dumpTime,
	}

	if _, err := ImportUsers(app, []UserUpsert{upsert}); err != nil {
		t.Fatalf("first import: %v", err)
	}
	if got := storedLastSeen(t, app, upsert.TargetID); !got.Equal(dumpTime) {
		t.Fatalf("the import must carry the legacy last_seen: got %s, want %s", got, dumpTime)
	}

	// Simulate the account being active since the dump.
	record, err := app.FindRecordById(usersCollectionName, upsert.TargetID)
	if err != nil {
		t.Fatal(err)
	}
	live := time.Date(2026, 9, 25, 18, 30, 0, 0, time.UTC)
	record.Set(userLastSeenField, live)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}

	// Replaying the very same dump must be a no-op for this column, and must be
	// reported as unchanged so a rehearsal can still prove idempotency.
	report, err := ImportUsers(app, []UserUpsert{upsert})
	if err != nil {
		t.Fatalf("re-import: %v", err)
	}
	if got := storedLastSeen(t, app, upsert.TargetID); !got.Equal(live) {
		t.Fatalf("a dump replay must not rewind a live last_seen: got %s, want %s", got, live)
	}
	if len(report.Updated) != 0 {
		t.Fatalf("a dump replay that rewinds nothing must report no updates, got %v", report.Updated)
	}
}

// TestVerifyPresenceSchemaRejectsAnUnmigratedDataDir pins the boot guard.
//
// The failure it exists to catch is silent by construction: the heartbeat is
// best-effort, so a missing column means every write is dropped at WARN while
// the endpoint still answers 200, and the members table quietly shows
// registration dates forever. A guard that returns nil here would restore
// exactly the silence this was added to end.
func TestVerifyPresenceSchemaRejectsAnUnmigratedDataDir(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// The test app has migrations applied, so the healthy path must pass.
	if err := verifyPresenceSchema(app); err != nil {
		t.Fatalf("a migrated data dir must pass the guard: %v", err)
	}

	// Drop the field from the collection definition and re-check. The cached
	// collection is what OnServe reads, so this mirrors a binary that predates
	// the migration.
	users, err := app.FindCachedCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	users.Fields.RemoveByName(userLastSeenField)
	if err := app.Save(users); err != nil {
		t.Fatal(err)
	}
	if err := app.ReloadCachedCollections(); err != nil {
		t.Fatal(err)
	}

	if err := verifyPresenceSchema(app); err == nil {
		t.Fatal("the guard must reject a data dir without the last_seen column; " +
			"otherwise the members table degrades silently again")
	}
}
