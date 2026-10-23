package importer

// Tests for the L5/L6 forum plan, with the focus on sequence reconstruction.
//
// Sequence is the one field the importer has to INVENT: the legacy documents
// carry only created_at. A wrong order does not crash — it silently reorders a
// conversation — so the assertions here are about ordering, contiguity and
// determinism rather than about counts.

import (
	"testing"
	"time"
)

// forumFixture builds a plan with one category, two users and one topic.
func forumFixture() *ImportPlan {
	plan := &ImportPlan{
		Categories: map[string]map[string]any{},
		Users:      map[string]map[string]any{"u1": {}, "u2": {}},
		Topics:     map[string]map[string]any{},
		Posts:      map[string]map[string]any{},
		Drafts:     map[string]map[string]any{},
	}
	plan.Categories["c1"] = map[string]any{"title": "Board"}
	plan.Topics["t1"] = map[string]any{
		"title":       "Topic",
		"category_id": "c1",
		"author_id":   "u1",
		"created_at":  time.Unix(1000, 0).UTC(),
		// A stale cached projection on purpose: the plan must ignore it.
		"posts_count": 999,
	}
	return plan
}

func alwaysYes(string) bool { return true }

func findPost(t *testing.T, fp *ForumPlan, legacyID string) PostRow {
	t.Helper()
	for _, p := range fp.PostRows {
		if p.LegacyID == legacyID {
			return p
		}
	}
	t.Fatalf("post %s was not planned", legacyID)
	return PostRow{}
}

func findTopic(t *testing.T, fp *ForumPlan, legacyID string) TopicRow {
	t.Helper()
	for _, r := range fp.TopicRows {
		if r.LegacyID == legacyID {
			return r
		}
	}
	t.Fatalf("topic %s was not planned", legacyID)
	return TopicRow{}
}

// lookupPost is findPost for rows that are EXPECTED to be absent: it returns nil
// instead of failing, so a test can assert "this was deliberately skipped"
// rather than only "this is present".
func lookupPost(fp *ForumPlan, legacyID string) *PostRow {
	for i, p := range fp.PostRows {
		if p.LegacyID == legacyID {
			return &fp.PostRows[i]
		}
	}
	return nil
}

func postAt(plan *ImportPlan, id, topic, author string, created time.Time) {
	plan.Posts[id] = map[string]any{
		"topic_id":   topic,
		"author_id":  author,
		"content":    "text " + id,
		"created_at": created,
	}
}

// TestSequenceFollowsTimestampOrder is the core rule: sequence 1..n in ascending
// created_at order, regardless of the order the documents arrive in.
func TestSequenceFollowsTimestampOrder(t *testing.T) {
	plan := forumFixture()
	// Deliberately inserted out of order, with names that sort differently from
	// their timestamps: a map iteration or a lexicographic sort would produce a
	// different answer than the timestamp order.
	postAt(plan, "zzz", "t1", "u1", time.Unix(300, 0).UTC())
	postAt(plan, "aaa", "t1", "u1", time.Unix(100, 0).UTC())
	postAt(plan, "mmm", "t1", "u2", time.Unix(200, 0).UTC())

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)

	if findPost(t, fp, "aaa").Sequence != 1 {
		t.Fatalf("the oldest post must be sequence 1, got %d", findPost(t, fp, "aaa").Sequence)
	}
	if findPost(t, fp, "mmm").Sequence != 2 {
		t.Fatalf("the middle post must be sequence 2, got %d", findPost(t, fp, "mmm").Sequence)
	}
	if findPost(t, fp, "zzz").Sequence != 3 {
		t.Fatalf("the newest post must be sequence 3, got %d", findPost(t, fp, "zzz").Sequence)
	}
}

// TestSequenceUsesFullPrecision pins nanosecond comparison. Two posts in the same
// second must keep their real order, because Firestore wrote nanosecond
// timestamps and comparing at second precision would swap them.
func TestSequenceUsesFullPrecision(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "later", "t1", "u1", time.Unix(100, 500_000_000).UTC())
	postAt(plan, "earlier", "t1", "u1", time.Unix(100, 100_000_000).UTC())

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)

	if findPost(t, fp, "earlier").Sequence != 1 || findPost(t, fp, "later").Sequence != 2 {
		t.Fatalf("sub-second order must be honoured, got %d and %d",
			findPost(t, fp, "earlier").Sequence, findPost(t, fp, "later").Sequence)
	}
}

