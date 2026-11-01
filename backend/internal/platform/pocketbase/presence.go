// Presence keeps two deliberately different models side by side:
//
//   - Members are an in-process map. An authenticated heartbeat already carries
//     the account id, and a restart may legitimately forget a "who is online
//     right now" view that every open tab rebuilds within one heartbeat.
//   - Guests (unauthenticated visitors) live in the `guest_presence`
//     collection. They have no auth record to anchor a session to, so the row
//     *is* the identity: it survives a restart, it can be pruned on a schedule,
//     and it is bounded by a schema instead of by a map that only shrinks when
//     somebody happens to read it.
//
// The guest model restores the legacy contract that Sprint 6 dropped together
// with the RTDB (`database.rules.json`: public read on
// `guest_presence/{guest_id} = { guest_id, last_seen }`), and it keeps the two
// properties that contract was chosen for:
//
//   - No PII. A row holds a client-generated opaque visitor id and two
//     timestamps. No IP, no user-agent, no visited path: the anonymous
//     browsing trail of guests is not something this forum starts collecting.
//   - One validated writer. The legacy node was written straight from the
//     browser (`.write: true`). Here the collection is server-only and the
//     presence routes are its only ingress, so every write is shape-checked and
//     rate limited instead of trusted.
//
// Guests beat once a minute and drop their row when the tab goes away
// (`POST /presence/guest/leave`, sent with navigator.sendBeacon) — the modern
// stand-in for RTDB's `onDisconnect().remove()`.
package pocketbase

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

type userPresence struct {
	UserID          string         `json:"id"`
	Nickname        string         `json:"nickname"`
	AvatarURL       string         `json:"avatar_url"`
	Role            string         `json:"role"`
	LastSeen        time.Time      `json:"last_seen"`
	ActiveCharacter map[string]any `json:"active_character,omitempty"`
}

var (
	presenceMu    sync.RWMutex
	onlineMembers = make(map[string]userPresence)
	// presenceTTL is how long a member stays in the "online now" map after
	// their last heartbeat. 15 minutes is the online window the spec, the
	// stats panel and the guest model all use, so a member who merely goes
	// idle, switches tabs or closes the tab without a leave beacon remains
	// present for a full 15 minutes of inactivity — not one heartbeat — before
	// being cleared from "active now".
	presenceTTL = 15 * time.Minute
)

// memberLastSeenWriteInterval throttles how often a heartbeat is allowed to
// persist users.last_seen.
//
// The browser beats every 30 seconds, so an unthrottled write would be 120 row
// updates per member per hour — each one also moving the `updated` autodate and
// firing a PocketBase realtime event to that member's own open ProfilePage / DM
// subscription. Presence is best-effort telemetry; it does not deserve to be the
// noisiest writer in the system.
//
// The throttle still gives a hard accuracy guarantee, which is what the members
// table actually needs:
//
//   - The FIRST beat after any idle period always writes, because the stored
//     value is older than the interval. So a session's arrival is always
//     recorded exactly, and "last seen" can never predate the visit that
//     produced it.
//   - After that, writes land every interval for as long as the member stays.
//     When the member finally drops off, the stored value is at most one
//     interval behind their true departure.
//
// Five minutes is well inside the resolution a "last seen" column is read at,
// and it cuts the write rate by 10x.
const memberLastSeenWriteInterval = 5 * time.Minute

// verifyPresenceSchema asserts at boot that the durable last-seen column
// actually exists.
//
// It exists because of how this failure presents. touchMemberLastSeen is
// deliberately best-effort, so a write against a schema without the column
// fails, is logged at WARN and dropped -- and the heartbeat still answers 200.
// Every symptom is then downstream of that: the members table shows the
// registration date for everyone, the column never moves, and nothing in the UI
// or the API says a word about it. That is exactly the state this feature was
// built to eliminate, reintroduced by an old binary pointed at a database that
// had not been migrated yet.
//
// apis.Serve applies every migration before OnServe runs, so reaching this
// hook with the column missing is not a race and not a first-boot condition --
// it means the binary and the data directory disagree, and continuing would
// serve a forum whose activity column is quietly wrong. Refusing to start is
// the honest outcome: the fix is to run the migrations, which any restart of a
// current binary does automatically.
func verifyPresenceSchema(app core.App) error {
	users, err := app.FindCachedCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return fmt.Errorf("users collection unavailable: %w", err)
	}
	if users.Fields.GetByName(userLastSeenField) == nil {
		return fmt.Errorf(
			"users.%s is missing: this binary and the data directory are out of sync "+
				"(migrations run automatically on start -- if you are seeing this, the "+
				"process is running a build from before migration 1767300000, and every "+
				"member's last-seen timestamp will silently stay empty)",
			userLastSeenField)
	}
	return nil
}

