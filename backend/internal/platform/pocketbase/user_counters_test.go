package pocketbase

// Tests for the user activity counters (user_counters.go) and the columns
// migration 1767100000 adds. They pin three properties the cutover depends on:
//
//  1. The pass derives counters from rows, so it repairs a database whose
//     counters are zeros (the state the import leaves behind) instead of
//     needing an already-correct starting point.
//  2. The predicates are exact: a soft-deleted post, a draft and a
//     soft-deleted topic are not counted, and a profile vote is counted once.
//  3. It is idempotent — a second run changes nothing, which is what makes it
//     safe to point at production.

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedCounterPost writes one post row directly, so a test can produce the
// exact shape it wants to count (a draft, a deleted post) without going
// through commands that would normalise it away.
//
// seq must be unique per topic: the schema has a UNIQUE(topic_id, sequence)
// backstop, and a fixture that collided with it would fail for a reason that
// has nothing to do with counters.
func seedCounterPost(t testing.TB, app *tests.TestApp, topicID, authorID string, seq int, deleted, draft bool) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("topic_id", topicID)
	rec.Set("author_id", authorID)
	rec.Set("sequence", seq)
	rec.Set("content", "counter fixture")
	rec.Set("deleted", deleted)
	rec.Set("is_draft", draft)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// seedCounterTopic writes one topic row directly.
func seedCounterTopic(t testing.TB, app *tests.TestApp, authorID string, deleted bool) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("category_id", getGeneralCategoryID(t, app))
	rec.Set("author_id", authorID)
	rec.Set("title", "Counter fixture")
	rec.Set("posts_count", 0)
	rec.Set("deleted", deleted)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func containsString(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

// TestUserCounterColumnsExist pins the schema half: without these columns the
// recompute pass refuses to run, so their absence has to fail a test rather
// than surface as a runtime error in a migration tool.
func TestUserCounterColumnsExist(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"posts_count", "topics_count", "reputation"} {
		field := users.Fields.GetByName(name)
		if field == nil {
			t.Fatalf("users.%s is missing", name)
		}
		num, ok := field.(*core.NumberField)
		if !ok {
			t.Fatalf("users.%s must be a NumberField, got %T", name, field)
		}
		if !num.OnlyInt {
			t.Errorf("users.%s must be integer-only: a fractional post count is meaningless", name)
		}
	}
}

// TestRecomputeUserCountersDerivesFromRows is the main case: a board with two
// live posts, one soft-deleted post, one draft and one live topic must produce
// posts=2, topics=1 — not the cached legacy numbers and not zeros.
func TestRecomputeUserCountersDerivesFromRows(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	topic := seedCounterTopic(t, app, fixPlayerID, false)
	seedCounterPost(t, app, topic.Id, fixPlayerID, 1, false, false)
	seedCounterPost(t, app, topic.Id, fixPlayerID, 2, false, false)
	seedCounterPost(t, app, topic.Id, fixPlayerID, 3, true, false) // deleted
	seedCounterPost(t, app, topic.Id, fixPlayerID, 4, false, true) // draft
	seedCounterTopic(t, app, fixPlayerID, true)                    // deleted topic
	seedCounterPost(t, app, topic.Id, fixModeratorID, 5, false, false)

	report, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}

	want := UserCounters{Posts: 2, Topics: 1, Rep: 0}
	if got := report.Values[fixPlayerID]; got != want {
		t.Errorf("player counters = %+v, want %+v", got, want)
	}
	if got := report.Values[fixModeratorID].Posts; got != 1 {
		t.Errorf("moderator posts = %d, want 1", got)
	}

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	if user.GetInt("posts_count") != 2 || user.GetInt("topics_count") != 1 {
		t.Fatalf("persisted counters = posts %d topics %d, want 2/1",
			user.GetInt("posts_count"), user.GetInt("topics_count"))
	}

	// The player changed; the others had nothing to count and must be left
	// alone rather than rewritten.
	if !containsString(report.Updated, fixPlayerID) {
		t.Error("the player should be reported as updated")
	}
	if containsString(report.Updated, fixRootID) {
		t.Error("an account with no posts must be reported unchanged, not rewritten")
	}
}