// TestSequenceTieBreakIsDeterministic covers two posts sharing a timestamp. The
// order must be total (document id breaks the tie) so two runs cannot disagree.
func TestSequenceTieBreakIsDeterministic(t *testing.T) {
	plan := forumFixture()
	same := time.Unix(100, 0).UTC()
	postAt(plan, "bbb", "t1", "u1", same)
	postAt(plan, "aaa", "t1", "u1", same)

	first := BuildForumPlan(plan, alwaysYes, alwaysYes)
	second := BuildForumPlan(plan, alwaysYes, alwaysYes)

	if findPost(t, first, "aaa").Sequence != 1 || findPost(t, first, "bbb").Sequence != 2 {
		t.Fatal("a timestamp tie must be broken by document id")
	}
	if findPost(t, second, "aaa").Sequence != findPost(t, first, "aaa").Sequence {
		t.Fatal("the tie break must be identical across runs")
	}
}

// TestTopicProjectionsAreRecomputedNotCopied pins the "recompute, never copy"
// rule. The legacy topic document carries a cached posts_count of 999 and a
// cached last_post_* that point at a post nobody can verify; the plan must
// replace all of it with what the rows actually say.
func TestTopicProjectionsAreRecomputedNotCopied(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "p1", "t1", "u1", time.Unix(200, 0).UTC())
	postAt(plan, "p2", "t1", "u2", time.Unix(300, 0).UTC())

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)
	topic := findTopic(t, fp, "t1")

	if topic.PostsCount != 2 {
		t.Fatalf("posts_count must be recomputed from the rows, got %d", topic.PostsCount)
	}
	wantNewest := DeriveID(SpacePost, "p2")
	if topic.LastPostID != wantNewest {
		t.Fatalf("last_post_id must point at the newest post, got %q want %q",
			topic.LastPostID, wantNewest)
	}
	if topic.LastPostAuthorID != DeriveID(SpaceUser, "u2") {
		t.Fatalf("last_post_author_id must name the newest post's author, got %q",
			topic.LastPostAuthorID)
	}
	if topic.LastPostCreated == "" {
		t.Fatal("last_post_created must never be empty: the keyset index would drop the row")
	}
}

// TestDeletedPostIsSkippedWithoutLeavingAHole pins the hard-delete import rule.
//
// This test used to assert the opposite — that a deleted post KEEPS its
// sequence slot as a tombstone and that later posts are NOT renumbered down.
// That rule existed to preserve numbering across an un-delete, which no longer
// exists (1767700000).
//
// The rule now is the opposite trade: a deleted post is not imported, and the
// survivors are numbered 1..n WITHOUT a hole. Keeping the hole would mean the
// target permanently displays a gap where a post used to be, with nothing at
// that position and no way to explain it — and since the post genuinely no
// longer exists in the source either, there is no content the hole refers to.
func TestDeletedPostIsSkippedWithoutLeavingAHole(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "p1", "t1", "u1", time.Unix(100, 0).UTC())
	postAt(plan, "p2", "t1", "u1", time.Unix(200, 0).UTC())
	plan.Posts["p2"]["is_deleted"] = true
	postAt(plan, "p3", "t1", "u1", time.Unix(300, 0).UTC())

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)

	// The deleted post is not written at all.
	if post := lookupPost(fp, "p2"); post != nil {
		t.Fatalf("a deleted post must not be imported, got sequence %d", post.Sequence)
	}
	// It is still REPORTED rather than dropped silently.
	if !containsString(fp.SkippedPostIDs, "p2") {
		t.Errorf("a skipped post must be reported, SkippedPostIDs=%v", fp.SkippedPostIDs)
	}
	if _, ok := fp.Findings["post_skipped_deleted"]; !ok {
		t.Errorf("the skip must be recorded as a finding, got %v", fp.Findings)
	}
	// The survivors close the gap: 1 and 2, no hole at 2.
	if got := findPost(t, fp, "p1").Sequence; got != 1 {
		t.Fatalf("first post sequence = %d, want 1", got)
	}
	if got := findPost(t, fp, "p3").Sequence; got != 2 {
		t.Fatalf("post after the deleted one = %d, want 2 (the gap must close)", got)
	}
	// posts_count counts the rows that were actually written.
	if got := findTopic(t, fp, "t1").PostsCount; got != 2 {
		t.Fatalf("posts_count must exclude the deleted post, got %d", got)
	}
	// Every imported post keeps its text.
	for _, id := range []string{"p1", "p3"} {
		if got := findPost(t, fp, id).Content; got == "" {
			t.Errorf("post %s must keep its content", id)
		}
	}
}

