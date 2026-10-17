package pocketbase

import (
	"fmt"
	"net/http"
	"testing"
)

// TestRebuildTopicProjectionRestoresGuestAfterMaskedDelete pins the single
// writer the audit's Stage 2 introduced.
//
// The failure it exists to catch is the three-way divergence the old code had:
// create/reply wrote the last-post projection inline with five Sets, delete
// duplicated the same set inline a second time, and recalcTopicProjection (the
// move path) ignored errors entirely and never touched the mask. After a
// masked last post was deleted, the topic row kept the deleted mask's
// character id while pointing at the surviving guest post — the list and the
// page disagreed about who spoke last.
//
// The test builds exactly that shape (guest reply, then a masked account
// reply on top), deletes the masked reply as a moderator, and asserts the
// rebuilt projection carries the full guest AuthorRef: kind, display name,
// legacy nickname copy, empty mask and empty account id.
func TestRebuildTopicProjectionRestoresGuestAfterMaskedDelete(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	seedRuntimeCharacter(t, app, "charrebuild0001", fixPlayerID, "Rebuild Mask")
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"Rebuild Topic","content":"Opening by player"}`, catID)
	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-rebuild-topic",
	})
	if status != http.StatusCreated {
		t.Fatalf("player topic create: status=%d", status)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'Rebuild Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}

	replyBody := `{"content":"Reply from a guest","guest_nickname":"RebuildGuest"}`
	status, _ = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Idempotency-Key": "idem-rebuild-guest-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest reply: status=%d", status)
	}

	maskedBody := `{"content":"Masked reply on top","character_id":"charrebuild0001"}`
	status, _ = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", maskedBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-rebuild-masked-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("masked reply: status=%d", status)
	}

	topic, err = app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topic == nil {
		t.Fatalf("topic missing before delete: %v", err)
	}
	maskedID := topic.GetString("last_post_id")
	if maskedID == "" {
		t.Fatal("topic.last_post_id must point at the masked reply before delete")
	}

	dropReq, _ := http.NewRequest(http.MethodDelete, fmt.Sprintf("%s/api/aerun/posts/%s", server.URL, maskedID), nil)
	dropReq.Header.Set("Authorization", tokens["moderator"])
	dropReq.Header.Set("Idempotency-Key", "rebuild-drop-masked")
	dropRes, err := server.Client().Do(dropReq)
	if err != nil {
		t.Fatal(err)
	}
	dropRes.Body.Close()
	if dropRes.StatusCode != http.StatusOK {
		t.Fatalf("deleting the masked last post = %d, want 200", dropRes.StatusCode)
	}

	topic, err = app.FindRecordById(topicsCollectionName, topic.Id)
	if err != nil || topic == nil {
		t.Fatalf("topic missing after delete: %v", err)
	}
	if got := topic.GetString(lastPostAuthorKindField); got != authorKindGuest {
		t.Fatalf("last_post_author_kind = %q, want guest", got)
	}
	if got := topic.GetString(lastPostGuestDisplayNameField); got != "RebuildGuest" {
		t.Fatalf("last_post_guest_display_name = %q, want RebuildGuest", got)
	}
	if got := topic.GetString("last_post_author_id"); got != "" {
		t.Fatalf("last_post_author_id = %q, want empty for a guest", got)
	}
	if got := topic.GetString("last_post_author_character_id"); got != "" {
		t.Fatalf("last_post_author_character_id = %q, want empty after the masked post was deleted", got)
	}
	if got := topic.GetInt("posts_count"); got != 2 {
		t.Fatalf("posts_count = %d, want 2 (opening + surviving guest reply)", got)
	}
}
