package pocketbase

// Regression tests for the residue left behind by a deletion, ported from the
// 2026-09-30 production incident (main: abed3e8 + be6ca82).
//
// The incident had two halves. The first (abed3e8) was the trigger itself:
// deleting a post on page 2+ took the topic-delete branch and destroyed the
// whole topic. The second (be6ca82) was worse in a quieter way — once the
// delete went through, everything DENORMALIZED around it was left pointing at
// content that no longer existed:
//
//   - users.post_count was never decremented for the destroyed posts, because
//     the trigger that owned the decrement returned early once the topic
//     document was gone;
//   - reputation_logs survived, so members kept reputation earned on posts
//     that no longer existed and the logs pointed at dead post_ids;
//   - topic_subscriptions leaked;
//   - the revert had no at-least-once guard, so redelivering it applied it twice.
//
// These tests pin the Go equivalents. The Go layer soft-deletes instead of
// cascading, so there is no data loss here — but a soft-deleted topic is still
// invisible to every read path (canViewTopic refuses it), which makes "the rows
// are still there" a worse answer than it sounds: they are unreachable, so
// nothing that reads them will ever reconcile them.
//
// NOT VERIFIED: `go` is not installed on the machine where these tests were
// written, so they are UNCOMPILED. Run `go build ./... && go test ./...` before
// relying on them.

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedResidueFixture builds a live topic with two posts by DIFFERENT authors.
//
// Two authors is the point: the Firestore bug was a decrement that had no
// owner, and a single-author fixture cannot tell "decremented once" apart from
// "moved somebody else's counter by accident".
func seedResidueFixture(t testing.TB, app *tests.TestApp, firstAuthor, secondAuthor string) (topicID, firstPostID, replyPostID string) {
	t.Helper()

	catID := getGeneralCategoryID(t, app)

	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", firstAuthor)
	topic.Set("title", "Residue Fixture")
	topic.Set("posts_count", 2)
	topic.Set("deleted", false)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	mk := func(seq int, author, body string) *core.Record {
		p := core.NewRecord(postsCol)
		p.Set("topic_id", topic.Id)
		p.Set("author_id", author)
		p.Set("sequence", seq)
		p.Set("content", body)
		p.Set("deleted", false)
		p.Set("is_draft", false)
		if err := app.Save(p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	first := mk(1, firstAuthor, "Opening post")
	reply := mk(2, secondAuthor, "A reply by somebody else")

	return topic.Id, first.Id, reply.Id
}

// castPostVote writes a reputation_votes row directly and moves the cached
// totals to match, so the fixture looks exactly like one the vote command would
// have produced. Writing only the vote row would leave the row and the cache
// disagreeing, and the test would prove nothing about the delta.
func castPostVote(t testing.TB, app *tests.TestApp, voterID, targetID, postID, topicID string, value int) {
	t.Helper()

	votesCol, err := app.FindCollectionByNameOrId(reputationVotesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	vote := core.NewRecord(votesCol)
	vote.Set("voter_id", voterID)
	vote.Set("target_id", targetID)
	vote.Set("post_id", postID)
	vote.Set("topic_id", topicID)
	vote.Set("value", value)
	vote.Set("comment", "")
	if err := app.Save(vote); err != nil {
		t.Fatal(err)
	}

	target, err := app.FindRecordById(usersCollectionName, targetID)
	if err != nil || target == nil {
		t.Fatalf("vote target missing: %v", err)
	}
	target.Set("reputation", target.GetInt("reputation")+value)
	if err := app.Save(target); err != nil {
		t.Fatal(err)
	}

	if postID == "" {
		return
	}
	post, err := app.FindRecordById(postsCollectionName, postID)
	if err != nil || post == nil {
		t.Fatalf("voted post missing: %v", err)
	}
	post.Set("reputation", post.GetInt("reputation")+value)
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}
}

func subscribeUserToTopic(t testing.TB, app *tests.TestApp, userID, topicID string) {
	t.Helper()

	subsCol, err := app.FindCollectionByNameOrId(topicSubscriptionsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	sub := core.NewRecord(subsCol)
	sub.Set("topic_id", topicID)
	sub.Set("user_id", userID)
	if err := app.Save(sub); err != nil {
		t.Fatal(err)
	}
}

func userCounter(t testing.TB, app *tests.TestApp, userID, field string) int {
	t.Helper()
	user, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || user == nil {
		t.Fatalf("user %s missing: %v", userID, err)
	}
	return user.GetInt(field)
}

func countRows(t testing.TB, app *tests.TestApp, collection, exp string, params map[string]any) int {
	t.Helper()
	rows, err := app.FindAllRecords(collection, dbx.NewExp(exp, params))
	if err != nil {
		t.Fatal(err)
	}
	return len(rows)
}

// TestDeleteTopicRevertsReputationAndCleansResidue is the Go port of the
// be6ca82 regression test. Deleting a topic must not leave members holding
// reputation for posts the forum can no longer show.
//
// The topic carries a +3 pair of post votes AND a separate -1 profile vote for
// the same author, so a handler that pays back the whole reputation column
// fails just as loudly as one that forgets to pay anything back — and one that
// clamps at zero would also fail, because the correct answer is negative.
func TestDeleteTopicRevertsReputationAndCleansResidue(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, firstPostID, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	castPostVote(t, app, fixPendingID, fixPlayerID, firstPostID, topicID, 1)
	castPostVote(t, app, fixBannedID, fixPlayerID, firstPostID, topicID, 2)
	castPostVote(t, app, fixBannedID, fixPlayerID, "", "", -1) // profile vote: must NOT be reverted
	subscribeUserToTopic(t, app, fixPlayerID, topicID)
	subscribeUserToTopic(t, app, fixPendingID, topicID)

	if got := userCounter(t, app, fixPlayerID, "reputation"); got != 2 {
		t.Fatalf("fixture reputation = %d, want 2 (1 + 2 post votes, -1 profile vote)", got)
	}

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "topic-delete-residue")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 deleting the topic, got %d", res.StatusCode)
	}

	// Only the two post votes (+3) are paid back, leaving the profile vote's -1.
	// This is the assertion that catches both "paid nothing" and "clamped to 0".
	if got := userCounter(t, app, fixPlayerID, "reputation"); got != -1 {
		t.Errorf("reputation after topic delete = %d, want -1 (only the profile vote remains)", got)
	}

	// The post vote rows are KEPT — a soft delete must stay reversible — so what
	// matters is that the recompute no longer counts them. If it did, the next
	// run would hand the reputation straight back and the drift would return,
	// which is how be6ca82's manual repairs were undone.
	postVotes, err := app.FindAllRecords(
		reputationVotesCollectionName,
		dbx.NewExp("post_id = {:p}", dbx.Params{"p": firstPostID}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(postVotes) != 2 {
		t.Errorf("vote rows must survive a soft delete so it stays reversible, got %d", len(postVotes))
	}

	// Subscriptions, by contrast, are hard-deleted: they pin a hidden topic id
	// in the member's list and the member cannot unsubscribe from a topic the
	// API will not serve.
	if n := countRows(t, app, topicSubscriptionsCollectionName, "topic_id = {:t}", map[string]any{"t": topicID}); n != 0 {
		t.Errorf("expected subscriptions to be cleaned up, %d remain", n)
	}

	// The posts survive the soft delete — that is the recoverability win over
	// Firestore — so this asserts we did NOT cascade.
	if n := countRows(t, app, postsCollectionName, "topic_id = {:t}", map[string]any{"t": topicID}); n != 2 {
		t.Errorf("posts must survive a soft delete, got %d", n)
	}

	// And the repair tool agrees with the payout: run against the same database
	// it must derive the same reputation the command just wrote, instead of
	// handing +3 straight back because the vote rows are still there.
	report, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Values[fixPlayerID].Rep; got != -1 {
		t.Errorf("recomputed reputation = %d, want -1 (the recompute must agree with the payout)", got)
	}
}

// TestDeletePostRevertsReputation covers the same lesson one post at a time. A
// soft-deleted post is a tombstone the UI never renders, so its votes must not
// keep paying the author.
func TestDeletePostRevertsReputation(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, replyPostID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	// The reply belongs to the pending account, so the payout targets somebody
	// other than the caller — the caller is a moderator deleting it here.
	castPostVote(t, app, fixPlayerID, fixPendingID, replyPostID, topicID, 5)
	if got := userCounter(t, app, fixPendingID, "reputation"); got != 5 {
		t.Fatalf("fixture reputation = %d, want 5", got)
	}

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, replyPostID), nil)
	req.Header.Set("Authorization", tokens["moderator"])
	req.Header.Set("Idempotency-Key", "post-delete-residue")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 deleting a reply, got %d", res.StatusCode)
	}

	if got := userCounter(t, app, fixPendingID, "reputation"); got != 0 {
		t.Errorf("reputation after post delete = %d, want 0 (the vote was on a deleted post)", got)
	}

	// The vote row survives (soft delete), but the repair tool must no longer
	// count it — otherwise the next recompute hands the score back.
	report, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Values[fixPendingID].Rep; got != 0 {
		t.Errorf("recomputed reputation = %d, want 0 (a vote on a deleted post must not count)", got)
	}

	// The tombstone's own per-post total must not keep displaying a score that
	// no longer exists anywhere else.
	post, err := app.FindRecordById(postsCollectionName, replyPostID)
	if err != nil || post == nil {
		t.Fatalf("deleted post missing: %v", err)
	}
	if got := post.GetInt("reputation"); got != 0 {
		t.Errorf("tombstone reputation = %d, want 0", got)
	}
}