// TestDraftGetsNoSequence pins the draft contract: a draft is a post with
// is_draft=true and sequence 0, and it must not consume a number or move any
// projection.
func TestDraftGetsNoSequence(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "p1", "t1", "u1", time.Unix(100, 0).UTC())
	plan.Drafts["u1/drafts/t1"] = map[string]any{
		"topic_id":   "t1",
		"author_id":  "u1",
		"content":    "unsent",
		"created_at": time.Unix(50, 0).UTC(),
	}

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)

	draft := findPost(t, fp, "u1/drafts/t1")
	if !draft.IsDraft {
		t.Fatal("a draft must be flagged is_draft")
	}
	if draft.Sequence != 0 {
		t.Fatalf("a draft must carry sequence 0, got %d", draft.Sequence)
	}
	// It is older than p1 but must not become sequence 1.
	if got := findPost(t, fp, "p1").Sequence; got != 1 {
		t.Fatalf("a draft must not take a sequence number, p1 got %d", got)
	}
	if got := findTopic(t, fp, "t1").PostsCount; got != 1 {
		t.Fatalf("a draft must not count as a post, topic got %d", got)
	}
}

// TestTopicWithoutVisiblePostsKeepsNonNullDate pins the keyset-index guard: a
// topic whose every post is a tombstone still needs a non-empty
// last_post_created, or it vanishes from every list.
func TestTopicWithoutVisiblePostsKeepsNonNullDate(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "p1", "t1", "u1", time.Unix(100, 0).UTC())
	plan.Posts["p1"]["is_deleted"] = true

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)
	topic := findTopic(t, fp, "t1")

	if topic.LastPostCreated == "" {
		t.Fatal("a topic with only tombstones must still carry a last_post_created")
	}
	if topic.LastPostID != "" {
		t.Fatalf("the projection must not point at an invisible post, got %q", topic.LastPostID)
	}
	if _, ok := fp.Findings["topic_without_visible_posts"]; !ok {
		t.Fatal("this case must be reported")
	}
}

// TestUnresolvedReferenceIsSkippedNotInvented pins the FK rule for both levels: a
// topic whose category never imported, and a post whose author never imported.
func TestUnresolvedReferenceIsSkippedNotInvented(t *testing.T) {
	plan := forumFixture()
	plan.Topics["t2"] = map[string]any{
		"title": "Orphan", "category_id": "missing", "author_id": "u1",
		"created_at": time.Unix(1000, 0).UTC(),
	}
	plan.Posts["p1"] = map[string]any{
		"topic_id": "t1", "author_id": "ghost", "content": "x",
		"created_at": time.Unix(200, 0).UTC(),
	}

	fp := BuildForumPlan(plan, alwaysYes, func(id string) bool { return id == "c1" })

	if len(fp.SkippedTopicIDs) != 1 || fp.SkippedTopicIDs[0] != "t2" {
		t.Fatalf("a topic with an unknown category must be skipped, got %v", fp.SkippedTopicIDs)
	}
	if _, ok := fp.Findings["topic_category_unresolved"]; !ok {
		t.Fatal("the skipped topic must be reported")
	}

	users := map[string]bool{"u1": true, "u2": true}
	fp2 := BuildForumPlan(plan, func(id string) bool { return users[id] }, alwaysYes)
	if len(fp2.SkippedPostIDs) != 1 || fp2.SkippedPostIDs[0] != "p1" {
		t.Fatalf("a post with an unknown author must be skipped, got %v", fp2.SkippedPostIDs)
	}
	if _, ok := fp2.Findings["post_author_unresolved"]; !ok {
		t.Fatal("the skipped post must be reported")
	}
}

