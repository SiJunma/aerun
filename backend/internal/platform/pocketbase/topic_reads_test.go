package pocketbase

// The unread-topic count and the read-state writes behind it.
//
// This is the fix for a badge that was wrong in three ways at once. The count
// used to be computed in the browser from `topics?limit=50`: capped at fifty,
// per-browser (a localStorage read map), and filtered with a client-side
// permission check over whatever categories happened to be loaded. Meanwhile
// `AuthProvider` held the number in a `useState` with no setter, so the badge and
// the tab title rendered a permanent 0 — the three bugs hiding each other, which
// is why none of them was visible on its own.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// seedTopicIn creates a topic in `categoryID` whose last post is by `authorID`
// at `lastPostAt`.
//
// The timestamp is an explicit parameter rather than "now" because the whole
// contract is a comparison against it, and a test that cannot place a post in the
// past cannot distinguish "read before the reply" from "read after it".
func seedTopicIn(t testing.TB, app *tests.TestApp, slug, categoryID, authorID string, lastPostAt time.Time) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatalf("topics collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("category_id", categoryID)
	rec.Set("author_id", authorID)
	rec.Set("title", slug)
	rec.Set("posts_count", 1)
	rec.Set("locked", false)
	rec.Set("pinned", false)
	rec.Set("last_post_author_id", authorID)
	rec.Set("last_post_created", lastPostAt)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to create topic %s: %v", slug, err)
	}
	return rec
}

// stampRegistration backdates the caller's account, because registration is the
// floor for "unread" and every fixture account is created moments ago.
//
// It writes SQL rather than going through app.Save on purpose. `created` is an
// autodate field, and PocketBase re-derives it on every save — so the record-based
// version of this helper silently did nothing, and every test built on it passed
// for the wrong reason: the topics really were older than the registration, so the
// count of 0 was correct and the assertion never exercised the predicate. The
// giveaway was three tests failing with "got 0" while three others expecting 0
// passed, which is what a no-op fixture looks like.
func stampRegistration(t testing.TB, app *tests.TestApp, userID string, at time.Time) {
	t.Helper()
	// The stored format is PocketBase's own ("2006-01-02 15:04:05.000Z"), which is
	// what the COUNT compares against as text. Formatting here rather than handing
	// over a time.Time is what keeps the two comparable — a Go default layout would
	// sort wrongly against the column without failing.
	stamp := at.UTC().Format("2006-01-02 15:04:05.000Z")
	if _, err := app.DB().NewQuery(
		"UPDATE " + usersCollectionName + " SET created = {:created} WHERE id = {:id}",
	).Bind(dbx.Params{"created": stamp, "id": userID}).Execute(); err != nil {
		t.Fatalf("failed to backdate %s: %v", userID, err)
	}
}

// unreadTopics reads the count through the real endpoint, so the assertion is on
// the contract the navbar renders rather than on the SQL.
func unreadTopics(t testing.TB, ts *httptest.Server, token string) int {
	t.Helper()
	status, body := getAerunAuthed(t, ts.URL+"/api/aerun/me/unread-counts", token)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	var payload struct {
		UnreadTopics *int `json:"unread_topics"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unread-counts payload is not JSON: %s", body)
	}
	if payload.UnreadTopics == nil {
		t.Fatalf("unread-counts must carry unread_topics — the navbar badge reads it: %s", body)
	}
	return *payload.UnreadTopics
}

// TestUnreadTopicsCountsEveryUnreadTopic is the reason the count left the topic
// list: a page size is not a total.
//
// The old shape fetched `topics?limit=50` and counted what arrived, so a member
// with 60 unread topics was told 50 — a number that looks like an answer and is
// simply wrong, and which nobody could notice without a forum busy enough to
// exceed the cap. Fifty-one is enough.
func TestUnreadTopicsCountsEveryUnreadTopic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	// The member registers, then 51 topics appear.
	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)

	for i := 0; i < 51; i++ {
		seedTopicIn(t, app, "t", publicCat.Id, fixRootID, registered.Add(time.Duration(i+1)*time.Minute))
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 51 {
		t.Fatalf("a member with 51 unread topics must be told 51, not capped: got %d", got)
	}
}

// TestUnreadTopicsFollowsTheMemberAcrossDevices is what the localStorage read map
// could not do: reading on the desktop left the phone's badge untouched, and both
// numbers looked equally authoritative.
func TestUnreadTopicsFollowsTheMemberAcrossDevices(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)
	topic := seedTopicIn(t, app, "unread", publicCat.Id, fixRootID, registered.Add(time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 1 {
		t.Fatalf("expected the topic to start unread, got %d", got)
	}

	// A different browser for the same account: no localStorage, no hint that the
	// first one read anything. Only the server knows.
	status, body := postAerun(t, ts.URL+"/api/aerun/topics/"+topic.Id+"/read", `{}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("marking a topic read must succeed, got %d: %s", status, body)
	}

	if got := unreadTopics(t, ts, tokens["player"]); got != 0 {
		t.Fatalf("a topic the member has read must stop counting, got %d", got)
	}
}