// userLastSeenField mirrors the column added by migration 1767300000. The
// durable "last visit" clock, as opposed to the onlineMembers map, which is the
// "online right now" clock and is deliberately disposable.
const userLastSeenField = "last_seen"

// touchMemberLastSeen advances the durable last-seen timestamp for a beating
// member, subject to memberLastSeenWriteInterval.
//
// It is deliberately best-effort and never propagates an error: presence is
// telemetry, and a failed write must not turn a 200 heartbeat into a 500 and
// make the client retry harder. The cost of losing one is that the column lags
// by up to one interval, which is the same bound the throttle already accepts.
//
// authRecord is the record PocketBase resolved for this request, so the
// staleness test costs nothing: it is current as of this beat. Only when the
// write is actually due is a fresh copy loaded, which keeps the common path —
// four out of five beats — free of any extra query.
func touchMemberLastSeen(app core.App, authRecord *core.Record, now time.Time) {
	stored := authRecord.GetDateTime(userLastSeenField)
	if !stored.IsZero() && now.Sub(stored.Time()) < memberLastSeenWriteInterval {
		return
	}
	writeMemberLastSeen(app, authRecord, now)
}

// writeMemberLastSeen persists users.last_seen with no throttle at all.
//
// The throttle exists to damp a signal that arrives 120 times per member per
// hour. An explicit departure arrives ONCE per session, and it is the one write
// whose exact moment the column is read against: the members table shows "last
// seen" for somebody who just signed out, and a value throttled up to five
// minutes stale is the difference between "left a moment ago" and "left five
// minutes ago" on the row everybody looks at after a member goes.
func writeMemberLastSeen(app core.App, authRecord *core.Record, now time.Time) {
	record, err := app.FindRecordById(usersCollectionName, authRecord.Id)
	if err != nil {
		app.Logger().Warn("member last seen could not be read", "user", authRecord.Id, "error", err)
		return
	}
	record.Set(userLastSeenField, now)
	if err := app.Save(record); err != nil {
		app.Logger().Warn("member last seen could not be persisted", "user", authRecord.Id, "error", err)
	}
}

// isMemberRecentlyActive reports whether the member was active on the forum
// within presenceTTL, based on the durable users.last_seen clock.
//
// This is the backstop for isMemberOnline: the live onlineMembers map drops a
// member after 15 quiet minutes, which happens when a tab sits in the
// background and the browser throttles its heartbeat. The durable column is
// written on every heartbeat (first beat after any idle period always writes,
// then at most every memberLastSeenWriteInterval), so it lags the real moment
// by at most one interval — well inside the 15-minute window.
func isMemberRecentlyActive(app core.App, userID string, now time.Time) bool {
	user, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || user == nil {
		return false
	}
	stored := user.GetDateTime(userLastSeenField)
	if stored.IsZero() {
		return false
	}
	return !stored.Time().Before(now.Add(-presenceTTL))
}

// ---------------------------------------------------------------------------
// Guests: the guest_presence collection
// ---------------------------------------------------------------------------

// guestPresenceCollectionTable is the collection that stores anonymous visitor
// presence (created by 1766800000_guest_presence.go).
const guestPresenceCollectionTable = "guest_presence"

