package pocketbase

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func seedTestPost(t testing.TB, app *tests.TestApp, topicID, authorID, content string, backdate time.Duration) *core.Record {
	t.Helper()
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	post := core.NewRecord(postsCol)
	post.Set("topic_id", topicID)
	post.Set("author_id", authorID)
	post.Set("content", content)
	if err := app.Save(post); err != nil {
		t.Fatalf("seed post %q: %v", content, err)
	}
	if backdate > 0 {
		created := time.Now().Add(-backdate).UTC().Format("2006-01-02 15:04:05.000Z")
		if _, err := app.DB().NewQuery(
			"UPDATE " + postsCollectionName + " SET created = {:created} WHERE id = {:id}",
		).Bind(map[string]any{"created": created, "id": post.Id}).Execute(); err != nil {
			t.Fatalf("failed to backdate post %s: %v", post.Id, err)
		}
		// reload
		post, err = app.FindRecordById(postsCollectionName, post.Id)
		if err != nil {
			t.Fatal(err)
		}
	}
	return post
}

func TestListPostsLocatesTargetPost(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Locate post topic")

	// Backdate the opening post to 50 minutes ago so it is strictly the earliest post
	openingPostID := openingPostIDFor(t, app, fixPlayerID, topicID)
	created50 := time.Now().Add(-50 * time.Minute).UTC().Format("2006-01-02 15:04:05.000Z")
	if _, err := app.DB().NewQuery("UPDATE " + postsCollectionName + " SET created = {:created} WHERE id = {:id}").
		Bind(map[string]any{"created": created50, "id": openingPostID}).Execute(); err != nil {
		t.Fatal(err)
	}

	// Add 4 more posts with distinct timestamps.
	p2 := seedTestPost(t, app, topicID, fixPlayerID, "reply 2", 40*time.Minute)
	p3 := seedTestPost(t, app, topicID, fixPlayerID, "reply 3", 30*time.Minute)
	p4 := seedTestPost(t, app, topicID, fixPlayerID, "reply 4", 20*time.Minute)
	p5 := seedTestPost(t, app, topicID, fixPlayerID, "reply 5", 10*time.Minute)

	// Update topic posts_count
	topic, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil {
		t.Fatal(err)
	}
	topic.Set("posts_count", 5)
	if err := app.Save(topic); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	// With limit=2:
	// Page 1: opening post, p2
	// Page 2: p3, p4
	// Page 3: p5

	// 1. Locate p2 -> page 1
	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topicID, p2.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate p2: got %d (%v)", status, payload)
	}
	if page, ok := payload["page"].(float64); !ok || int(page) != 1 {
		t.Errorf("locate p2: page = %v, want 1", payload["page"])
	}
	if targetID, _ := payload["target_post_id"].(string); targetID != p2.Id {
		t.Errorf("target_post_id = %v, want %s", payload["target_post_id"], p2.Id)
	}
	if found, ok := payload["target_found"].(bool); !ok || !found {
		t.Errorf("target_found = %v, want true", payload["target_found"])
	}
	items, _ := payload["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items count = %d, want 2", len(items))
	}

	// 2. Locate p3 -> page 2
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topicID, p3.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate p3: got %d (%v)", status, payload)
	}
	if page, ok := payload["page"].(float64); !ok || int(page) != 2 {
		t.Errorf("locate p3: page = %v, want 2", payload["page"])
	}
	if found, ok := payload["target_found"].(bool); !ok || !found {
		t.Errorf("target_found = %v, want true", payload["target_found"])
	}

	// 2b. Locate p4 -> also page 2
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topicID, p4.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate p4: got %d (%v)", status, payload)
	}
	if page, ok := payload["page"].(float64); !ok || int(page) != 2 {
		t.Errorf("locate p4: page = %v, want 2", payload["page"])
	}

	// 3. Locate p5 -> page 3
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topicID, p5.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate p5: got %d (%v)", status, payload)
	}
	if page, ok := payload["page"].(float64); !ok || int(page) != 3 {
		t.Errorf("locate p5: page = %v, want 3", payload["page"])
	}
	if found, ok := payload["target_found"].(bool); !ok || !found {
		t.Errorf("target_found = %v, want true", payload["target_found"])
	}
	items, _ = payload["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items count = %d, want 1", len(items))
	}
}

func TestListPostsLocateTargetPostDeleted(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Locate deleted topic")

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=missingpost0001&limit=2", topicID), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate missing: got %d (%v)", status, payload)
	}
	if page, ok := payload["page"].(float64); !ok || int(page) != 1 {
		t.Errorf("missing post page = %v, want fallback 1", payload["page"])
	}
	if found, ok := payload["target_found"].(bool); !ok || found {
		t.Errorf("target_found = %v, want false", payload["target_found"])
	}
	if targetID, _ := payload["target_post_id"].(string); targetID != "missingpost0001" {
		t.Errorf("target_post_id = %v, want missingpost0001", payload["target_post_id"])
	}
}

func TestListPostsLocateTargetPostMovedTopic(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topic1 := seedDraftTopic(t, app, fixPlayerID, "Topic 1")
	topic2 := seedDraftTopic(t, app, fixPlayerID, "Topic 2")

	pTopic2 := seedTestPost(t, app, topic2, fixPlayerID, "post in topic 2", 10*time.Minute)

	server := newTestServer(t, app)
	defer server.Close()

	// Query Topic 1 with a post that belongs to Topic 2
	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topic1, pTopic2.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate moved post: got %d (%v)", status, payload)
	}
	if found, ok := payload["target_found"].(bool); !ok || found {
		t.Errorf("target_found = %v, want false", payload["target_found"])
	}
	if movedTo, _ := payload["moved_to_topic_id"].(string); movedTo != topic2 {
		t.Errorf("moved_to_topic_id = %v, want %s", payload["moved_to_topic_id"], topic2)
	}
}

func TestListPostsLocateDraftExcluded(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "Draft locate topic")

	// Create a draft post
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	draft := core.NewRecord(postsCol)
	draft.Set("topic_id", topicID)
	draft.Set("author_id", fixPlayerID)
	draft.Set("content", "secret draft")
	draft.Set("is_draft", true)
	if err := app.Save(draft); err != nil {
		t.Fatal(err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?post=%s&limit=2", topicID, draft.Id), tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("locate draft: got %d (%v)", status, payload)
	}
	if found, ok := payload["target_found"].(bool); !ok || found {
		t.Errorf("draft target_found = %v, want false", payload["target_found"])
	}
}