// TestUnreadTopicsIgnoresInvisibleCategories is the reason the count filters by
// canViewCategory instead of counting rows.
//
// A badge larger than the list it summarises is the failure this prevents: the
// topic never appears in /new-replies for this member, so a count that includes
// it cannot be reconciled with anything they can see.
func TestUnreadTopicsIgnoresInvisibleCategories(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	openCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})
	staffCat := newTestCategory(t, app, "staff", []string{"moderator"})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)
	// The moderator reads the OTHER half of the answer below, so their registration
	// needs the same floor — an account created "now" has seen nothing, and both
	// topics predate it.
	stampRegistration(t, app, fixModeratorID, registered)

	seedTopicIn(t, app, "visible", openCat.Id, fixRootID, registered.Add(time.Minute))
	secret := seedTopicIn(t, app, "hidden", staffCat.Id, fixRootID, registered.Add(2*time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 1 {
		t.Fatalf("a topic in a category the member may not read must not count: got %d", got)
	}

	// And it is not writable either: read state for an invisible topic would be a
	// blind write into another category's space.
	status, body := postAerun(t, ts.URL+"/api/aerun/topics/"+secret.Id+"/read", `{}`, tokens["player"])
	if status != http.StatusForbidden {
		t.Fatalf("marking an unreadable topic read must be refused, got %d: %s", status, body)
	}

	// A moderator who CAN read it gets the other half of the answer.
	if got := unreadTopics(t, ts, tokens["moderator"]); got != 2 {
		t.Fatalf("a moderator sees both categories, so both topics: got %d", got)
	}
}

// TestUnreadTopicsIgnoresYourOwnLastPost keeps "I just replied" from counting as
// unread. Without it, posting a reply marks your own topic unread — the badge
// goes up as a result of the member doing exactly what they came to do.
func TestUnreadTopicsIgnoresYourOwnLastPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)

	// Someone else started it; the member has the last word.
	topic := seedTopicIn(t, app, "mine", publicCat.Id, fixRootID, registered.Add(time.Minute))
	topic.Set("last_post_author_id", fixPlayerID)
	topic.Set("last_post_created", registered.Add(2*time.Minute))
	if err := app.Save(topic); err != nil {
		t.Fatalf("failed to reassign last post: %v", err)
	}

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 0 {
		t.Fatalf("a topic whose last post is your own is not unread: got %d", got)
	}
}

