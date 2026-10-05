package pocketbase

// user_profile_test.go pins the payload of GET /api/aerun/users/{id}.
//
// THE LEAK THIS EXISTS FOR. The profile page loaded its subject straight off the
// `users` collection through the PocketBase SDK, so opening somebody else's
// profile as a SIGNED-OUT VISITOR returned that account's entire auth record —
// `settings` above all, where each member keeps sound volume, which
// notification types are muted, whether DM and topic-reply mail is wanted, theme
// and language. The fix is a server-side whitelist, and a whitelist nobody tests
// is a whitelist that grows back a field at a time.
//
// The audience split is asserted in BOTH directions, because either half alone
// passes while the other is wrong: a payload that hid everything would satisfy a
// "no private keys" test while breaking the profile page, and a payload that sent
// everything would satisfy an "the owner still sees their own" test while the leak
// stood.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// seedPrivateSettings writes a settings blob shaped like a member who has
// actually used the Settings tab.
//
// IT EXISTS because the identity fixture stores `{"signature": …}` and nothing
// else. Against that fixture a "the payload carries no private keys" assertion
// passes on ANY payload at all — including the raw auth record this endpoint
// replaces. A leak test that cannot fail is worse than no leak test, because it
// reads as coverage. The values below are the real preference names the UI
// writes (ProfilePage's buildAccountForm reads exactly these paths).
func seedPrivateSettings(t *testing.T, app core.App, userID string) {
	t.Helper()
	record, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || record == nil {
		t.Fatalf("account %s missing: %v", userID, err)
	}
	record.Set("settings", map[string]any{
		"signature":         "signature of PlayerOne",
		"theme":             "volcanic",
		"language":          "ru",
		"rep_show_history":  true,
		"rep_show_comments": true,
		"sound":             map[string]any{"enabled": true, "volume": 7},
		"notifications": map[string]any{
			"topic_reply": map[string]any{"in_app": false},
		},
		"email_notifications": map[string]any{"dms": false, "topic_replies": false},
	})
	if err := app.Save(record); err != nil {
		t.Fatalf("failed to seed settings: %v", err)
	}
}

func TestPublicProfileHidesPrivateSettings(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedPrivateSettings(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The readers are everyone who is NOT the subject. `player` is deliberately
	// absent here: reading fixPlayerID as the player means reading your OWN
	// profile, which is the other half of this contract and is asserted by
	// TestPublicProfileKeepsItsOwnerWhole. Putting it in this list would have
	// demanded the owner be denied their own preferences.
	for _, who := range []string{"", "root", "moderator"} {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPlayerID, tokens[who])
		if status != http.StatusOK {
			t.Fatalf("%q: expected 200 reading another profile, got %d: %s", who, status, body)
		}

		// The keys that made the leak a leak. Each is a real member preference:
		// the Settings tab writes them and nothing ever needed to show them to
		// another account.
		for _, private := range []string{
			`"sound"`, `"theme"`, `"language"`, `"email_notifications"`,
			`"notifications"`, `"soundVolume"`, `"notif_topic_reply"`,
			`"email_notif_dms"`,
		} {
			if bytes.Contains([]byte(body), []byte(private)) {
				t.Fatalf("%q: a stranger's profile leaked %s: %s", who, private, body)
			}
		}

		// The auth scaffolding that rides along on a raw record. The email is the
		// sharpest one: ProfilePage renders `data.email` as a title fallback, which
		// is how a member with no session ends up reading somebody's address off a
		// page that never meant to display one.
		for _, scaffolding := range []string{
			`"email"`, `"collectionId"`, `"collectionName"`, `"nickname_normalized"`,
		} {
			if bytes.Contains([]byte(body), []byte(scaffolding)) {
				t.Fatalf("%q: a stranger's profile leaked %s: %s", who, scaffolding, body)
			}
		}
	}

	// AN ORDINARY MEMBER reading ANOTHER ORDINARY MEMBER. This is the exact
	// request TopicPage used to issue once per distinct poster in a thread, so it
	// is the case that matters most: a signed-in reader is still a stranger to
	// somebody else's preferences, and the leak did not care whether you were
	// signed in.
	seedPrivateSettings(t, app, fixModeratorID)
	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixModeratorID, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("member reading another member = %d, want 200: %s", status, body)
	}
	for _, private := range []string{`"sound"`, `"theme"`, `"language"`, `"email_notifications"`, `"notifications"`} {
		if bytes.Contains([]byte(body), []byte(private)) {
			t.Fatalf("a member's profile leaked %s to another member: %s", private, body)
		}
	}

	// …while the public keys that authorisation feeds still arrive, so the
	// hydration can actually render a signature.
	for _, public := range []string{`"signature"`, `"rep_show_history"`, `"rep_show_comments"`} {
		if !bytes.Contains([]byte(body), []byte(public)) {
			t.Errorf("the author hydration reads %s, so it must survive narrowing: %s", public, body)
		}
	}
}
func TestPublicProfileKeepsItsOwnerWhole(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedPrivateSettings(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The other direction. A member's own Settings tab pre-fills every control
	// from `settings`, so an owner served the same narrowed payload as a stranger
	// would open Settings to find every checkbox empty — the same failure the
	// normalizer's own docstring records for the pre-migration snapshot.
	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPlayerID, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("expected 200 reading your own profile, got %d: %s", status, body)
	}
	for _, own := range []string{`"sound"`, `"theme"`, `"language"`, `"notifications"`, `"email_notifications"`} {
		if !bytes.Contains([]byte(body), []byte(own)) {
			t.Errorf("your own profile must carry %s: %s", own, body)
		}
	}
}

