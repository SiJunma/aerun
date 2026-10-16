package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

// TestNestedAuthorDTOsCarryTheAdrContract pins the Stage 2.3 public shape.
//
// The flat compatibility fields (author_id/guest_nickname/last_post_*) remain,
// but they are derived copies emitted by one adapter — the nested
// `author`/`last_post_author` objects are the contract new readers use, and
// they must agree with the stored variant columns: account => user_id,
// guest => display_name, and never an invented identity for an unclassified
// row.
func TestNestedAuthorDTOsCarryTheAdrContract(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// Guest creates the topic: opener and last post are both the guest.
	tokens := seedIdentityFixtures(t, app)
	catID := seedGuestCategory(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	topicBody := fmt.Sprintf(`{"category_id":"%s","title":"DTO Topic","content":"Hello","guest_nickname":"DTOGuest"}`, catID)
	status, _ := postAerunWithHeaders(t, server.URL+"/api/aerun/topics", topicBody, map[string]string{
		"Idempotency-Key": "idem-dto-topic",
	})
	if status != http.StatusCreated {
		t.Fatalf("guest topic create: status=%d", status)
	}
	topic, err := app.FindFirstRecordByFilter(topicsCollectionName, "title = 'DTO Topic'")
	if err != nil || topic == nil {
		t.Fatalf("topic not created: %v", err)
	}

	// Read it back through the API so we assert the SERVED shape, not just
	// the record adapter in isolation.
	status, body := getAerun(t, server.URL+"/api/aerun/topics/"+topic.Id)
	if status != http.StatusOK {
		t.Fatalf("get topic: status=%d body=%s", status, body)
	}
	var resp struct {
		Topic struct {
			Author           map[string]any `json:"author"`
			LastPostAuthorRef map[string]any `json:"last_post_author_ref"`
			AuthorID         string         `json:"author_id"`
			GuestNickname    string         `json:"guest_nickname"`
		} `json:"topic"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode topic response: %v", err)
	}

	if resp.Topic.Author["kind"] != "guest" {
		t.Errorf("author.kind = %v, want guest", resp.Topic.Author["kind"])
	}
	if resp.Topic.Author["user_id"] != nil {
		t.Errorf("author.user_id = %v, want null for a guest", resp.Topic.Author["user_id"])
	}
	if got, _ := resp.Topic.Author["display_name"].(string); got != "DTOGuest" {
		t.Errorf("author.display_name = %v, want DTOGuest", resp.Topic.Author["display_name"])
	}
	if resp.Topic.Author["character_id"] != nil {
		t.Errorf("author.character_id = %v, want null for a guest", resp.Topic.Author["character_id"])
	}
	// The deprecated flat copies must agree with the nested object.
	if resp.Topic.AuthorID != "" || resp.Topic.GuestNickname != "DTOGuest" {
		t.Errorf("flat copies author_id=%q guest_nickname=%q, want empty/DTOGuest", resp.Topic.AuthorID, resp.Topic.GuestNickname)
	}
	if resp.Topic.LastPostAuthorRef["kind"] != "guest" {
		t.Errorf("last_post_author_ref.kind = %v, want guest", resp.Topic.LastPostAuthorRef["kind"])
	}

	// Now a member replies: the last-post ref must become an account while the
	// opener ref stays the guest.
	replyBody := `{"content":"Reply from player"}`
	status, _ = postAerunWithHeaders(t, server.URL+"/api/aerun/topics/"+topic.Id+"/posts", replyBody, map[string]string{
		"Authorization":   tokens["player"],
		"Idempotency-Key": "idem-dto-reply",
	})
	if status != http.StatusCreated {
		t.Fatalf("player reply: status=%d", status)
	}
	status, body = getAerun(t, server.URL+"/api/aerun/topics/"+topic.Id)
	if status != http.StatusOK {
		t.Fatalf("re-read topic: status=%d body=%s", status, body)
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode re-read: %v", err)
	}
	if resp.Topic.Author["kind"] != "guest" {
		t.Errorf("opener author.kind = %v, want guest after a reply", resp.Topic.Author["kind"])
	}
	if resp.Topic.LastPostAuthorRef["kind"] != "account" {
		t.Errorf("last_post_author_ref.kind = %v, want account after a member reply", resp.Topic.LastPostAuthorRef["kind"])
	}
	if resp.Topic.LastPostAuthorRef["user_id"] != fixPlayerID {
		t.Errorf("last_post_author_ref.user_id = %v, want %s", resp.Topic.LastPostAuthorRef["user_id"], fixPlayerID)
	}
	// The nested display_name is the RESOLVED nickname, mirrored from the same
	// flat field the legacy components read — one adapter, so the two cannot
	// disagree. It must be non-empty for a live account.
	if got, _ := resp.Topic.LastPostAuthorRef["display_name"].(string); got == "" {
		t.Errorf("last_post_author_ref.display_name = %v, want the resolved account nickname", resp.Topic.LastPostAuthorRef["display_name"])
	}
}

// TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir pins the boot guard.
//
// The failure it exists to catch is silent by construction: PocketBase's
// Record.Set on a missing field is a no-op, so a database restored from a
// snapshot taken before migration 1769800000/1770000000 keeps serving 200s
// while every guest write quietly drops its author identity and the index
// renders "Deleted user". A guard that returns nil here would restore exactly
// the silence the audit removed together with repairGuestNicknameSchema.
func TestVerifyAuthorRefSchemaRejectsAnUnmigratedDataDir(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// The test app has migrations applied, so the healthy path must pass.
	if err := verifyAuthorRefSchema(app); err != nil {
		t.Fatalf("a migrated data dir must pass the guard: %v", err)
	}

	// Drop the AuthorRef fields the way a restore from a pre-migration backup
	// would. The cached collection is what OnServe reads, so this mirrors a
	// binary that postdates the snapshot.
	for _, collectionName := range []string{postsCollectionName, topicsCollectionName} {
		collection, err := app.FindCachedCollectionByNameOrId(collectionName)
		if err != nil {
			t.Fatal(err)
		}
		collection.Fields.RemoveByName(authorKindField)
		collection.Fields.RemoveByName(guestDisplayNameField)
		if collectionName == topicsCollectionName {
			collection.Fields.RemoveByName(lastPostAuthorKindField)
			collection.Fields.RemoveByName(lastPostGuestDisplayNameField)
		}
		if err := app.Save(collection); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.ReloadCachedCollections(); err != nil {
		t.Fatal(err)
	}

	if err := verifyAuthorRefSchema(app); err == nil {
		t.Fatal("the guard must reject a data dir without the AuthorRef columns; " +
			"otherwise guest writes degrade silently again")
	}
}
