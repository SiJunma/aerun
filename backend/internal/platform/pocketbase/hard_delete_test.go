package pocketbase

// hard_delete_test.go pins the 2026-10-01 product decision: deletion is a HARD
// delete, matching the Firestore era this branch migrates from and the reference
// engine (MyBB). There is no tombstone, no `deleted` column, and no un-delete.
//
// The owner drew the line precisely: we do not keep deleted topics or posts.
// The audit log is the surviving record — every delete is written there, with
// the post's TEXT, because that is the last place its content can live. That
// includes deletes by ordinary players and spectators, not only staff ones.
//
// Counter semantics fall out of this and are pinned here too, because they are
// the other half of the same decision: a counter counts REAL posts, i.e. the rows
// that exist. A post in a topic the reader has hidden still counts; a draft and
// a deleted post do not. That separation is what will let the planned blocklist
// hide posts per-viewer without touching anybody's numbers.
//
// The bug this file is written against: the soft-delete design had
// `posts_count` = `deleted = false` while `listPostsHandler` filtered drafts
// ONLY, so a tombstone sat in the feed and was missing from the counter — and
// the counter is the pagination window. Hard delete removes the disagreement by
// construction: no row, nothing to count, nothing to page past.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

func mustCol(t *testing.T, app *tests.TestApp, name string) *core.Collection {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		t.Fatal(err)
	}
	return col
}

// auditLogsFor returns the decoded audit entries of one action type so a test can
// assert on what an admin would actually see in the log.
func auditLogsFor(t *testing.T, app *tests.TestApp, action string) []map[string]any {
	t.Helper()
	rows, err := app.FindAllRecords(auditLogsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, r := range rows {
		if r.GetString("action_type") != action {
			continue
		}
		var details any
		if raw := r.Get("details"); raw != nil {
			_ = json.Unmarshal(fmt.Append(nil, raw), &details)
		}
		out = append(out, map[string]any{
			"action_type": r.GetString("action_type"),
			"performer":   r.GetString("performer_id"),
			"details":     details,
		})
	}
	return out
}

func TestHardDeleteRemovesTopicAndItsPosts(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, firstPostID, replyPostID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	server := newTestServer(t, app)
	defer server.Close()

	// root holds `delete_others_topics`; the thread has a reply from another
	// member, so its author may not delete it (the cascade right is off).
	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
	req.Header.Set("Authorization", tokens["root"])
	req.Header.Set("Idempotency-Key", "hard-delete-topic")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d, want 200", res.StatusCode)
	}

	// Nothing survives. That is the point: the thread is not recoverable, exactly
	// as in the Firestore era.
	if _, err := app.FindRecordById(topicsCollectionName, topicID); err == nil {
		t.Error("the topic row must be gone")
	}
	for _, id := range []string{firstPostID, replyPostID} {
		if _, err := app.FindRecordById(postsCollectionName, id); err == nil {
			t.Errorf("post %s must be gone with its topic", id)
		}
	}

	// And nothing may be left pointing at them. An orphan vote is the residue
	// class the 2026-09-30 incident was about, and unlike a stale counter it can
	// never be reconciled afterwards — the row it names does not exist.
	if n := countRows(t, app, reputationVotesCollectionName, "topic_id = {:t}", map[string]any{"t": topicID}); n != 0 {
		t.Errorf("votes on a deleted topic must be removed, %d remain", n)
	}
}