// The profile page genuinely needs SOME keys off another account. A test that only
// asserted absence would still pass on a payload that broke the page, so the keys
// the UI renders are pinned here too.
func TestPublicProfileStillCarriesWhatThePageRenders(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPlayerID, tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200 as a guest, got %d: %s", status, body)
	}

	// The sidebar card reads nickname, status_line, avatar, post_count,
	// reputation and role; the profile block reads bio, location, birthday,
	// occupation, interests and contacts.
	for _, needed := range []string{
		`"nickname"`, `"status_line"`, `"avatar_url"`, `"posts_count"`,
		`"reputation"`, `"role"`, `"status"`, `"bio"`, `"location"`,
		`"birthday"`, `"occupation"`, `"interests"`, `"contacts"`,
	} {
		if !bytes.Contains([]byte(body), []byte(needed)) {
			t.Errorf("the profile page renders %s, so the DTO must carry it: %s", needed, body)
		}
	}
}

// The profile page renders NO date off another account, and the DTO served both
// clocks anyway, at PocketBase's full precision:
//
//	"created":   "2026-04-17 22:45:57.744Z"
//	"last_seen": "2026-05-12 15:01:46.430Z"
//
// A millisecond-exact registration timestamp is a fingerprint, not a date: it
// seats a member inside a signup burst, inside a timezone, and relative to the
// legacy Firebase migration — and this route answers SIGNED-OUT visitors. Nothing
// on the profile page reads either field (see the whitelist above), so the pair
// was pure excess on this route.
//
// The assertion is key-shaped (`"created":`, not a bare `created`) because the
// body also carries a random `request_id`, and a substring match would one day
// fail on a hex string that happens to contain the word.
//
// THE MATCHING HALF IS THE MEMBER BOARD, WHICH KEEPS BOTH. MembersPage paints a
// JOINED column and a LAST SEEN column, and `last_seen` is the only offline
// answer the table has at all: the live presence map is a disposable in-process
// cache that drops a member 75 seconds after their last heartbeat, so without
// the durable column the LAST SEEN cell reads "..." for nearly everyone, which is
// its permanent resting state rather than a transient one. Asserted here so a
// later "tidy the payload" pass cannot strip the board by mistake and empty the
// JOINED column while fixing a route that never had the problem.
func TestPublicProfileOmitsTheRegistrationAndLastSeenClocks(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// The owner is included deliberately: the question is not "may they know
	// their own registration time" but "is this field doing a job", and on this
	// route it is not doing one for anyone.
	for _, who := range []string{"", "player"} {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPlayerID, tokens[who])
		if status != http.StatusOK {
			t.Fatalf("%q: expected 200, got %d: %s", who, status, body)
		}
		for _, clock := range []string{`"created":`, `"last_seen":`} {
			if bytes.Contains([]byte(body), []byte(clock)) {
				t.Errorf("%q: the profile DTO must not carry %s: %s", who, clock, body)
			}
		}
	}

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("the member board must stay public, got %d: %s", status, body)
	}
	for _, clock := range []string{`"created":`, `"last_seen":`} {
		if !bytes.Contains([]byte(body), []byte(clock)) {
			t.Errorf("MembersPage renders %s, so the board must still carry it: %s", clock, body)
		}
	}
}