const (
	// guestPresenceWindow is how long a guest keeps counting as online after
	// their last heartbeat. 15 minutes is the window the stats panel and the
	// legacy RTDB subscription used, so a closed tab that never got its leave
	// beacon out still ages out of the counter instead of sticking forever.
	guestPresenceWindow = 15 * time.Minute

	// guestPresenceRetention is how long a row survives before the prune job
	// deletes it. Longer than the online window, so a row is already invisible
	// to the counter well before it is collected: the retention only has to
	// outlive a missed prune cycle.
	guestPresenceRetention = time.Hour

	// guestPresenceListLimit bounds the size of a GET /presence/guests answer.
	// One hour of visitors is a few dozen rows in practice; the limit is a
	// backstop against a pathological burst, not a pagination contract.
	guestPresenceListLimit = 500

	// guestHeartbeatsPerMinute is the per-IP write budget for the anonymous
	// heartbeat. PocketBase ships Settings().RateLimits disabled and this
	// deployment never enables it, so the one anonymous write path in the API
	// carries its own guard. A well-behaved browser sends one beat per minute
	// plus one whenever the tab regains focus, so the budget is roughly 30x
	// its traffic and cannot be reached by a client that behaves.
	guestHeartbeatsPerMinute = 30

	// guestIDMinLen and guestIDMaxLen bound the client-generated visitor id.
	// The legacy generator
	// (Math.random().toString(36).substring(2) + Date.now().toString(36))
	// produces 18-19 lowercase alphanumeric characters; the range leaves room
	// for a future generator without accepting free-form text.
	guestIDMinLen = 8
	guestIDMaxLen = 64
)

// guestThrottle is a fixed-window per-IP limiter for the guest write paths. It
// is process-local on purpose: the heartbeat is a single-instance, best-effort
// signal, and a shared counter would cost a database round trip per beat to
// protect data that is already disposable.
type guestThrottle struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	lastSweep time.Time
	buckets   map[string]*guestBucket
}

type guestBucket struct {
	start time.Time
	count int
}

func newGuestThrottle(limit int, window time.Duration) *guestThrottle {
	return &guestThrottle{
		limit:   limit,
		window:  window,
		buckets: make(map[string]*guestBucket),
	}
}

// allow reports whether key may write right now, consuming one unit when it
// may. Expired buckets are swept at most once per window, so the map stays
// proportional to the distinct callers seen inside a single window instead of
// growing with every address that ever appeared.
func (t *guestThrottle) allow(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.lastSweep.IsZero() || now.Sub(t.lastSweep) >= t.window {
		for k, bucket := range t.buckets {
			if now.Sub(bucket.start) >= t.window {
				delete(t.buckets, k)
			}
		}
		t.lastSweep = now
	}

	bucket, ok := t.buckets[key]
	if !ok || now.Sub(bucket.start) >= t.window {
		t.buckets[key] = &guestBucket{start: now, count: 1}
		return true
	}
	if bucket.count >= t.limit {
		return false
	}
	bucket.count++
	return true
}

// reset drops every bucket so a test can start from a clean budget.
func (t *guestThrottle) reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buckets = make(map[string]*guestBucket)
	t.lastSweep = time.Time{}
}

// guestLimiter guards the anonymous heartbeat path.
var guestLimiter = newGuestThrottle(guestHeartbeatsPerMinute, time.Minute)

type heartbeatForm struct {
	GuestID string `json:"guest_id"`
	// ActiveCharacter is the mask the member is currently posting under
	// (a character id). Resolved server-side against the caller's own
	// characters, so a forged id cannot borrow somebody else's mask.
	ActiveCharacter string `json:"active_character"`
}

// heartbeatHandler records one presence beat. The route serves both identities
// on purpose: the browser sends exactly one beat per minute either way, and
// deciding between member and guest from the resolved auth record keeps the
// client from having to know whether it is signed in.
//
//   - Authenticated: refresh the in-process member map. The guest_id in the
//     body is ignored, so a visitor who logs in can never be counted twice.
//   - Anonymous: validate, rate limit and upsert the guest row.
func heartbeatHandler(e *core.RequestEvent) error {
	var form heartbeatForm
	if e.Request.Body != nil {
		_ = json.NewDecoder(e.Request.Body).Decode(&form)
	}

	now := time.Now()

	if e.Auth != nil {
		activeCharacter := map[string]any{}
		if form.ActiveCharacter != "" {
			if display, err := findCharacter(e.App, form.ActiveCharacter); err == nil && display != nil && display.OwnerID == e.Auth.Id {
				activeCharacter = map[string]any{
					"id":         form.ActiveCharacter,
					"name":       display.Name,
					"avatar_url": display.AvatarURL,
				}
			}
		}
		presenceMu.Lock()
		onlineMembers[e.Auth.Id] = userPresence{
			UserID:          e.Auth.Id,
			Nickname:        e.Auth.GetString("nickname"),
			AvatarURL:       e.Auth.GetString("avatar_url"),
			Role:            e.Auth.GetString("role"),
			LastSeen:        now,
			ActiveCharacter: activeCharacter,
		}
		presenceMu.Unlock()

		// The in-process map above answers "online right now" and is thrown
		// away  presenceTTL later. This is the durable half: it is what the
		// members table renders once the member is gone from the map, which is
		// the entire reason that column could previously only ever show "...".
		touchMemberLastSeen(e.App, e.Auth, now)

		snapshot, _ := buildStatusSnapshot(e.App, now)
		resp := map[string]any{
			"ok":         true,
			"request_id": requestIDFrom(e),
		}
		if snapshot != nil {
			resp["presence"] = snapshot["presence"]
		}
		return e.JSON(http.StatusOK, resp)
	}

	if !validGuestID(form.GuestID) {
		return validationError("guest_id must be 8 to 64 lowercase alphanumeric characters")
	}
	if !guestLimiter.allow(e.RealIP(), now) {
		return rateLimitedError("too many guest heartbeats from this address")
	}
	if err := upsertGuestPresence(e.App, form.GuestID, now); err != nil {
		return internalError("guest presence could not be recorded", err)
	}

	snapshot, _ := buildStatusSnapshot(e.App, now)
	resp := map[string]any{
		"ok":         true,
		"request_id": requestIDFrom(e),
	}
	if snapshot != nil {
		resp["presence"] = snapshot["presence"]
	}
	return e.JSON(http.StatusOK, resp)
}