// TestForumPlanIsDeterministic runs the whole planner twice over the same input
// and compares the rendered report, which is the property the rehearsal DoD
// ("two runs must be record-equivalent") rests on.
func TestForumPlanIsDeterministic(t *testing.T) {
	plan := forumFixture()
	for i, when := range []int64{300, 100, 200} {
		postAt(plan, "p"+string(rune('a'+i)), "t1", "u1", time.Unix(when, 0).UTC())
	}
	plan.Drafts["u1/drafts/t1"] = map[string]any{
		"topic_id": "t1", "author_id": "u1", "content": "d",
		"created_at": time.Unix(50, 0).UTC(),
	}

	first := BuildForumPlan(plan, alwaysYes, alwaysYes)
	second := BuildForumPlan(plan, alwaysYes, alwaysYes)

	a := first.SortedRowLines()
	b := second.SortedRowLines()
	if len(a) != len(b) {
		t.Fatalf("row count differs between runs: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("line %d differs between runs:\n%s\n%s", i, a[i], b[i])
		}
	}

	fa := first.SortedFindingLines()
	fb := second.SortedFindingLines()
	if len(fa) != len(fb) {
		t.Fatalf("finding count differs between runs")
	}
	for i := range fa {
		if fa[i] != fb[i] {
			t.Fatalf("finding %d differs: %s vs %s", i, fa[i], fb[i])
		}
	}
}

// TestRewriteQuotePostIDs pins the legacy-to-derived id rewrite inside quote
// markup: a post quoting another post keeps a working link after cutover
// because the legacy id in the quote is replaced by the derived target id that
// the quoted post's own row carries.
func TestRewriteQuotePostIDs(t *testing.T) {
	plan := forumFixture()
	postAt(plan, "p1", "t1", "u1", time.Unix(100, 0).UTC())
	postAt(plan, "p2", "t1", "u1", time.Unix(200, 0).UTC())

	// p2 quotes p1 using the legacy markup the exporter preserved verbatim.
	plan.Posts["p2"]["content"] = `ответ [quote="#pp1,t1,Author"]цитата[/quote] продолжение`

	fp := BuildForumPlan(plan, alwaysYes, alwaysYes)
	p2 := findPost(t, fp, "p2")

	want := `ответ [quote="#p` + DeriveID(SpacePost, "p1") + `,t` + DeriveID(SpaceTopic, "1") + `,Author"]цитата[/quote] продолжение`
	if p2.Content != want {
		t.Fatalf("legacy quote ids not rewritten to derived ids:\n got %q\nwant %q", p2.Content, want)
	}

	// A `#p` marker that is not part of a quote tag must be left alone, and the
	// quoting post's own id must never be rewritten.
	plain := `сообщение #p42 без тега цитаты`
	plan.Posts["p2"]["content"] = plain
	fp2 := BuildForumPlan(plan, alwaysYes, alwaysYes)
	if got := findPost(t, fp2, "p2").Content; got != plain {
		t.Fatalf("non-quote content must be unchanged:\n got %q\nwant %q", got, plain)
	}

	// Multiple quotes in one post are all rewritten, and repeated quotes of the
	// same post produce the same derived id each time.
	plan.Posts["p2"]["content"] = `[quote="#pp1,t1,A"]первая[/quote] и [quote="#pp1,t1,A"]вторая[/quote]`
	fp3 := BuildForumPlan(plan, alwaysYes, alwaysYes)
	wantMulti := `[quote="#p` + DeriveID(SpacePost, "p1") + `,t` + DeriveID(SpaceTopic, "1") + `,A"]первая[/quote] и [quote="#p` + DeriveID(SpacePost, "p1") + `,t` + DeriveID(SpaceTopic, "1") + `,A"]вторая[/quote]`
	if got := findPost(t, fp3, "p2").Content; got != wantMulti {
		t.Fatalf("multiple quotes not all rewritten:\n got %q\nwant %q", got, wantMulti)
	}
}