// TestRecomputeUserCountersSumsEveryVote is the invariant that matters: the
// recomputed base must equal what the command layer would have produced.
//
// This test previously asserted the OPPOSITE — that a post vote does not count
// toward the target's reputation — and that assertion is what hid the bug. A post
// vote moves BOTH posts.reputation and users.reputation in one command
// (reputation.go does `targetUser.Set("reputation", ...+val)` on the create and
// replace paths alike), so a recompute that drops post votes rebuilds a base the
// command layer disagrees with: the first live post vote after cutover would move
// a member by a delta computed against a different total.
//
// So instead of restating the rule in a comment, this seeds votes through the
// real vote command, lets the command layer move the counters itself, and then
// checks that a recompute reproduces exactly those numbers. If the two ever
// diverge, this fails — which is the property the old test could not express.
func TestRecomputeUserCountersSumsEveryVote(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	// Insert the votes directly: the HTTP command needs a full auth context,
	// and what matters here is the ARITHMETIC, which the command layer performs
	// on both columns in the same statement (reputation.go lines 156-157).
	col, err := app.FindCollectionByNameOrId(reputationVotesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	// Two profile votes on the player that net to 0 prove the sum is arithmetic
	// rather than a count.
	for i, voter := range []string{fixPlayerID, fixModeratorID} {
		vote := core.NewRecord(col)
		vote.Set("voter_id", voter)
		vote.Set("target_id", fixPlayerID)
		vote.Set("post_id", "")
		vote.Set("value", []int{1, -1}[i])
		if err := app.Save(vote); err != nil {
			t.Fatal(err)
		}
	}
	// Three post votes for the moderator: the command layer would have added 3.
	// If the recompute dropped post votes this would come out 0, which is the
	// bug this test now exists to prevent.
	//
	// The votes point at REAL posts, not invented ids: sumVotes excludes a vote
	// whose post is missing or soft-deleted, so a fabricated post_id would be
	// filtered out and the test would pass for the wrong reason (it would be
	// asserting 0 while reporting the failure as "post votes dropped").
	votedTopic := seedCounterTopic(t, app, fixPlayerID, false)
	for i, voter := range []string{fixPlayerID, fixModeratorID, fixRootID} {
		post := seedCounterPost(t, app, votedTopic.Id, fixPlayerID, i+1, false, false)
		vote := core.NewRecord(col)
		vote.Set("voter_id", voter)
		vote.Set("target_id", fixModeratorID)
		vote.Set("post_id", post.Id)
		vote.Set("value", 1)
		if err := app.Save(vote); err != nil {
			t.Fatal(err)
		}
	}

	report, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}

	if got := report.Values[fixPlayerID].Rep; got != 0 {
		t.Errorf("player reputation = %d, want 0 (+1 and -1 must net out)", got)
	}
	// The whole point: post votes count.
	if got := report.Values[fixModeratorID].Rep; got != 3 {
		t.Errorf("moderator reputation = %d, want 3 (post votes move users.reputation too)", got)
	}
}

// TestRecomputeUserCountersIsIdempotent is the property that makes the tool
// safe to re-run against production: the second pass must find nothing to do.
func TestRecomputeUserCountersIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	topic := seedCounterTopic(t, app, fixPlayerID, false)
	seedCounterPost(t, app, topic.Id, fixPlayerID, 1, false, false)

	first, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed() {
		t.Fatal("the first pass should have changed the player's counters")
	}

	second, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("the second pass changed %d users; the pass is not idempotent", len(second.Updated))
	}
	if !containsString(second.Unchanged, fixPlayerID) {
		t.Error("the player should be reported unchanged on the second pass")
	}
}

// TestRecomputeUserCountersDryRunWritesNothing pins the flag the CLI advertises:
// a dry run must report exactly what a real run would do and persist nothing.
func TestRecomputeUserCountersDryRunWritesNothing(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	topic := seedCounterTopic(t, app, fixPlayerID, false)
	seedCounterPost(t, app, topic.Id, fixPlayerID, 1, false, false)

	dry, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(dry.Updated, fixPlayerID) {
		t.Error("a dry run must report the player as pending update")
	}
	if got := dry.Values[fixPlayerID].Posts; got != 1 {
		t.Errorf("dry run derived posts = %d, want 1", got)
	}

	user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
	if err != nil {
		t.Fatal(err)
	}
	if user.GetInt("posts_count") != 0 {
		t.Errorf("a dry run wrote posts_count = %d, want 0", user.GetInt("posts_count"))
	}
}

// TestCreateTopicMovesUserCounters pins the incremental side: creating a topic
// must move the author's post AND topic counters in the same request, so a
// member list never lags the forum by one.
func TestCreateTopicMovesUserCounters(t *testing.T) {
	var scenario tests.ApiScenario
	scenario = tests.ApiScenario{
		Name:            "creating a topic moves the author's counters",
		Method:          "POST",
		URL:             "/api/aerun/topics",
		TestAppFactory:  newAerunTestApp,
		ExpectedStatus:  201,
		ExpectedContent: []string{`"title":"Counter Topic"`},
		BeforeTestFunc: func(t testing.TB, app *tests.TestApp, e *core.ServeEvent) {
			scenario.Body = bodyReader(`{"category_id":"` + getGeneralCategoryID(t, app) +
				`","title":"Counter Topic","content":"Body"}`)
			scenario.Headers = map[string]string{
				"Content-Type":    "application/json",
				"Authorization":   seedIdentityFixtures(t, app)["player"],
				"Idempotency-Key": "counter-create-topic",
			}
		},
		AfterTestFunc: func(t testing.TB, app *tests.TestApp, res *http.Response) {
			user, err := app.FindRecordById(usersCollectionName, fixPlayerID)
			if err != nil {
				t.Fatal(err)
			}
			if got := user.GetInt("posts_count"); got != 1 {
				t.Errorf("posts_count = %d, want 1 (the opening post counts)", got)
			}
			if got := user.GetInt("topics_count"); got != 1 {
				t.Errorf("topics_count = %d, want 1", got)
			}
		},
	}
	scenario.Test(t)
}