// TestUnreadTopicsFloorIsRegistration covers the LEFT JOIN in countUnreadTopics.
//
// A member who has never opened a topic has no read-state row. An inner join
// would drop their topics from the count entirely and report a brand-new member
// as having nothing unread, which is the precise opposite of the truth — and it
// would look correct for anyone who had already read something.
func TestUnreadTopicsFloorIsRegistration(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	registered := time.Now()
	stampRegistration(t, app, fixPlayerID, registered)

	// One topic from before they joined: not unread, they never saw it.
	seedTopicIn(t, app, "ancient", publicCat.Id, fixRootID, registered.Add(-time.Hour))
	// One after: unread.
	seedTopicIn(t, app, "fresh", publicCat.Id, fixRootID, registered.Add(time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 1 {
		t.Fatalf("only the post after registration is unread: got %d", got)
	}
}

// TestMarkAllTopicsReadClearsTheBadge is the bulk path behind the button, which
// used to write localStorage and change nothing the server could see — so the
// number came straight back on the next poll.
func TestMarkAllTopicsReadClearsTheBadge(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)

	first := seedTopicIn(t, app, "one", publicCat.Id, fixRootID, registered.Add(time.Minute))
	second := seedTopicIn(t, app, "two", publicCat.Id, fixRootID, registered.Add(2*time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	if got := unreadTopics(t, ts, tokens["player"]); got != 2 {
		t.Fatalf("expected 2 unread, got %d", got)
	}

	status, body := postAerun(t, ts.URL+"/api/aerun/me/topics/read-all",
		`{"topic_ids":["`+first.Id+`","`+second.Id+`"]}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("mark-all must succeed, got %d: %s", status, body)
	}

	if got := unreadTopics(t, ts, tokens["player"]); got != 0 {
		t.Fatalf("mark-all must clear the badge, got %d", got)
	}
}

// TestMarkAllTopicsReadRefusesInvisibleCategories pins the refusal over the skip.
//
// Skipping an unreadable id would return 200 and leave that category's read state
// untouched, so the button would report "read everything" having not looked at
// all. A 403 is the honest answer.
func TestMarkAllTopicsReadRefusesInvisibleCategories(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	openCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})
	staffCat := newTestCategory(t, app, "staff", []string{"moderator"})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)
	mine := seedTopicIn(t, app, "mine", openCat.Id, fixRootID, registered.Add(time.Minute))
	secret := seedTopicIn(t, app, "hidden", staffCat.Id, fixRootID, registered.Add(2*time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	status, _ := postAerun(t, ts.URL+"/api/aerun/me/topics/read-all",
		`{"topic_ids":["`+mine.Id+`","`+secret.Id+`"]}`, tokens["player"])
	if status != http.StatusForbidden {
		t.Fatalf("expected 403 when one topic is in an unreadable category, got %d", status)
	}
}

// TestMarkTopicReadRequiresAuthentication keeps the read-state routes out of the
// guest surface: a guest read map would be a per-visitor store with no account
// behind it, which is the shape guest_presence already exists for.
func TestMarkTopicReadRequiresAuthentication(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})
	topic := seedTopicIn(t, app, "t", publicCat.Id, fixRootID, time.Now())

	ts := newTestServer(t, app)
	defer ts.Close()

	if status, _ := postAerun(t, ts.URL+"/api/aerun/topics/"+topic.Id+"/read", `{}`, ""); status != http.StatusForbidden {
		t.Fatalf("an anonymous read must be refused, got %d", status)
	}
	if status, _ := postAerun(t, ts.URL+"/api/aerun/me/topics/read-all", `{}`, ""); status != http.StatusForbidden {
		t.Fatalf("an anonymous mark-all must be refused, got %d", status)
	}
}

// TestForumIndexCarriesServerUnreadFlag is the Sprint-4 verification: the main
// index renders its last-post dot from the SERVER read-state, not from the
// localStorage read map.
//
// Before this the index dot and the navbar badge were fed by two different
// sources, so "mark all read" could zero the badge while leaving category rows
// lit — the exact symptom reported (a 0 badge with rows still marked new).
// listForumIndexHandler now stamps every category row with `unread` from the
// SAME unreadTopicIDs the badge and the /new-replies feed read, so the three
// surfaces cannot drift. This asserts that through the real endpoint, for a
// member AND for a guest, and that reading the topic flips the flag with no
// reload.
func TestForumIndexCarriesServerUnreadFlag(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	publicCat := newTestCategory(t, app, "open", []string{auth.CategoryInheritMarker})

	registered := time.Now().Add(-time.Hour)
	stampRegistration(t, app, fixPlayerID, registered)
	topic := seedTopicIn(t, app, "unread", publicCat.Id, fixRootID, registered.Add(time.Minute))

	ts := newTestServer(t, app)
	defer ts.Close()

	// unreadFlag reads the forum index and returns the per-category `unread`
	// pointer for the seeded category, or nil when the key was absent (the guest
	// case). A pointer, not a bool, so "no server opinion" and "server says
	// false" stay distinguishable — the whole reason the flag is omitted rather
	// than sent as false for a guest.
	unreadFlag := func(token string) *bool {
		t.Helper()
		var (
			status int
			body   []byte
		)
		if token == "" {
			status, body = getAerun(t, ts.URL+"/api/aerun/forum-index")
		} else {
			status, body = getAerunAuthed(t, ts.URL+"/api/aerun/forum-index", token)
		}
		if status != http.StatusOK {
			t.Fatalf("forum-index must answer 200, got %d: %s", status, body)
		}
		var payload struct {
			Items []struct {
				ID              string `json:"id"`
				LastPostTopicID string `json:"last_post_topic_id"`
				Unread          *bool  `json:"unread"`
			} `json:"items"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("forum-index payload is not JSON: %s", body)
		}
		for _, item := range payload.Items {
			if item.ID == publicCat.Id {
				if item.LastPostTopicID != topic.Id {
					t.Fatalf("forum-index last_post_topic_id = %q, want %q — the row must name the topic it summarises", item.LastPostTopicID, topic.Id)
				}
				return item.Unread
			}
		}
		t.Fatalf("seeded category %s missing from forum-index: %s", publicCat.Id, body)
		return nil
	}

	// A guest index carries no opinion: `unread` is absent, not false.
	if flag := unreadFlag(""); flag != nil {
		t.Fatalf("a guest index must omit unread, got %v", *flag)
	}

	// The member sees the topic as unread — the SAME predicate the badge reads.
	if flag := unreadFlag(tokens["player"]); flag == nil || !*flag {
		t.Fatalf("a member with an unread last-post topic must see unread=true on the index")
	}

	// Reading the last-post topic through the real endpoint must flip the index
	// flag off with no reload: this is the half of "mark all read" that used to
	// leave the row lit because the index read localStorage, which read-all
	// never touched for that topic.
	status, body := postAerun(t, ts.URL+"/api/aerun/topics/"+topic.Id+"/read", `{}`, tokens["player"])
	if status != http.StatusOK {
		t.Fatalf("marking the topic read must succeed, got %d: %s", status, body)
	}
	if flag := unreadFlag(tokens["player"]); flag == nil || *flag {
		t.Fatalf("after reading the last-post topic, the index must report unread=false, got %v", flag)
	}
}

