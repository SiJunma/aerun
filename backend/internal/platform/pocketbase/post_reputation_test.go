package pocketbase

// Tests for the post reputation recompute (post-import pass).
//
// posts.reputation is derived data. The importer's own comment on
// PostRow.Reputation has always said "recomputed from the votes, never copied"
// while the code did the opposite — so these tests exist to hold the pass to the
// comment, not to restate it.

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func seedVote(t *testing.T, app core.App, voter, target, postID string, value int) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(reputationVotesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	vote := core.NewRecord(col)
	vote.Set("voter_id", voter)
	vote.Set("target_id", target)
	vote.Set("post_id", postID)
	vote.Set("value", value)
	if err := app.Save(vote); err != nil {
		t.Fatal(err)
	}
}

// seedPost creates a real post row. The pass keys its report on the posts that
// EXIST, not on the votes: a vote naming a post nobody wrote is a vote the
// importer would have dropped, and a recompute that invented a score for it
// would be reporting a row that is not in the database.
//
// topicID and sequence are parameters because posts carry UNIQUE(topic_id,
// sequence) for sequence > 0 — a helper that hard-coded either would make every
// test needing two posts fail on the index instead of on what it means to check.
func seedPost(t *testing.T, app core.App, topicID, authorID string, sequence, reputation int) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(col)
	post.Set("topic_id", topicID)
	post.Set("author_id", authorID)
	post.Set("sequence", sequence)
	post.Set("content", "content")
	post.Set("reputation", reputation)
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}
	return post
}

// TestRecomputePostReputationSumsVotesOnThatPost is the base case: a post's score
// is the sum of the votes that name it.
func TestRecomputePostReputationSumsVotesOnThatPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	post1 := seedPost(t, app, "topicmissing001", fixPlayerID, 1, 0)
	post2 := seedPost(t, app, "topicmissing001", fixPlayerID, 2, 0)

	seedVote(t, app, fixPlayerID, fixModeratorID, post1.Id, 1)
	seedVote(t, app, fixRootID, fixModeratorID, post1.Id, 1)
	seedVote(t, app, fixPlayerID, fixRootID, post2.Id, -1)

	report, err := RecomputePostReputation(app, PostReputationRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Values[post1.Id]; got != 2 {
		t.Errorf("post 1 reputation = %d, want 2", got)
	}
	if got := report.Values[post2.Id]; got != -1 {
		t.Errorf("post 2 reputation = %d, want -1", got)
	}
}

// TestRecomputePostReputationIgnoresProfileVotes pins the boundary. A profile
// vote moves users.reputation and names no post; counting it here would invent a
// post score for a post that does not exist.
func TestRecomputePostReputationIgnoresProfileVotes(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	seedVote(t, app, fixPlayerID, fixModeratorID, "", 1)
	seedVote(t, app, fixRootID, fixModeratorID, "", -1)

	report, err := RecomputePostReputation(app, PostReputationRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for id, score := range report.Values {
		if score != 0 {
			t.Errorf("post %s reputation = %d, want 0 (profile votes belong to the user)", id, score)
		}
	}
}

// TestRecomputePostReputationClearsAStaleCachedScore is the property the whole
// pass exists for. The importer used to copy the legacy cached score, so a post
// could sit next to its votes showing a number those votes do not produce. A post
// with no votes must therefore be driven to zero, not left alone.
func TestRecomputePostReputationClearsAStaleCachedScore(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)

	col, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(col)
	post.Set("topic_id", "topicmissing001")
	post.Set("author_id", fixPlayerID)
	post.Set("sequence", 1)
	post.Set("content", "legacy text")
	// A cached score the votes below do not support.
	post.Set("reputation", 7)
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}

	seedVote(t, app, fixRootID, fixPlayerID, post.Id, 1)

	report, err := RecomputePostReputation(app, PostReputationRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Values[post.Id]; got != 1 {
		t.Fatalf("derived score = %d, want 1 (the single vote, not the cached 7)", got)
	}

	stored, err := app.FindRecordById(postsCollectionName, post.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := stored.GetInt("reputation"); got != 1 {
		t.Errorf("stored reputation = %d, want 1", got)
	}
}

// TestRecomputePostReputationIsIdempotent makes the pass safe to re-run against
// production: the second run must find nothing to do.
func TestRecomputePostReputationIsIdempotent(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	post := seedPost(t, app, "topicmissing001", fixPlayerID, 1, 0)
	seedVote(t, app, fixPlayerID, fixModeratorID, post.Id, 1)

	// First run writes the derived score.
	if _, err := RecomputePostReputation(app, PostReputationRecomputeOptions{}); err != nil {
		t.Fatal(err)
	}
	second, err := RecomputePostReputation(app, PostReputationRecomputeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("second run changed %d posts, want 0", len(second.Updated))
	}
}

// TestRecomputePostReputationDryRunWritesNothing pins the flag the CLI advertises.
func TestRecomputePostReputationDryRunWritesNothing(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	post := seedPost(t, app, "topicmissing001", fixPlayerID, 1, 0)
	seedVote(t, app, fixPlayerID, fixModeratorID, post.Id, 1)

	report, err := RecomputePostReputation(app, PostReputationRecomputeOptions{DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	// A dry run DOES populate Updated — that list is the whole point of the flag:
	// it is what a real run would write. What it must not do is persist anything.
	if len(report.Updated) == 0 {
		t.Error("a dry run must still report what a real run would do")
	}
	stored, err := app.FindRecordById(postsCollectionName, post.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := stored.GetInt("reputation"); got != 0 {
		t.Errorf("a dry run wrote reputation=%d, want 0 (nothing was persisted)", got)
	}
}