// TestDeleteTopicPaysBackReputationExactlyOnce pins the exactly-once property
// that be6ca82 had to add a reputation_reverts/{logId} claim document for.
//
// The second attempt deliberately carries a DIFFERENT idempotency key: the
// protection is not the key, it is the absence of the vote rows. A handler that
// relied only on the claim would still be at the mercy of any second delivery,
// which is precisely how the Firestore revert got applied twice.
func TestDeleteTopicPaysBackReputationExactlyOnce(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, firstPostID, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	castPostVote(t, app, fixPendingID, fixPlayerID, firstPostID, topicID, 4)

	// The author deletes their own topic, so the topic-count decrement and the
	// reputation payback happen to the same row and must not be conflated.
	server := newTestServer(t, app)
	defer server.Close()

	deleteTopic := func(key string) int {
		req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
		req.Header.Set("Authorization", tokens["player"])
		req.Header.Set("Idempotency-Key", key)
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}

	if code := deleteTopic("replay-delete-1"); code != http.StatusOK {
		t.Fatalf("first delete = %d, want 200", code)
	}
	if got := userCounter(t, app, fixPlayerID, "reputation"); got != 0 {
		t.Fatalf("reputation after first delete = %d, want 0", got)
	}

	// Already a tombstone, so this must not report a fresh success...
	if code := deleteTopic("replay-delete-2"); code == http.StatusOK {
		t.Errorf("a second delete of the same topic must not report success")
	}
	// ...and above all it must not pay the payout twice.
	if got := userCounter(t, app, fixPlayerID, "reputation"); got != 0 {
		t.Errorf("reputation after replay = %d, want 0 (the payback must happen exactly once)", got)
	}
}

