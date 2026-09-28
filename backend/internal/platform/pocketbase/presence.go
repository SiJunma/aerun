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
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
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
	presenceTTL   = 75 * time.Second
)

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
		presenceMu.Lock()
		onlineMembers[e.Auth.Id] = userPresence{
			UserID:    e.Auth.Id,
			Nickname:  e.Auth.GetString("nickname"),
			AvatarURL: e.Auth.GetString("avatar_url"),
			Role:      e.Auth.GetString("role"),
			LastSeen:  now,
		}
		presenceMu.Unlock()

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
// The two halves age out on different windows on purpose: a member drops after
// presenceTTL (75s, one heartbeat plus slack) while a guest keeps counting for
// guestPresenceWindow. That mirrors the legacy setup, where the RTDB status
// node and the guest_presence node were collected on different schedules.
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
		})
	}
	return activeMembers
}
