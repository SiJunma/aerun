package importer

// Tests for the L7 engagement plan (reputation votes + topic subscriptions).
//
// The properties under test are the ones that change what a reader sees: which
// unique index a vote lands under, and what happens to a vote whose references do
// not resolve.

import (
	"testing"
	"time"
)

func engagementFixture() *ImportPlan {
	return &ImportPlan{
		ReputationLogs: map[string]map[string]any{},
		Subscriptions:  map[string]map[string]any{},
	}
}

// existsAlways stands in for a reference predicate when every legacy id resolves.
func existsAlways(string) bool { return true }

// existsExcept is a predicate that resolves everything except the named ids —
// the honest way to model "this account never imported" without inventing a
// second mechanism.
func existsExcept(missing ...string) func(string) bool {
	gone := make(map[string]bool, len(missing))
	for _, id := range missing {
		gone[id] = true
	}
	return func(id string) bool { return !gone[id] }
}
func at(sec int64) time.Time { return time.Unix(sec, 0).UTC() }

func findVote(t *testing.T, ep *EngagementPlan, legacyID string) ReputationVoteRow {
	t.Helper()
	for _, v := range ep.VoteRows {
		if v.LegacyID == legacyID {
			return v
		}
	}
	t.Fatalf("vote %s was not planned", legacyID)
	return ReputationVoteRow{}
}

// TestVoteLandsUnderThePostIndex pins which of the two unique indexes a vote
// selects. post_id != ” means UNIQUE(voter_id, post_id); post_id = ” means
// UNIQUE(voter_id, target_id). Getting this wrong does not error — it silently
// applies the wrong uniqueness to a user's votes.
func TestVoteLandsUnderThePostIndex(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_post"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "p1", "topic_id": "t1",
		"value": float64(1), "created_at": at(100),
	}
	plan.ReputationLogs["v_profile"] = map[string]any{
		"voter_id": "u1", "target_id": "u3", "post_id": "", "topic_id": "",
		"value": float64(-1), "created_at": at(100),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	post := findVote(t, ep, "v_post")
	if post.PostID != DeriveID(SpacePost, "p1") {
		t.Fatalf("a post vote must carry the post id, got %q", post.PostID)
	}
	if post.TopicID != DeriveID(SpaceTopic, "t1") {
		t.Fatalf("a post vote must carry its topic, got %q", post.TopicID)
	}

	profile := findVote(t, ep, "v_profile")
	if profile.PostID != "" {
		t.Fatalf("a profile vote must carry an empty post id, got %q", profile.PostID)
	}
	if profile.TargetUserID != DeriveID(SpaceUser, "u3") {
		t.Fatalf("a profile vote targets the profile, got %q", profile.TargetUserID)
	}
}

// TestNullReferenceIsAbsentNotPresent is the regression test for a decoder bug
// this planner inherited.
//
// A JSON null decodes to a Go nil. The shared stringField used to format that
// with %v, producing the literal string "<nil>" — a non-empty id. A profile vote
// stored `post_id: null` was therefore treated as a vote on a post named
// "<nil>": the finding blamed the data, and the row's index selection was decided
// by a reference that never existed.
func TestNullReferenceIsAbsentNotPresent(t *testing.T) {
	if got := stringField(map[string]any{"post_id": nil}, "post_id"); got != "" {
		t.Fatalf("a JSON null must read as absent, got %q", got)
	}

	plan := engagementFixture()
	plan.ReputationLogs["v_profile"] = map[string]any{
		"voter_id": "u1", "target_id": "u3",
		"post_id": nil, "topic_id": nil,
		"value": float64(1), "created_at": at(100),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	profile := findVote(t, ep, "v_profile")
	if profile.PostID != "" {
		t.Fatalf("a null post_id must stay empty, got %q", profile.PostID)
	}
	if profile.TopicID != "" {
		t.Fatalf("a null topic_id must stay empty, got %q", profile.TopicID)
	}
	if _, ok := ep.Findings["reputation_vote_post_unresolved"]; ok {
		t.Fatal("a null post_id is not an unresolved reference; it is an absent one")
	}
}

// TestVoteWithUnresolvedAccountIsSkipped pins the Required-column rule.
func TestVoteWithUnresolvedAccountIsSkipped(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_orphan"] = map[string]any{
		"voter_id": "ghost", "target_id": "u2", "post_id": "p1", "value": float64(1),
	}

	ep := BuildEngagementPlan(plan, existsExcept("ghost"), existsAlways, existsAlways)

	if len(ep.VoteRows) != 0 {
		t.Fatalf("a vote from an unknown voter cannot be written, got %d rows", len(ep.VoteRows))
	}
	if len(ep.SkippedVoteIDs) != 1 {
		t.Fatalf("the skip must be recorded, got %v", ep.SkippedVoteIDs)
	}
	if _, ok := ep.Findings["reputation_vote_account_unresolved"]; !ok {
		t.Fatal("the skip must be reported")
	}
}