// TestHardDeleteMovesEveryAuthorsCounter is the regression for the aggregate
// decrement. The Firestore cascade deleted the posts first, so the trigger that
// owned the per-author decrement returned early ("the topic document is already
// gone") and NOBODY was decremented. Rule 3 of the incident doc: aggregate per
// author BEFORE mutating, and never early-return out of a decrement.
//
// Two authors, and the second owns two posts, so a handler that decremented once
// per author rather than once per post is caught as loudly as one that
// decremented not at all.
func TestHardDeleteMovesEveryAuthorsCounter(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	// The second author writes twice, so their count must drop by 2, not 1.
	extra := core.NewRecord(mustCol(t, app, postsCollectionName))
	extra.Set("topic_id", topicID)
	extra.Set("author_id", fixPendingID)
	extra.Set("content", "a second reply from the same author")
	extra.Set("is_draft", false)
	if err := app.Save(extra); err != nil {
		t.Fatal(err)
	}

	// Baseline: derive the counters from the rows before deleting anything.
	if _, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := userCounter(t, app, fixPlayerID, "posts_count"); got != 1 {
		t.Fatalf("fixture: player posts_count = %d, want 1", got)
	}
	if got := userCounter(t, app, fixPendingID, "posts_count"); got != 2 {
		t.Fatalf("fixture: pending posts_count = %d, want 2", got)
	}

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
	req.Header.Set("Authorization", tokens["root"])
	req.Header.Set("Idempotency-Key", "hard-delete-counters")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d, want 200", res.StatusCode)
	}

	for _, tc := range []struct {
		user, field string
		want        int
	}{
		{fixPlayerID, "posts_count", 0},
		{fixPendingID, "posts_count", 0},
		{fixPlayerID, "topics_count", 0},
	} {
		if got := userCounter(t, app, tc.user, tc.field); got != tc.want {
			t.Errorf("%s.%s after delete = %d, want %d", tc.user, tc.field, got, tc.want)
		}
	}

	// Rule 5: the repair tool must agree with the command, or the next recompute
	// silently restores everything the delete just removed.
	if _, err := RecomputeUserCounters(app, UserCounterRecomputeOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := userCounter(t, app, fixPendingID, "posts_count"); got != 0 {
		t.Errorf("pending posts_count after recompute = %d, want 0 (the recompute must agree)", got)
	}
}

// TestCounterAndFeedAgreeAfterDelete is the property the soft-delete design made
// impossible to state. `posts_count` IS the pagination window, and
// `listPostsHandler` is the feed: if they agree here, across a delete, the
// tombstone drift is structurally gone.
func TestCounterAndFeedAgreeAfterDelete(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, replyPostID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, replyPostID), nil)
	req.Header.Set("Authorization", tokens["moderator"])
	req.Header.Set("Idempotency-Key", "counter-feed-agree")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil {
		t.Fatal(err)
	}
	var row struct {
		C int `db:"c"`
	}
	if err := app.DB().NewQuery(
		"SELECT COUNT(*) AS c FROM " + postsCollectionName +
			" WHERE topic_id = {:t} AND (is_draft = false OR is_draft IS NULL)",
	).Bind(dbx.Params{"t": topicID}).One(&row); err != nil {
		t.Fatal(err)
	}

	if got := topic.GetInt("posts_count"); got != row.C {
		t.Errorf("posts_count = %d but the feed returns %d rows; they must be the same number", got, row.C)
	}
}

// TestDeletedPostLeavesNoVoteOrphan pins that a vote cannot outlive its post.
// The soft-delete design deliberately KEPT vote rows so an un-delete could
// restore the score. There is no un-delete now, so keeping them would leave rows
// naming a post that does not exist — permanently invisible to sumVotes, which
// resolves a vote through its post row, and therefore uncorrectable by any future
// recompute.
func TestDeletedPostLeavesNoVoteOrphan(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, replyPostID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	castPostVote(t, app, fixPlayerID, fixPendingID, replyPostID, topicID, 5)

	if n := countRows(t, app, reputationVotesCollectionName, "post_id = {:p}", map[string]any{"p": replyPostID}); n != 1 {
		t.Fatalf("fixture: expected 1 vote, got %d", n)
	}

	server := newTestServer(t, app)
	defer server.Close()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, replyPostID), nil)
	req.Header.Set("Authorization", tokens["moderator"])
	req.Header.Set("Idempotency-Key", "delete-vote-orphan")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if n := countRows(t, app, reputationVotesCollectionName, "post_id = {:p}", map[string]any{"p": replyPostID}); n != 0 {
		t.Errorf("votes on a deleted post must be removed, %d remain", n)
	}
	if got := userCounter(t, app, fixPendingID, "reputation"); got != 0 {
		t.Errorf("reputation = %d, want 0 (the vote was on a post that no longer exists)", got)
	}
}

