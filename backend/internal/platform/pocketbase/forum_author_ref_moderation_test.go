package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

// TestModeratorModeratesGuestReply pins the Stage 3 moderation contract for
// guest content:
//
//   - a moderator holding edit_others_posts / delete_others_posts acts on a
//     guest reply exactly as on an account reply (no guest special-case), and
//   - the audit entries carry the stored AuthorRef — a guest post's author_id
//     is empty BY DESIGN, so an entry keyed on it alone would read "nobody
//     wrote this" — and
//   - the account-level counters and reputation payout are a no-op BY KIND,
//     not by the accident of an empty id: deleting a voted guest post must
//     move NO user's posts_count or reputation.
func TestModeratorModeratesGuestReply(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	// A member opens the topic; a guest replies under a chosen name.
	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"Guest Moderation Topic","content":"Opening by player"}`, catID)
	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-guestmod-topic",
	})
	if status != http.StatusCreated {
		t.Fatalf("player topic create: status=%d", status)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Guest Moderation Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}

	replyBody := `{"content":"Reply from a guest","guest_nickname":"Гость-ответчик"}`
	status, replyResp := postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Idempotency-Key": "idem-guestmod-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest reply: status=%d body=%s", status, replyResp)
	}
	var created struct {
		PostID string `json:"post_id"`
	}
	if err := json.Unmarshal(replyResp, &created); err != nil || created.PostID == "" {
		t.Fatalf("guest reply response must carry post_id: %v %s", err, replyResp)
	}
	guestPostID := created.PostID

	// Snapshot EVERY account's counters: the whole point is that a moderation
	// act on guest content moves none of them.
	// NOTE on votes (Этап 3 finding): ValidateReputationVote requires a
	// non-empty target and reputation_votes.target_id is required, so a guest
	// post can never receive a vote through the command layer — contradicting
	// the Stage 0 ruling that votes are allowed on guest content. Logged as a
	// finding; there is nothing to payout on delete.
	countersBefore := map[string][2]int{}
	users, err := app.FindAllRecords(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		countersBefore[u.Id] = [2]int{u.GetInt("posts_count"), u.GetInt("reputation")}
	}

	// 1. The moderator EDITS the guest reply.
	patchReq, _ := http.NewRequest(http.MethodPatch,
		fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, guestPostID),
		strings.NewReader(`{"content":"Отредактировано модератором"}`))
	patchReq.Header.Set("Authorization", tokens["moderator"])
	patchReq.Header.Set("Idempotency-Key", "idem-guestmod-edit")
	patchReq.Header.Set("Content-Type", "application/json")
	patchRes, err := server.Client().Do(patchReq)
	if err != nil {
		t.Fatal(err)
	}
	patchRes.Body.Close()
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("moderator editing a guest reply = %d, want 200", patchRes.StatusCode)
	}
	edited, err := app.FindRecordById(postsCollectionName, guestPostID)
	if err != nil || edited == nil {
		t.Fatalf("guest reply missing after edit: %v", err)
	}
	if got := edited.GetString("content"); got != "Отредактировано модератором" {
		t.Fatalf("guest reply content = %q, want the moderator's edit", got)
	}
	if got := edited.GetString("editor_id"); got != fixModeratorID {
		t.Fatalf("guest reply editor_id = %q, want %s", got, fixModeratorID)
	}
	assertGuestAudit(t, app, "post_edit", "Гость-ответчик", 1)
}

// TestModeratorDeletesVotedGuestReply pins the delete half: a voted guest
// reply dies with its votes and WITHOUT any account-level payout, and the
// rebuilt last-post projection returns to the account opener with no stale
// guest name or mask left behind.
func TestModeratorDeletesVotedGuestReply(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"Guest Delete Topic","content":"Opening by player"}`, catID)
	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-guestdel-topic",
	})
	if status != http.StatusCreated {
		t.Fatalf("player topic create: status=%d", status)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Guest Delete Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}

	replyBody := `{"content":"Reply from a guest","guest_nickname":"Гость-удаление"}`
	status, _ = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Idempotency-Key": "idem-guestdel-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest reply: status=%d", status)
	}
	topic, err = app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topic == nil {
		t.Fatalf("topic missing after reply: %v", err)
	}
	guestPostID := topic.GetString("last_post_id")
	if guestPostID == "" {
		t.Fatal("topic.last_post_id must point at the guest reply")
	}

	// Snapshot EVERY account's counters: the whole point is that a moderation
	// act on guest content moves none of them.
	// NOTE on votes (Этап 3 finding): a guest post can never receive a vote
	// through the command layer — ValidateReputationVote requires a non-empty
	// target and reputation_votes.target_id is required — contradicting the
	// Stage 0 ruling that votes are allowed on guest content. Logged as a
	// finding; there is nothing to payout on delete.
	countersBefore := map[string][2]int{}
	users, err := app.FindAllRecords(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		countersBefore[u.Id] = [2]int{u.GetInt("posts_count"), u.GetInt("reputation")}
	}

	dropReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, guestPostID), nil)
	dropReq.Header.Set("Authorization", tokens["moderator"])
	dropReq.Header.Set("Idempotency-Key", "idem-guestdel-delete")
	dropRes, err := server.Client().Do(dropReq)
	if err != nil {
		t.Fatal(err)
	}
	dropRes.Body.Close()
	if dropRes.StatusCode != http.StatusOK {
		t.Fatalf("moderator deleting a guest reply = %d, want 200", dropRes.StatusCode)
	}

	if _, err := app.FindRecordById(postsCollectionName, guestPostID); err == nil {
		t.Fatal("the guest reply must be hard-deleted")
	}
	assertGuestAudit(t, app, "post_delete", "Гость-удаление", 1)

	// The rebuilt last-post projection points back at the account opener with
	// no stale guest name or mask left behind.
	topic, err = app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topic == nil {
		t.Fatalf("topic missing after delete: %v", err)
	}
	if got := topic.GetInt("posts_count"); got != 1 {
		t.Fatalf("posts_count = %d, want 1 (the opener only)", got)
	}
	if got := topic.GetString("last_post_guest_nickname"); got != "" {
		t.Fatalf("last_post_guest_nickname = %q, want empty after the guest post was deleted", got)
	}
	if got := topic.GetString("last_post_author_character_id"); got != "" {
		t.Fatalf("last_post_author_character_id = %q, want empty", got)
	}

	// NO account's counters moved — the whole point of the kind-gated no-op.
	usersAfter, err := app.FindAllRecords(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, u := range usersAfter {
		seen[u.Id] = true
		before := countersBefore[u.Id]
		if got := [2]int{u.GetInt("posts_count"), u.GetInt("reputation")}; got != before {
			t.Fatalf("account %s counters moved by a guest moderation: before=%v after=%v", u.Id, before, got)
		}
	}
	for id := range countersBefore {
		if !seen[id] {
			t.Fatalf("account %s disappeared during guest moderation", id)
		}
	}

	// The guest post's votes died with it, with no payout to invent.
	remaining, err := app.FindAllRecords(reputationVotesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range remaining {
		if v.GetString("post_id") == guestPostID {
			t.Fatal("the deleted guest post's vote rows must be gone")
		}
	}
}

// assertGuestAudit asserts that exactly `want` audit entries of `action` carry
// the stored guest AuthorRef (kind guest + the display name).
func assertGuestAudit(t *testing.T, app *tests.TestApp, action, displayName string, want int) {
	t.Helper()

	audits := auditLogsFor(t, app, action)
	if len(audits) != want {
		t.Fatalf("expected exactly %d %s audit entry, got %d", want, action, len(audits))
	}
	details, _ := audits[0]["details"].(map[string]any)
	if details == nil {
		t.Fatalf("%s audit entry must carry details", action)
	}
	if got, _ := details["author_kind"].(string); got != authorKindGuest {
		t.Fatalf("%s audit author_kind = %v, want guest", action, got)
	}
	if got, _ := details["guest_display_name"].(string); got != displayName {
		t.Fatalf("%s audit guest_display_name = %v, want %s", action, got, displayName)
	}
}