// TestRecomputeAgreesWithTopicPayout pins that the repair tool and the command
// layer derive the SAME reputation. This is the invariant that keeps be6ca82's
// drift from coming back: the payout runs once at delete time, and every later
// recompute must reproduce it rather than re-granting the score.
//
// Note what is deliberately NOT asserted: post counts do not drop to zero. A
// soft-deleted topic keeps its post rows and migration 1767100000 defines
// posts_count as counting rows that still exist, so those posts stay counted.
// Only the reputation — the thing the delete paid back — must agree.
func TestRecomputeAgreesWithTopicPayout(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// One call, both uses: the fixtures are what makes "player" a valid token.
	tokens := seedIdentityFixtures(t, app)
	topicID, firstPostID, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	castPostVote(t, app, fixBannedID, fixPlayerID, firstPostID, topicID, 6)

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "recompute-agrees-delete")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d, want 200", res.StatusCode)
	}

	cached := userCounter(t, app, fixPlayerID, "reputation")
	if cached != 0 {
		t.Fatalf("cached reputation after delete = %d, want 0", cached)
	}

	// A real run, not a dry one: it writes what it derives, so if it disagreed
	// with the payout the persisted column would change and the next assertion
	// would catch it.
	if _, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := userCounter(t, app, fixPlayerID, "reputation"); got != 0 {
		t.Errorf("reputation after recompute = %d, want 0 (the recompute re-granted what the delete paid back)", got)
	}

	// Idempotent once more: a second run has nothing left to change, which is
	// what makes the pass safe to point at production.
	second, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("the second recompute changed %d users; the two passes disagree", len(second.Updated))
	}
}

// TestMovePostCarriesItsVotes guards rule 8: a move must carry the denormalized
// copies too.
//
// movePostsHandler re-sequenced the post and re-pointed post.topic_id, but left
// reputation_votes.topic_id on the old topic. That is invisible on its own and
// only becomes a bug through the delete path: purgeTopicResidue pays reputation
// back by summing the votes of the topic being deleted, so after a move the
// SOURCE topic would pay out for a post that now lives in the target — twice
// over, once wrongly and once never.
func TestMovePostCarriesItsVotes(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	sourceID, _, replyPostID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	castPostVote(t, app, fixBannedID, fixPendingID, replyPostID, sourceID, 3)

	// A second topic to move into.
	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	target := core.NewRecord(topicsCol)
	target.Set("category_id", getGeneralCategoryID(t, app))
	target.Set("author_id", fixPlayerID)
	target.Set("title", "Move Target")
	target.Set("posts_count", 1)
	target.Set("deleted", false)
	if err := app.Save(target); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	body := strings.NewReader(fmt.Sprintf(`{"target_topic_id":%q,"post_ids":[%q]}`, target.Id, replyPostID))
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/aerun/topics/%s/posts/move", server.URL, sourceID), body)
	req.Header.Set("Authorization", tokens["moderator"])
	req.Header.Set("Idempotency-Key", "move-carries-votes")
	req.Header.Set("Content-Type", "application/json")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("move = %d, want 200", res.StatusCode)
	}

	moved, err := app.FindRecordById(postsCollectionName, replyPostID)
	if err != nil || moved == nil {
		t.Fatalf("moved post missing: %v", err)
	}
	if moved.GetString("topic_id") != target.Id {
		t.Fatalf("post.topic_id = %s, want %s", moved.GetString("topic_id"), target.Id)
	}

	votes, err := app.FindAllRecords(
		reputationVotesCollectionName,
		dbx.NewExp("post_id = {:p}", dbx.Params{"p": replyPostID}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(votes) != 1 {
		t.Fatalf("expected the vote to travel with the post, got %d rows", len(votes))
	}
	if got := votes[0].GetString("topic_id"); got != target.Id {
		t.Errorf("vote.topic_id = %s, want %s (a stale copy makes the wrong topic pay out on delete)", got, target.Id)
	}
}