// guestLeaveHandler removes a guest row. It is the stand-in for RTDB's
// `onDisconnect().remove()`: the browser calls it from `pagehide` through
// navigator.sendBeacon (which can only POST) and directly on login. Leaving is
// idempotent and needs no proof of identity: the worst a forged call can do is
// drop a visitor out of a counter for the remainder of the online window.
func guestLeaveHandler(e *core.RequestEvent) error {
	var form heartbeatForm
	if e.Request.Body != nil {
		_ = json.NewDecoder(e.Request.Body).Decode(&form)
	}

	if !validGuestID(form.GuestID) {
		return validationError("guest_id must be 8 to 64 lowercase alphanumeric characters")
	}
	if err := deleteGuestPresence(e.App, form.GuestID); err != nil {
		return internalError("guest presence could not be cleared", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"ok":         true,
		"request_id": requestIDFrom(e),
	})
}

// memberLeaveHandler removes a SIGNED-IN member from the online list.
//
// This route is the member counterpart of guestLeaveHandler, and it exists
// because guests were the only identity that could ever leave on purpose.
// A member had no such call: the heartbeat simply stopped, and the account
// stayed in the in-process map until presenceTTL (75s) pruned it. For a guest
// that window is invisible — they are anonymous. For a member it is a wrong
// answer with a name on it: the stats panel kept counting a signed-OUT person
// as "Online now", and every other browser polling /status agreed, because the
// panel was faithfully reporting what the server believed.
//
// So the fix is not a bigger client-side cache clear. It is the missing half of
// the contract: the browser must be able to say "I am leaving", exactly as it
// already does for guests on pagehide.
//
// The durable half rides along. users.last_seen is the persistent "last visit"
// clock and the heartbeat that maintains it stops the moment this returns, so
// without this write the column would be frozen wherever the previous 30s tick
// happened to land. It is written UNTHROTTLED (writeMemberLastSeen, not
// touchMemberLastSeen): a departure happens once per session, and it is exactly
// the value the members table is read at.
//
// Signing out is not the only way to arrive here — an idle timeout and a tab
// close also stop the beat — but it is the only one where the client knows, at
// this instant, that the account is gone. Idling stays a non-event (see
// setRtdbOffline on the client), and a tab that is merely closed still ages out
// through the TTL, which is the correct outcome for a tab nobody can ask.
func memberLeaveHandler(e *core.RequestEvent) error {
	// Presence identity comes from the resolved auth record, never from the
	// body: a forged call can only ever remove the CALLER, so it cannot be used
	// to drop an arbitrary member out of the online list.
	if e.Auth == nil {
		return forbiddenError("authentication is required to leave presence")
	}

	now := time.Now()

	presenceMu.Lock()
	delete(onlineMembers, e.Auth.Id)
	presenceMu.Unlock()

	writeMemberLastSeen(e.App, e.Auth, now)

	// The snapshot comes back with the response for the same reason the
	// heartbeat returns one: the caller just changed the presence view, and
	// handing back the corrected view means every panel in this tab agrees
	// immediately instead of at the next 20s poll.
	snapshot, _ := buildStatusSnapshot(e.App, now)
	resp := map[string]any{
		"ok":         true,
		"request_id": requestIDFrom(e),
	}
	if snapshot != nil {
		resp["presence"] = snapshot["presence"]
	}
	return e.JSON(http.StatusOK, resp)
}

