package pocketbase

// Guest posting must project the guest's display name onto the TOPIC row, not
// just the post row: the forum index reads topics.last_post_guest_display_name via
// categoryForumProjections, so a topic whose last_post_guest_display_name was never written
// renders "Deleted user" on the index even though the post itself carries the
// name. These tests pin the topic projection for both the create-topic path
// and the create-post path.

import (
	"bytes"
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"
)

// seedGuestCategory creates a category that allows guests to view, create
// topics and reply, and returns its id.
func seedGuestCategory(t testing.TB, app *tests.TestApp) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		t.Fatalf("categories collection missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("name", "guest-cat")
	rec.Set("slug", "guest-cat")
	rec.Set("allowed_roles", []string{"guest", "player", "root"})
	rec.Set("permissions", types.JSONRaw([]byte(`{"create_topic":["guest","player"],"post_reply":["guest","player"]}`)))
	if err := app.Save(rec); err != nil {
		t.Fatalf("save guest category: %v", err)
	}
	return rec.Id
}

// TestGuestCreateTopicProjectsNickname: a guest-created topic must carry
// guest_nickname on the topic row AND point its last_post projection at the
// opening post.
func TestGuestCreateTopicProjectsNickname(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	body := fmt.Sprintf(`{"category_id":"%s","title":"Guest Topic","content":"Hello from a guest","guest_nickname":"TestGuest"}`, catID)
	status, resp := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", body, map[string]string{
		"Idempotency-Key": "idem-guest-topic-1",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest topic create: status=%d body=%s", status, resp)
	}

	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Guest Topic'")
	if err != nil || topic == nil {
		t.Fatalf("guest topic not created: %v", err)
	}
	if got := topic.GetString(lastPostGuestDisplayNameField); got != "TestGuest" {
		t.Fatalf("topic.last_post_guest_display_name = %q, want %q — the forum index reads this column", got, "TestGuest")
	}
	if got := topic.GetString("last_post_author_id"); got != "" {
		t.Fatalf("topic.last_post_author_id = %q, want empty for a guest", got)
	}
	if got := topic.GetString(authorKindField); got != authorKindGuest {
		t.Fatalf("topic.author_kind = %q, want guest", got)
	}
	if got := topic.GetString(guestDisplayNameField); got != "TestGuest" {
		t.Fatalf("topic.guest_display_name = %q, want TestGuest", got)
	}
	if topic.GetString("last_post_id") == "" {
		t.Fatal("topic.last_post_id must point at the opening post")
	}
	opening, err := app.FindRecordById(postsCollectionName, topic.GetString("last_post_id"))
	if err != nil || opening == nil {
		t.Fatalf("guest opening post missing: %v", err)
	}
	if got := opening.GetString(authorKindField); got != authorKindGuest {
		t.Fatalf("opening post.author_kind = %q, want guest", got)
	}
	if got := opening.GetString(guestDisplayNameField); got != "TestGuest" {
		t.Fatalf("opening post.guest_display_name = %q, want TestGuest", got)
	}

	// The forum index must name the guest.
	status, body2 := getAerun(t, server.URL+"/api/aerun/forum-index")
	if status != http.StatusOK {
		t.Fatalf("forum-index: status=%d body=%s", status, body2)
	}
	if !bytes.Contains(body2, []byte(`"last_post_author_name":"TestGuest"`)) {
		t.Fatalf("forum-index must carry last_post_author_name=TestGuest: %s", body2)
	}
}