// TestVoteOnMissingPostDegradesToProfileVote pins the rule that keeps a vote from
// carrying a reference to nothing.
func TestVoteOnMissingPostDegradesToProfileVote(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_gone"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "deleted", "topic_id": "t1",
		"value": float64(1), "created_at": at(100),
	}

	present := func(id string) bool { return id == "t1" }
	ep := BuildEngagementPlan(plan, existsAlways, present, func(string) bool { return false })

	vote := findVote(t, ep, "v_gone")
	if vote.PostID != "" {
		t.Fatalf("a vote on a missing post must not carry a post id, got %q", vote.PostID)
	}
	if vote.TargetUserID != DeriveID(SpaceUser, "u2") {
		t.Fatal("the vote must still count against the author")
	}
	if _, ok := ep.Findings["reputation_vote_post_unresolved"]; !ok {
		t.Fatal("the degradation must be reported")
	}
}

// TestAppliedFlagIsRecordedNotHonoured pins the documented decision: every vote is
// imported, and the ones that carried no `applied` flag are counted.
func TestAppliedFlagIsRecordedNotHonoured(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_flagged"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "p1", "applied": true, "value": float64(1),
	}
	plan.ReputationLogs["v_unflagged"] = map[string]any{
		"voter_id": "u1", "target_id": "u4", "post_id": "p2", "value": float64(1),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	if len(ep.VoteRows) != 2 {
		t.Fatalf("both votes must be imported, got %d", len(ep.VoteRows))
	}
	if findVote(t, ep, "v_unflagged").AppliedMissing != true {
		t.Fatal("a vote without the flag must be recorded as such")
	}
	if findVote(t, ep, "v_flagged").AppliedMissing != false {
		t.Fatal("a vote with applied=true must not be recorded as missing")
	}
	f := ep.Findings["reputation_vote_without_applied_flag"]
	if f == nil || f.Count != 1 {
		t.Fatalf("exactly the unflagged vote must be counted, got %v", f)
	}
}

// TestZeroValueVoteIsSkipped pins the Required-column rule on value.
func TestZeroValueVoteIsSkipped(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_zero"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "p1", "value": float64(0),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	if len(ep.VoteRows) != 0 {
		t.Fatalf("a zero value is not a vote, got %d rows", len(ep.VoteRows))
	}
	if _, ok := ep.Findings["reputation_vote_value_zero"]; !ok {
		t.Fatal("the skip must be reported")
	}
}

func TestSubscriptionRequiresBothReferences(t *testing.T) {
	plan := engagementFixture()
	plan.Subscriptions["s_ok"] = map[string]any{
		"topic_id": "t1", "user_id": "u1", "created_at": at(100),
	}
	plan.Subscriptions["s_noTopic"] = map[string]any{
		"topic_id": "ghost", "user_id": "u1", "created_at": at(100),
	}
	plan.Subscriptions["s_noUser"] = map[string]any{
		"topic_id": "t1", "user_id": "ghost", "created_at": at(100),
	}

	present := func(id string) bool { return id == "t1" }
	// Topics resolve only "t1" and "u1" happens to be absent, so the user
	// predicate drops "ghost" as well as the topic predicate drops "ghost".
	ep := BuildEngagementPlan(plan, existsExcept("ghost"), present, present)

	if len(ep.SubscriptionRows) != 1 {
		t.Fatalf("only the resolvable subscription may be written, got %d", len(ep.SubscriptionRows))
	}
	if len(ep.SkippedSubIDs) != 2 {
		t.Fatalf("both dangling subscriptions must be recorded, got %v", ep.SkippedSubIDs)
	}
	if _, ok := ep.Findings["subscription_topic_unresolved"]; !ok {
		t.Fatal("a dangling topic must be reported")
	}
	if _, ok := ep.Findings["subscription_user_unresolved"]; !ok {
		t.Fatal("a dangling user must be reported")
	}
}

