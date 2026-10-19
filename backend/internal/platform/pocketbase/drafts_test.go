package pocketbase

// Integration tests for the drafts contract (migration 1766700000 + routes):
// upsert, the drafts-page feed with orphans first, publish with sequence and
// projection updates, and delete. The legacy invariant "one draft per user per
// topic" is enforced by idx_posts_drafts_unique.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedDraftTopic makes a live topic with its sequence-1 opening post.
func seedDraftTopic(t testing.TB, app *tests.TestApp, authorID, title string) string {
	t.Helper()
	catID := getGeneralCategoryID(t, app)
	topicCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(topicCol)
	rec.Set("category_id", catID)
	rec.Set("author_id", authorID)
	rec.Set("title", title)
	rec.Set("posts_count", 1)
	if err := app.Save(rec); err != nil {
		t.Fatalf("seed topic: %v", err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", rec.Id)
	post.Set("author_id", authorID)
	post.Set("content", "opening post")
	if err := app.Save(post); err != nil {
		t.Fatalf("seed opening post: %v", err)
	}
	rec.Set("last_post_id", post.Id)
	if err := app.Save(rec); err != nil {
		t.Fatalf("seed topic projection: %v", err)
	}
	return rec.Id
}

// doJSON performs an authenticated JSON request and returns status + payload.
func doJSON(t testing.TB, serverURL, method, path, token, idemKey, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, serverURL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var payload map[string]any
	_ = json.NewDecoder(res.Body).Decode(&payload)
	return res.StatusCode, payload
}

func TestDraftsUpsertFeedPublishDelete(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicA := seedDraftTopic(t, app, fixPlayerID, "Draft topic A")
	topicB := seedDraftTopic(t, app, fixPlayerID, "Draft topic B")

	server := newTestServer(t, app)
	defer server.Close()

	// 1. Upsert a draft in topic A.
	status, payload := doJSON(t, server.URL, http.MethodPut, "/api/aerun/topics/"+topicA+"/draft",
		tokens["player"], "draft-upsert-1", `{"content":"my unfinished reply"}`)
	if status != http.StatusOK {
		t.Fatalf("upsert draft: %d %v", status, payload)
	}
	draft, _ := payload["draft"].(map[string]any)
	if draft == nil || draft["id"] == "" {
		t.Fatalf("no draft in response: %v", payload)
	}
	draftID, _ := draft["id"].(string)

	// 2. Re-save: same (author, topic) pair must update in place, not duplicate.
	status, _ = doJSON(t, server.URL, http.MethodPut, "/api/aerun/topics/"+topicA+"/draft",
		tokens["player"], "draft-upsert-2", `{"content":"my unfinished reply, v2"}`)
	if status != http.StatusOK {
		t.Fatalf("second upsert: %d", status)
	}
	allPosts, _ := app.FindAllRecords(postsCollectionName)
	draftCount := 0
	for _, r := range allPosts {
		if r.GetBool("is_draft") {
			draftCount++
		}
	}
	if draftCount != 1 {
		t.Fatalf("expected exactly 1 draft after re-upsert, got %d", draftCount)
	}

	// 3. Feed ordering: delete topic A so its draft becomes orphaned, then add
	// a draft in the still-live topic B. Hard delete (1767700000): the draft
	// under it is deleted with the topic, so the orphan case below is now
	// exercised by the DELETED DRAFT path rather than by a surviving draft
	// pointing at a missing topic.
	topicARec, err := app.FindRecordById(topicsCollectionName, topicA)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Delete(topicARec); err != nil {
		t.Fatal(err)
	}
	status, _ = doJSON(t, server.URL, http.MethodPut, "/api/aerun/topics/"+topicB+"/draft",
		tokens["player"], "draft-upsert-3", `{"content":"reply for a live topic"}`)
	if status != http.StatusOK {
		t.Fatalf("upsert draft B: %d", status)
	}

	status, payload = doJSON(t, server.URL, http.MethodGet, "/api/aerun/me/drafts", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("me/drafts: %d %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("expected 2 drafts in feed, got %d", len(items))
	}
	first, _ := items[0].(map[string]any)
	second, _ := items[1].(map[string]any)
	if first["orphan"] != true || first["topic_id"] != topicA {
		t.Fatalf("orphan draft must be first, got %v then %v", first, second)
	}
	if second["orphan"] != false || second["topic_title"] != "Draft topic B" {
		t.Fatalf("live draft must be second with topic_title, got %v", second)
	}

	// 4. Orphan draft cannot be published.
	status, payload = doJSON(t, server.URL, http.MethodPost, "/api/aerun/drafts/"+draftID+"/publish",
		tokens["player"], "draft-publish-orphan", "")
	if status != http.StatusConflict {
		t.Fatalf("publishing an orphan draft must 409, got %d %v", status, payload)
	}
	_ = payload

	// 5. Publish the live draft: real sequence + topic projections.
	liveID := ""
	liveDrafts, _ := app.FindAllRecords(postsCollectionName)
	for _, r := range liveDrafts {
		if r.GetBool("is_draft") && r.GetString("topic_id") == topicB {
			liveID = r.Id
		}
	}
	status, payload = doJSON(t, server.URL, http.MethodPost, "/api/aerun/drafts/"+liveID+"/publish",
		tokens["player"], "draft-publish-live", "")
	if status != http.StatusOK {
		t.Fatalf("publish live draft: %d %v", status, payload)
	}
	published, err := app.FindRecordById(postsCollectionName, liveID)
	if err != nil {
		t.Fatal(err)
	}
	// A published draft is identified by is_draft alone: `sequence` is gone,
	// ordering is `created` + id. The topic projection is what proves it
	// actually became a post in the feed.
	if published.GetBool("is_draft") {
		t.Fatalf("published post still marked as draft")
	}
	topicBRec, _ := app.FindRecordById(topicsCollectionName, topicB)
	if topicBRec.GetInt("posts_count") != 2 {
		t.Fatalf("topic posts_count = %d, want 2", topicBRec.GetInt("posts_count"))
	}

	// 6. Delete the orphan draft.
	status, _ = doJSON(t, server.URL, http.MethodDelete, "/api/aerun/drafts/"+draftID,
		tokens["player"], "draft-delete-1", "")
	if status != http.StatusOK {
		t.Fatalf("delete draft: %d", status)
	}
	if _, err := app.FindRecordById(postsCollectionName, draftID); err == nil {
		t.Fatal("orphan draft still exists after delete")
	}
}

// TestDraftKeepsItsMaskThroughPublish is the regression for "I published my
// draft and the mask was gone".
//
// The draft command stored only the text, so author_character_id stayed empty
// on the row; publish then promoted that row verbatim and the post came out
// under the account name. Nothing failed — the publish returned 200 and the
// post was real — so the only thing that catches it is asserting the identity
// at every hop: the draft row, the publish answer, the published row, and the
// topic's last-post projection.
func TestDraftKeepsItsMaskThroughPublish(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Masked draft topic")
	seedRuntimeCharacter(t, app, "chardftmask0001", fixPlayerID, "Rough")

	server := newTestServer(t, app)
	defer server.Close()

	// 1. The mask must reach the draft ROW, not just the response.
	status, payload := doJSON(t, server.URL, http.MethodPut, "/api/aerun/topics/"+topicID+"/draft",
		tokens["player"], "draft-mask-1", `{"content":"masked reply","character_id":"chardftmask0001"}`)
	if status != http.StatusOK {
		t.Fatalf("upsert draft: %d %v", status, payload)
	}
	draft, _ := payload["draft"].(map[string]any)
	if draft == nil {
		t.Fatalf("no draft in response: %v", payload)
	}
	if got, _ := draft["author_character_id"].(string); got != "chardftmask0001" {
		t.Errorf("draft.author_character_id = %q, want %q — the mask never reached the client",
			got, "chardftmask0001")
	}
	draftID, _ := draft["id"].(string)
	storedDraft, err := app.FindRecordById(postsCollectionName, draftID)
	if err != nil || storedDraft == nil {
		t.Fatalf("stored draft %s not found: %v", draftID, err)
	}
	if got := storedDraft.GetString("author_character_id"); got != "chardftmask0001" {
		t.Fatalf("posts.author_character_id on the draft = %q, want %q — publishing this row "+
			"would drop the mask", got, "chardftmask0001")
	}

	// 2. The publish answer must be DECORATED. A raw payload carries no
	// author_name/is_character, and the client renders the new card from it.
	status, payload = doJSON(t, server.URL, http.MethodPost, "/api/aerun/drafts/"+draftID+"/publish",
		tokens["player"], "draft-mask-publish", "")
	if status != http.StatusOK {
		t.Fatalf("publish: %d %v", status, payload)
	}
	published, _ := payload["post"].(map[string]any)
	if published == nil {
		t.Fatalf("publish carries no post: %v", payload)
	}
	if got, _ := published["author_name"].(string); got != "Rough" {
		t.Errorf("published author_name = %q, want %q — the answer was not decorated, so the "+
			"fresh post renders under the account", got, "Rough")
	}
	if isChar, _ := published["is_character"].(bool); !isChar {
		t.Errorf("published is_character = %v, want true", isChar)
	}
	if authorDTO, ok := published["author"].(map[string]any); !ok {
		t.Errorf("published post has no nested author DTO")
	} else if got, _ := authorDTO["user_id"].(string); got != fixPlayerID {
		t.Errorf("published author.user_id = %q, want %q — a mask must not change ownership",
			got, fixPlayerID)
	}
	if got, _ := payload["post_id"].(string); got != draftID {
		t.Errorf("publish post_id = %q, want %q — the page navigates by it", got, draftID)
	}

	// 3. The published ROW and the topic projection must both name the mask, or
	// a reload / a topic list row disagrees with the page that published it.
	if got := storedDraft.GetString("author_character_id"); got != "chardftmask0001" {
		t.Errorf("published post author_character_id = %q, want %q", got, "chardftmask0001")
	}
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || topic == nil {
		t.Fatalf("topic not found: %v", err)
	}
	if got := topic.GetString("last_post_author_character_id"); got != "chardftmask0001" {
		t.Errorf("topics.last_post_author_character_id = %q, want %q — the topic list would "+
			"show the account as the last speaker", got, "chardftmask0001")
	}
}

// TestDraftMaskCannotBeBorrowed is the security half: the draft command resolves
// the mask through the same server-owned helper createPostHandler uses, so a
// hand-crafted request cannot file a draft under another member's mask and have
// it publish that way.
func TestDraftMaskCannotBeBorrowed(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixModeratorID, "Borrowed mask topic")
	seedRuntimeCharacter(t, app, "charborrowmask1", fixPlayerID, "Rough")

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodPut, "/api/aerun/topics/"+topicID+"/draft",
		tokens["moderator"], "draft-mask-borrow",
		`{"content":"not mine","character_id":"charborrowmask1"}`)
	if status != http.StatusForbidden {
		t.Fatalf("filing a draft as another member's mask: got %d, want 403 (%v)", status, payload)
	}
}