// TestGuestReplyProjectsNickname: a guest REPLY must advance the topic's
// guest_nickname projection to the replier's name.
func TestGuestReplyProjectsNickname(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// A member creates the topic.
	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"Mixed Topic","content":"Opening by player"}`, catID)
	status, resp := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-guest-reply-topic",
	})
	if status != http.StatusCreated {
		t.Fatalf("player topic create: status=%d body=%s", status, resp)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Mixed Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}
	if got := topic.GetString(lastPostGuestDisplayNameField); got != "" {
		t.Fatalf("topic.last_post_guest_display_name = %q before any guest reply, want empty", got)
	}

	// A guest replies.
	replyBody := `{"content":"Reply from a guest","guest_nickname":"GuestReplier"}`
	status, resp = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Idempotency-Key": "idem-guest-reply-1",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest reply: status=%d body=%s", status, resp)
	}

	topic, err = app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topic == nil {
		t.Fatalf("topic missing after reply: %v", err)
	}
	if got := topic.GetString(lastPostGuestDisplayNameField); got != "GuestReplier" {
		t.Fatalf("topic.last_post_guest_display_name = %q after guest reply, want %q", got, "GuestReplier")
	}
	if got := topic.GetString("last_post_author_id"); got != "" {
		t.Fatalf("topic.last_post_author_id = %q, want empty for a guest reply", got)
	}
	guestPost, err := app.FindFirstRecordByFilter(postsCollectionName, "topic_id = {:topic} && guest_display_name = {:name}", dbx.Params{
		"topic": topic.Id,
		"name":  "GuestReplier",
	})
	if err != nil || guestPost == nil {
		t.Fatalf("guest reply with AuthorRef missing: %v", err)
	}
	if got := guestPost.GetString(authorKindField); got != authorKindGuest {
		t.Fatalf("guest reply.author_kind = %q, want guest", got)
	}

	// The forum index must name the guest replier.
	status, body2 := getAerun(t, server.URL+"/api/aerun/forum-index")
	if status != http.StatusOK {
		t.Fatalf("forum-index: status=%d body=%s", status, body2)
	}
	if !bytes.Contains(body2, []byte(`"last_post_author_name":"GuestReplier"`)) {
		t.Fatalf("forum-index must carry last_post_author_name=GuestReplier: %s", body2)
	}
}

// TestGuestReplyQuotesUserReceivesNotificationViaHttp: when a guest quotes a user's
// post in a reply via HTTP POST, the quoted user must receive a post_quoted notification.
func TestGuestReplyQuotesUserReceivesNotificationViaHttp(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// A member creates the topic.
	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"Quoted Topic","content":"Original user message"}`, catID)
	status, resp := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-quoted-topic-opener",
	})
	if status != http.StatusCreated {
		t.Fatalf("player topic create: status=%d body=%s", status, resp)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Quoted Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}
	openerPostID := topic.GetString("last_post_id")
	if openerPostID == "" {
		t.Fatal("topic missing last_post_id")
	}

	// Guest replies, quoting the opener post of fixPlayerID.
	quoteText := fmt.Sprintf(`[quote="#p%s,t%s,Player One"]Original user message[/quote] Guest response`, openerPostID, topic.Id)
	replyBody := fmt.Sprintf(`{"content":%q,"guest_nickname":"GuestQuoteTester"}`, quoteText)
	status, resp = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Idempotency-Key": "idem-guest-quote-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest quote reply: status=%d body=%s", status, resp)
	}

	// Player One must receive 1 post_quoted notification.
	if n := notificationCount(t, app, fixPlayerID); n != 1 {
		t.Fatalf("quoted user received %d notifications, want 1", n)
	}

	notif, err := app.FindFirstRecordByFilter(notificationsCollectionName, "recipient_id = {:u}", dbx.Params{"u": fixPlayerID})
	if err != nil || notif == nil {
		t.Fatalf("notification not found: %v", err)
	}
	if got := notif.GetString("type"); got != "post_quoted" {
		t.Errorf("notification type = %q, want post_quoted", got)
	}
	payload := notificationPayload(notif)["payload"].(map[string]any)
	if got := payload["author_nickname"]; got != "GuestQuoteTester" {
		t.Errorf("payload.author_nickname = %v, want GuestQuoteTester", got)
	}
}