func TestEngagementPlanIsDeterministic(t *testing.T) {
	plan := engagementFixture()
	for i := range 3 {
		plan.ReputationLogs["v"+string(rune('a'+i))] = map[string]any{
			"voter_id": "u1", "target_id": "u2", "post_id": "p" + string(rune('a'+i)),
			"value": float64(1), "created_at": at(100),
		}
	}

	first := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)
	second := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	a, b := first.SortedRowLines(), second.SortedRowLines()
	if len(a) != len(b) {
		t.Fatalf("row counts differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("line %d differs:\n%s\n%s", i, a[i], b[i])
		}
	}
}

// TestDuplicateProfileVoteKeepsTheEarliest pins the collision rule.
//
// The target has UNIQUE(voter_id, target_id) where post_id = ”, and the legacy
// data violates it: the 2026-09 export holds two (voter, target) pairs twice.
// The batch would be refused wholesale by the index, so the planner collapses
// them — and the survivor has to be the EARLIEST cast, because a profile vote is
// a standing statement rather than a tally, and a later duplicate is the same
// statement written twice.
func TestDuplicateProfileVoteKeepsTheEarliest(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_late"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "", "value": float64(1),
		"created_at": at(500),
	}
	plan.ReputationLogs["v_early"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "", "value": float64(-1),
		"created_at": at(100),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	if len(ep.VoteRows) != 1 {
		t.Fatalf("a duplicate pair must collapse to one row, got %d", len(ep.VoteRows))
	}
	if ep.VoteRows[0].LegacyID != "v_early" {
		t.Fatalf("the earliest vote must survive, got %q", ep.VoteRows[0].LegacyID)
	}
	if ep.VoteRows[0].Value != -1 {
		t.Fatalf("the survivor must carry the earliest vote's value, got %d", ep.VoteRows[0].Value)
	}
	if _, ok := ep.Findings["reputation_vote_duplicate_profile_vote"]; !ok {
		t.Fatal("the collapse must be reported")
	}
}

// TestDuplicateProfileVoteTieBreaksOnID pins the determinism half: two votes with
// the same timestamp must still collapse to the same survivor on every run.
func TestDuplicateProfileVoteTieBreaksOnID(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_b"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "value": float64(1), "created_at": at(100),
	}
	plan.ReputationLogs["v_a"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "value": float64(-1), "created_at": at(100),
	}

	first := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)
	second := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	if len(first.VoteRows) != 1 || len(second.VoteRows) != 1 {
		t.Fatalf("both runs must collapse to one row, got %d and %d",
			len(first.VoteRows), len(second.VoteRows))
	}
	if first.VoteRows[0].LegacyID != "v_a" || second.VoteRows[0].LegacyID != "v_a" {
		t.Fatalf("a timestamp tie must break on the document id, got %q and %q",
			first.VoteRows[0].LegacyID, second.VoteRows[0].LegacyID)
	}
}

// TestPostVotesAreNeverCollapsed guards the other direction: the dedup must only
// touch profile votes. Post votes are unique per (voter, post) and the target
// index already covers that — collapsing two votes on DIFFERENT posts of the same
// author would silently delete a real vote.
func TestPostVotesAreNeverCollapsed(t *testing.T) {
	plan := engagementFixture()
	plan.ReputationLogs["v_p1"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "postA", "value": float64(1),
		"created_at": at(100),
	}
	plan.ReputationLogs["v_p2"] = map[string]any{
		"voter_id": "u1", "target_id": "u2", "post_id": "postB", "value": float64(1),
		"created_at": at(200),
	}

	ep := BuildEngagementPlan(plan, existsAlways, existsAlways, existsAlways)

	if len(ep.VoteRows) != 2 {
		t.Fatalf("votes on different posts must both survive, got %d", len(ep.VoteRows))
	}
}
