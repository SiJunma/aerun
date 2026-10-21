package pocketbase

// The topic-delete AUTHORITY, pinned from the server's side.
//
// WHY THIS FILE EXISTS. The client used to refuse the topic's first post with
// "use the topic menu", and that menu only offered "Delete Topic" to holders
// of `delete_others_topics` — so an ordinary author had NO path to remove
// their own thread. The fix was on the client (the action is now offered to
// the author), but a client fix rests on a promise the SERVER has to keep:
// that DELETE /topics/{id} accepts the author of a topic and tells them,
// precisely, when it will not.
//
// The server's own rule (deleteTopicHandler in forum_topics.go):
//
//	author, nobody else has replied        → 200
//	author, other members have replied     → 409 (the cascade right is off)
//	somebody else, no delete_others_topics → 403
//
// The three are pinned here because the client's messages are derived from
// them: a 409 means "the thread holds other members' replies", a 403 means
// "you lack the rights". If the server changed one of these answers, the
// client's wording would silently become a lie — and this file is what makes
// that change impossible to miss.
//
// A REFUSAL MUST ALSO DELETE NOTHING. The 409 and the 403 are policy
// answers, not partial successes: the topic and every post under it have to
// survive them, because the author is being told "ask an administrator", not
// "it is half gone".

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// seedOwnTopic builds a topic whose only post is the author's own opening
// post — the state in which the server allows the author to delete it.
func seedOwnTopic(t testing.TB, app *tests.TestApp, authorID string) (topicID, postID string) {
	t.Helper()

	catID := getGeneralCategoryID(t, app)

	topicsCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	topic := core.NewRecord(topicsCol)
	topic.Set("category_id", catID)
	topic.Set("author_id", authorID)
	topic.Set("title", "Author's Own Topic")
	topic.Set("posts_count", 1)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", topic.Id)
	post.Set("author_id", authorID)
	post.Set("content", "The opening post")
	post.Set("is_draft", false)
	post.SetRaw("created", types.NowDateTime().Add(-time.Hour))
	if err := app.Save(post); err != nil {
		t.Fatal(err)
	}
	return topic.Id, post.Id
}

// deleteTopicAs issues DELETE /topics/{id} as the given token and returns the
// HTTP status.
func deleteTopicAs(t testing.TB, serverURL, token, topicID, idemKey string) int {
	t.Helper()

	req, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/topics/%s", serverURL, topicID), nil)
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", idemKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

// TestAuthorMayDeleteTheirOwnTopic is the case the client dead end denied.
// The author holds no `delete_others_topics` and is not staff, and the delete
// still succeeds — the server has no permission requirement for a thread that
// holds nothing but the author's own words.
func TestAuthorMayDeleteTheirOwnTopic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, postID := seedOwnTopic(t, app, fixPlayerID)

	server := newTestServer(t, app)
	defer server.Close()

	if status := deleteTopicAs(t, server.URL, tokens["player"], topicID, "author-own-topic"); status != http.StatusOK {
		t.Fatalf("the author deleting their own otherwise-empty topic = %d, want 200", status)
	}

	if _, err := app.FindRecordById(topicsCollectionName, topicID); err == nil {
		t.Error("the topic row must be gone after a successful delete")
	}
	if _, err := app.FindRecordById(postsCollectionName, postID); err == nil {
		t.Error("the opening post must be gone with its topic")
	}
}

// TestAuthorWithOtherRepliesGetsConflict pins the 409 the client's "the
// thread holds other members' replies" wording is derived from. The author's
// own cascade right is off by default, so the delete is refused — and NOTHING
// may be removed by the refusal.
func TestAuthorWithOtherRepliesGetsConflict(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	// Two authors: the player opened the topic, the pending account replied.
	topicID, _, replyID := seedResidueFixture(t, app, fixPlayerID, fixPendingID)

	server := newTestServer(t, app)
	defer server.Close()

	if status := deleteTopicAs(t, server.URL, tokens["player"], topicID, "author-with-replies"); status != http.StatusConflict {
		t.Fatalf("the author deleting a topic other members replied to = %d, want 409", status)
	}

	// A refusal is not a partial delete: the author is being told to ask an
	// administrator, so the thread must still be there for them to point at.
	if _, err := app.FindRecordById(topicsCollectionName, topicID); err != nil {
		t.Errorf("a refused topic delete must leave the topic in place: %v", err)
	}
	if _, err := app.FindRecordById(postsCollectionName, replyID); err != nil {
		t.Errorf("a refused topic delete must leave the replies in place: %v", err)
	}
}

// TestStrangerMayNotDeleteTheTopic pins the 403 behind the client's "you are
// not allowed to delete this topic" wording. `delete_others_topics` is granted
// to admins and root alone, so an ordinary account must be refused — and the
// refusal must delete nothing.
func TestStrangerMayNotDeleteTheTopic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID, postID := seedOwnTopic(t, app, fixPlayerID)

	server := newTestServer(t, app)
	defer server.Close()

	// The moderator is a stranger to this topic AND deliberately holds no
	// `delete_others_topics` (see internal/auth/role.go: a moderator does not
	// delete another account's topic), which makes it the right probe.
	if status := deleteTopicAs(t, server.URL, tokens["moderator"], topicID, "stranger-topic"); status != http.StatusForbidden {
		t.Fatalf("a stranger deleting another account's topic = %d, want 403", status)
	}

	if _, err := app.FindRecordById(topicsCollectionName, topicID); err != nil {
		t.Errorf("a refused topic delete must leave the topic in place: %v", err)
	}
	if _, err := app.FindRecordById(postsCollectionName, postID); err != nil {
		t.Errorf("a refused topic delete must leave the opening post in place: %v", err)
	}
}