// TestEveryDeleteIsAuditedWithItsText pins the owner's requirement: the audit
// log is the surviving record of what was deleted, INCLUDING deletes by ordinary
// players. The old code guarded the log with `if !isAuthor`, so a player
// deleting their own post left no trace at all — exactly the traffic worth
// watching.
func TestEveryDeleteIsAuditedWithItsText(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)
	const secret = "the exact words that must survive the delete"

	// The post belongs to fixPendingID and carries text worth reviewing.
	//
	// `created` is stamped explicitly, well after the fixture's own posts. It is
	// a REPLY being deleted, not the opening post, and with no explicit time it
	// could tie with the fixture rows inside the same millisecond — at which
	// point the id tie-breaker alone decides which post the feed opens with, and
	// a legitimate delete is refused with 409. SetRaw is required for an
	// AutodateField.
	post := core.NewRecord(mustCol(t, app, postsCollectionName))
	post.Set("topic_id", topicID)
	post.Set("author_id", fixPlayerID)
	post.Set("content", secret)
	post.Set("is_draft", false)
	post.SetRaw("created", types.NowDateTime().Add(48*time.Hour))
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	// Deleted as its OWN author: the path that used to write no audit row at all.
	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, post.Id), nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "audit-author-delete")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d, want 200", res.StatusCode)
	}

	logs := auditLogsFor(t, app, "post_delete")
	if len(logs) == 0 {
		t.Fatal("an author's own post delete must be audited; no audit row was written")
	}
	for _, entry := range logs {
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		content, _ := details["content"].(string)
		if !strings.Contains(content, secret) {
			continue
		}
		if byAuthor, _ := details["by_author"].(bool); !byAuthor {
			t.Error("by_author must record that the author deleted their own post")
		}
		if catID, _ := details["category_id"].(string); catID == "" {
			t.Error("category_id must be populated in post_delete audit details")
		}
		if catTitle, _ := details["category_title"].(string); catTitle == "" {
			t.Error("category_title must be populated in post_delete audit details")
		}
		return
	}
	t.Errorf("the deleted post's TEXT must be stored in the audit log; entries: %v", logs)
}

// TestTopicDeleteIsAuditedForItsAuthor is the topic-level half: an author
// deleting their own topic must leave a record too.
func TestTopicDeleteIsAuditedForItsAuthor(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, _, _ := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	server := newTestServer(t, app)
	defer server.Close()

	// The author deletes their OWN topic, which is the point of the test. For
	// that to be allowed the topic must hold nothing but their opening post:
	// the cascade right (`delete_own_topic_with_replies`) is off by default, so
	// an author cannot remove a thread other members have replied to.
	//
	// The reply is therefore removed first, by a moderator holding
	// `delete_others_posts` — which also leaves the topic in exactly the state
	// the new rule treats as permission-free ("my own topic, nobody else's
	// words in it").
	// The reply specifically — filtering on the topic alone would return the
	// opening post, which is the author's own and must NOT be the one removed.
	reply, err := app.FindFirstRecordByFilter(
		postsCollectionName,
		"topic_id = {:topic} && is_draft = false && author_id != {:author}",
		dbx.Params{"topic": topicID, "author": fixPlayerID},
	)
	if err != nil || reply == nil {
		t.Fatal("expected a reply from another account to remove first")
	}
	dropReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, reply.Id), nil)
	dropReq.Header.Set("Authorization", tokens["moderator"])
	dropReq.Header.Set("Idempotency-Key", "audit-drop-reply")
	dropRes, err := server.Client().Do(dropReq)
	if err != nil {
		t.Fatal(err)
	}
	dropRes.Body.Close()
	if dropRes.StatusCode != http.StatusOK {
		t.Fatalf("removing the other member's reply = %d, want 200", dropRes.StatusCode)
	}

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", server.URL, topicID), nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "audit-topic-author")
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the author deleting their own otherwise-empty topic = %d, want 200", res.StatusCode)
	}

	for _, entry := range auditLogsFor(t, app, "topic_delete") {
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			continue
		}
		if title, _ := details["topic_title"].(string); title != "" {
			return // found, and it carries the title
		}
	}
	t.Error("deleting one's own topic must be audited with its title")
}