// listGuestsHandler reports the visitors seen inside the online window.
//
// It is public, exactly like the legacy `guest_presence` node it replaces and
// like its sibling GET /presence/online-users, which already publishes member
// ids and nicknames to anyone. Hiding opaque visitor ids while publishing
// member identities would be incoherent, and the counter is a public product
// feature: the stats panel shows "guests online" to every visitor.
func listGuestsHandler(e *core.RequestEvent) error {
	records, err := activeGuestRecords(e.App, time.Now())
	if err != nil {
		return internalError("guest presence could not be read", err)
	}

	guests := make([]map[string]any, 0, len(records))
	for _, record := range records {
		guests = append(guests, map[string]any{
			"id":        record.GetString("guest_id"),
			"last_seen": record.GetDateTime("last_seen").String(),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"count":          len(guests),
		"guests":         guests,
		"window_seconds": int(guestPresenceWindow.Seconds()),
		"request_id":     requestIDFrom(e),
	})
}

// ---------------------------------------------------------------------------
// Guest presence storage
// ---------------------------------------------------------------------------

// validGuestID accepts exactly the shape the client generator produces:
// lowercase alphanumeric, 8 to 64 characters. Checking it before the write is
// what keeps a public endpoint from being a free row-insert primitive for
// arbitrary payloads (unicode, oversized ids, query-looking text).
func validGuestID(id string) bool {
	if len(id) < guestIDMinLen || len(id) > guestIDMaxLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// upsertGuestPresence records one beat, creating the row on first contact.
// `first_seen` is written once and never rewritten, so a later feature can ask
// "unique visitors in a window" without adding a column.
//
// The create path tolerates a lost race: two beats for the same new id (a dev
// double mount, two tabs sharing one storage id) both try to insert, the unique
// index rejects the slower one, and that writer updates the row its competitor
// created instead of surfacing a 500 for a successful beat.
func upsertGuestPresence(app core.App, guestID string, now time.Time) error {
	collection, err := app.FindCachedCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		return err
	}

	record, err := app.FindFirstRecordByFilter(collection, "guest_id = {:guestID}", dbx.Params{"guestID": guestID})
	switch {
	case err == nil:
		record.Set("last_seen", now)
		return app.Save(record)
	case !errors.Is(err, sql.ErrNoRows):
		return err
	}

	record = core.NewRecord(collection)
	record.Set("guest_id", guestID)
	record.Set("first_seen", now)
	record.Set("last_seen", now)
	if err := app.Save(record); err != nil {
		if existing, findErr := app.FindFirstRecordByFilter(collection, "guest_id = {:guestID}", dbx.Params{"guestID": guestID}); findErr == nil {
			existing.Set("last_seen", now)
			return app.Save(existing)
		}
		return err
	}
	return nil
}

// deleteGuestPresence drops the row for guestID. A missing row is not an error:
// leaving is a best-effort notification (tab close, login) and an
// already-pruned or never-created row is a normal outcome.
func deleteGuestPresence(app core.App, guestID string) error {
	collection, err := app.FindCachedCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		return err
	}

	record, err := app.FindFirstRecordByFilter(collection, "guest_id = {:guestID}", dbx.Params{"guestID": guestID})
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return app.Delete(record)
}

// activeGuestRecords returns the rows seen inside the online window, newest
// first. The window is applied in Go rather than in the query on purpose: the
// table holds at most one hour of visitors, and comparing the typed value keeps
// the cut-off independent of SQLite's date storage format. Both the counter
// (/presence/online-users) and the list (/presence/guests) read through here,
// so the two endpoints cannot disagree about how many guests are online.
func activeGuestRecords(app core.App, now time.Time) ([]*core.Record, error) {
	collection, err := app.FindCachedCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		return nil, err
	}

	records, err := app.FindRecordsByFilter(collection, "", "-last_seen", guestPresenceListLimit, 0)
	if err != nil {
		return nil, err
	}

	cutoff := now.Add(-guestPresenceWindow)
	active := make([]*core.Record, 0, len(records))
	for _, record := range records {
		if !record.GetDateTime("last_seen").Time().Before(cutoff) {
			active = append(active, record)
		}
	}
	return active, nil
}