// The unread floor needs a registration date, and this is the shape it gets.
//
// Four components read `profile.created_at` and floor unread at it, so the field
// has to be there — but day precision only. The value asserted here is what
// makes the fix safe to make: a member created mid-afternoon floors at the START
// of that day, never at a time-of-day that could betray the signup burst, the
// timezone, or the migration.
func TestPublicProfileCarriesADayOnlyRegistrationDate(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixPlayerID, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	var payload struct {
		CreatedAt string `json:"created_at"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("the profile payload must be JSON: %v (%s)", err, body)
	}
	if payload.CreatedAt == "" {
		t.Fatalf("the unread floor reads profile.created_at; it must not be empty: %s", body)
	}

	// THE SHAPE, which is the security property: exactly a date, ten characters.
	// A time component — "T22:45:57", a trailing "Z", milliseconds — is the
	// fingerprint this route used to serve, so it is matched against explicitly
	// rather than merely "is it parseable".
	if len(payload.CreatedAt) != len("2006-01-02") {
		t.Fatalf("created_at must be a bare YYYY-MM-DD day, got %q: %s", payload.CreatedAt, body)
	}
	parsed, err := time.Parse(time.DateOnly, payload.CreatedAt)
	if err != nil {
		t.Fatalf("created_at must parse as a plain date, got %q: %v", payload.CreatedAt, err)
	}

	// It must be the account's OWN day, not merely any well-formed date. A
	// hardcoded "2000-01-01" would satisfy every assertion above and silently
	// floor every account at the epoch, which reads as "everything is unread"
	// rather than as a bug.
	record, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil || record == nil {
		t.Fatalf("account %s missing: %v", fixPlayerID, err)
	}
	stored := record.GetDateTime("created").Time()
	if stored.IsZero() {
		t.Skip("fixture has no creation timestamp to compare against")
	}
	if want := stored.UTC().Format(time.DateOnly); payload.CreatedAt != want {
		t.Errorf("created_at must be the account's own registration day %q, got %q", want, payload.CreatedAt)
	}

	// Flooring to the START of the day is the safe direction: the consumers take
	// max(lastVisit, registration), so an earlier floor can only over-count
	// unread, never hide it. Rounding up to the end of the registration day is
	// what would swallow a topic posted on the signup day itself, so the value
	// must not sit after the stored instant's own midnight.
	if !parsed.After(stored.UTC().Add(-24 * time.Hour)) {
		t.Errorf("created_at %q must floor at the start of the registration day, not after it", payload.CreatedAt)
	}
}

// A ban restricts what an account may DO, not what others may see of it. This
// matches the Posts and Characters tabs and migration 1768100000.
func TestPublicProfileOfLimitedAccountStaysReadable(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	for _, id := range []string{fixBannedID, fixPendingID} {
		status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+id, tokens[""])
		if status != http.StatusOK {
			t.Errorf("%s: a limited account must still have a readable profile, got %d: %s",
				id, status, body)
		}
	}
}

func TestPublicProfileOfUnknownAccountIs404(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, _ := getAerunAuthed(t, ts.URL+"/api/aerun/users/does-not-exist", tokens[""])
	if status != http.StatusNotFound {
		t.Fatalf("unknown account = %d, want 404", status)
	}
}

// The role badge is public by the same argument as the signature: it is painted
// on every post the reader can already see. Asserted so a future narrowing cannot
// quietly drop it and render every profile "Player".
func TestPublicProfileCarriesTheRoleBadge(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	adminToken := createTestUser(t, app, fixAdminID, "admin@example.com", "AdminOne", auth.RoleAdmin, auth.StatusActive)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/"+fixAdminID, adminToken)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(auth.RoleAdmin)) {
		t.Errorf("an admin's profile must show its role badge: %s", body)
	}
}

// The public member board is the LIST counterpart of the profile DTO, and it is
// the larger of the two leaks: it shipped every account's auth record to every
// signed-out visitor, in one response.
//
// Seeded private settings for the same reason the profile test seeds them: the
// identity fixture stores only `{"signature": …}`, so against it a "no private
// keys" assertion would pass even on the raw collection read this replaced.
func TestPublicMembersListHidesPrivateSettings(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedPrivateSettings(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("the member board must be public, got %d: %s", status, body)
	}

	// No settings at all — not even the narrowed public keys the PROFILE page
	// needs. The members table renders none of them.
	for _, forbidden := range []string{`"settings"`, `"sound"`, `"theme"`, `"signature"`, `"email"`} {
		if bytes.Contains([]byte(body), []byte(forbidden)) {
			t.Fatalf("the public member board leaked %s: %s", forbidden, body)
		}
	}

	// What the table actually paints, asserted so the route cannot be "fixed" by
	// answering with an empty list that renders as a table with no rows.
	for _, needed := range []string{
		`"nickname"`, `"role"`, `"status"`, `"status_line"`, `"avatar_url"`,
		`"posts_count"`, `"topics_count"`, `"reputation"`, `"verified"`,
		`"last_seen"`, `"totalPages"`, `"items"`,
	} {
		if !bytes.Contains([]byte(body), []byte(needed)) {
			t.Errorf("MembersPage renders %s, so the list must carry it: %s", needed, body)
		}
	}
}

// The board is the one public read that enumerates accounts, so it must not be
// turnable into a bulk dump: it enforces the same page cap as the staff route,
// and asking for more does not yield more.
func TestPublicMembersListCapsThePageSize(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users?perPage=100000", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(`"perPage":30`)) {
		t.Errorf("the page size must stay capped at 30: %s", body)
	}
}

// The nickname pre-check answered a BOOLEAN with a whole auth record, so a guest
// registering a new account received a stranger's private settings merely for
// typing a name. Private settings are seeded here for the same reason as above —
// against the bare fixture this assertion would pass on the SDK read it replaced.
func TestNicknameCheckAnswersWithABoolean(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedPrivateSettings(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	// A guest may check availability: registration happens before a session
	// exists, so gating this would break the one flow that needs it most.
	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/nicknames/check?nickname=PlayerOne", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(`"available":false`)) {
		t.Errorf("a taken nickname must be reported as taken: %s", body)
	}
	for _, leaked := range []string{`"settings"`, `"email"`, `"sound"`} {
		if bytes.Contains([]byte(body), []byte(leaked)) {
			t.Fatalf("the nickname check leaked %s: %s", leaked, body)
		}
	}

	// Your OWN name is not a conflict — the profile form hits this branch on
	// every save that does not change the nickname.
	status, body = getAerunAuthed(t, ts.URL+"/api/aerun/nicknames/check?nickname=PlayerOne&exclude="+fixPlayerID, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(`"available":true`)) {
		t.Errorf("re-saving your own nickname must not report a conflict: %s", body)
	}

	// Normalisation is the server's job now. A fullwidth "Ｐ" folds to "p", so
	// this must collide with "PlayerOne" — the client used to normalise in
	// JavaScript and disagree with the UNIQUE index about exactly this.
	status, body = getAerunAuthed(t, ts.URL+"/api/aerun/nicknames/check?nickname=%EF%BC%B0layerone", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(`"available":false`)) {
		t.Errorf("a fullwidth variant must collide with the indexed name: %s", body)
	}
}

// The mention picker fetched FIVE whole auth records per keystroke, so a search
// box leaked five strangers' private settings at a time.
func TestUserSearchReturnsIdentityOnly(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedPrivateSettings(t, app, fixPlayerID)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/search?q=Player", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}

	for _, needed := range []string{`"id"`, `"nickname"`, `"avatar_url"`} {
		if !bytes.Contains([]byte(body), []byte(needed)) {
			t.Errorf("the mention picker renders %s: %s", needed, body)
		}
	}
	for _, leaked := range []string{`"settings"`, `"email"`, `"sound"`, `"role"`, `"status"`} {
		if bytes.Contains([]byte(body), []byte(leaked)) {
			t.Fatalf("the mention search leaked %s: %s", leaked, body)
		}
	}
}

// The cap is a security property, not a UX choice: this endpoint is reachable
// without a session, so an unbounded search is a member directory dump.
func TestUserSearchIsCapped(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// "%" is a LIKE wildcard. It must be matched literally, not turn the query
	// into "every account".
	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/users/search?q=%25", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	if bytes.Contains([]byte(body), []byte("PlayerOne")) {
		t.Errorf("a literal %% must not match every account: %s", body)
	}

	// Under the floor the route answers empty rather than erroring.
	status, body = getAerunAuthed(t, ts.URL+"/api/aerun/users/search?q=a", tokens[""])
	if status != http.StatusOK {
		t.Fatalf("expected 200 below the floor, got %d: %s", status, body)
	}
	if !bytes.Contains([]byte(body), []byte(`"items":[]`)) {
		t.Errorf("a one-character query must match nothing: %s", body)
	}
}