// pruneGuestPresence deletes rows older than the retention window and reports
// how many went away. This is what keeps the table bounded without depending on
// a reader to trigger cleanup (the flaw of the in-memory map it replaced): the
// guest table grows with every distinct visitor, so something must collect it.
func pruneGuestPresence(app core.App, now time.Time) (int, error) {
	collection, err := app.FindCachedCollectionByNameOrId(guestPresenceCollectionTable)
	if err != nil {
		return 0, err
	}

	records, err := app.FindAllRecords(collection)
	if err != nil {
		return 0, err
	}

	cutoff := now.Add(-guestPresenceRetention)
	pruned := 0
	for _, record := range records {
		if record.GetDateTime("last_seen").Time().Before(cutoff) {
			if err := app.Delete(record); err != nil {
				return pruned, err
			}
			pruned++
		}
	}
	return pruned, nil
}

// guestPresencePruneJobID identifies the cleanup job in PocketBase's cron.
const guestPresencePruneJobID = "__aerunGuestPresencePrune__"

// registerGuestPresenceCron schedules the retention prune. PocketBase starts its
// scheduler from an OnServe hook registered at priority 999, so a job added
// while our own OnServe handler runs (default priority) is always in place
// before the first tick. Adding the same job id twice replaces it, which keeps
// this idempotent for the tests that bind OnServe more than once.
func registerGuestPresenceCron(app core.App) error {
	return app.Cron().Add(guestPresencePruneJobID, "*/10 * * * *", func() {
		pruned, err := pruneGuestPresence(app, time.Now())
		if err != nil {
			app.Logger().Warn("guest presence prune failed", "error", err)
			return
		}
		if pruned > 0 {
			app.Logger().Info("pruned guest presence rows", "rows", pruned)
		}
	})
}

// listOnlineUsersHandler returns the members currently online plus the guest
// counter. Members come from the in-process map (pruned here, because this is
// its only reader); guests come from the collection through the same helper
// that feeds /presence/guests.
//
// Both halves age out on the same 15-minute window: a member drops after
// presenceTTL (15 minutes from the last heartbeat) and a guest keeps counting
// for guestPresenceWindow (15 minutes). A closed tab that never sends its
// leave beacon therefore ages out of the counter instead of sticking forever.
// That mirrors the legacy setup, where the RTDB status node and the
// guest_presence node were collected on different schedules.
func listOnlineUsersHandler(e *core.RequestEvent) error {
	now := time.Now()

	activeMembers := activeMembersAt(now)

	guestsCount := 0
	if records, err := activeGuestRecords(e.App, now); err != nil {
		// The guest counter is decorative; the member list it shares a
		// response with is not. Degrade to 0 and leave a trail instead of
		// failing the whole stats panel.
		e.App.Logger().Warn("guest count unavailable", "error", err)
	} else {
		guestsCount = len(records)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"users":        activeMembers,
		"guests_count": guestsCount,
		"total_online": len(activeMembers) + guestsCount,
		"request_id":   requestIDFrom(e),
	})
}

// activeMembersAt collects the members seen inside presenceTTL and drops the
// expired ones, which is the only cleanup this map ever gets.
func activeMembersAt(now time.Time) []map[string]any {
	presenceMu.Lock()
	defer presenceMu.Unlock()

	cutoff := now.Add(-presenceTTL)
	activeMembers := []map[string]any{}
	for id, member := range onlineMembers {
		if member.LastSeen.Before(cutoff) {
			delete(onlineMembers, id)
			continue
		}
		activeMembers = append(activeMembers, map[string]any{
			"id":         member.UserID,
			"nickname":   member.Nickname,
			"avatar_url": member.AvatarURL,
			"role":       member.Role,
			// The actual time of the last beat, not the time of this read.
			// The frontend used to receive no value here and substitute
			// Date.now() for the missing field, which made every connected
			// member read as "seen this exact second" — a value that is wrong
			// by up to a full beat interval and, more importantly, fabricated
			// rather than measured. RFC 3339 rather than DateTime.String(),
			// because the string form uses a space where ISO 8601 wants a "T"
			// and `new Date()` is not guaranteed to accept it everywhere.
			"last_seen": member.LastSeen.UTC().Format(time.RFC3339),
		})
	}
	return activeMembers
}
