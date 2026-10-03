package pocketbase

// TestTopicReadModelCarriesWhatTheClientReads pins the response contract the
// browser depends on, field by field.
//
// Every failure behind this file was the same shape: the Go command layer
// answered with a correct, tested payload, and the frontend read a key that had
// never existed. Nothing failed loudly, because `res?.posts || []` on a missing
// key is an empty page rather than an exception.
//
// The three symptoms it reproduces:
//   - POST /topics answered `{topic, first_post}`; the form read `topicId`, so
//     it navigated to /topic/undefined and showed "topic not found" for a topic
//     that had just been written;
//   - GET /topics and the post list answered `items`; the client read
//     `topics`/`posts`, so a populated category and a populated topic both
//     rendered empty;
//   - categories carried no counters at all, so the index showed 0/0 and
//     "no posts" no matter what existed.
//
// Each assertion names one key the UI reads, so a failure points at the field
// rather than at "the forum is broken". The client-side half of the contract is
// pinned by scripts/check-forum-read-contract.mjs.

import (
	"fmt"
	"net/http"
	"testing"
)

func TestTopicReadModelCarriesWhatTheClientReads(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	// A real create, through the real endpoint: the response under test is the
	// one a browser receives, not one assembled by a fixture.
	status, payload := doJSON(t, server.URL, http.MethodPost,
		"/api/aerun/topics",
		tokens["player"], "idem-read-contract-1",
		fmt.Sprintf(`{"category_id":"%s","title":"Contract Topic","content":"Body"}`, catID))
	if status != http.StatusCreated {
		t.Fatalf("create topic: got %d, want 201 (%v)", status, payload)
	}

	topicMap, _ := payload["topic"].(map[string]any)
	if topicMap == nil {
		t.Fatalf("create response carries no `topic` object: %#v", payload)
	}
	topicID, _ := topicMap["id"].(string)
	if topicID == "" {
		t.Fatalf("create response `topic.id` is empty: %#v", topicMap)
	}
	// The form navigates to exactly this id. Without it the member is sent to
	// /topic/undefined — the bug this test exists for.
	if payload["topic_id"] != topicID {
		t.Errorf("create response `topic_id` = %v, want %q (the topic form navigates with it)", payload["topic_id"], topicID)
	}
	firstPost, _ := payload["first_post"].(map[string]any)
	if firstPost == nil {
		t.Fatalf("create response carries no `first_post` object: %#v", payload)
	}
	if id, _ := firstPost["id"].(string); id == "" {
		t.Errorf("first_post.id is empty: %#v", firstPost)
	}
	if author, _ := firstPost["author_name"].(string); author == "" {
		t.Errorf("first_post.author_name is empty — the opening post would render as \"—\": %#v", firstPost)
	}
	if author, _ := topicMap["author_name"].(string); author == "" {
		t.Errorf("topic.author_name is empty — the topic row would render as \"—\": %#v", topicMap)
	}
	// The category listing, and the paging metadata the pager divides by.
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics?category_id=%s&page=1&limit=20", catID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list topics: got %d, want 200 (%v)", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("category holds one topic but `items` has %d — the client reads `items`, not `topics`: %#v",
			len(items), payload)
	}
	if total, _ := payload["total"].(float64); int(total) != 1 {
		t.Errorf("`total` = %v, want 1 (the category pager divides by it)", payload["total"])
	}
	first, _ := items[0].(map[string]any)
	if author, _ := first["author_name"].(string); author == "" {
		t.Errorf("listed topic.author_name is empty: %#v", first)
	}

	// The category index: counters and the last-post summary. Derived on read,
	// so they cannot drift from the topics themselves.
	status, payload = doJSON(t, server.URL, http.MethodGet, "/api/aerun/categories",
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list categories: got %d, want 200 (%v)", status, payload)
	}
	cats, _ := payload["items"].([]any)
	var general map[string]any
	for _, raw := range cats {
		entry, _ := raw.(map[string]any)
		if entry["id"] == catID {
			general = entry
		}
	}
	if general == nil {
		t.Fatalf("the category that just received a topic is not in the list: %#v", payload)
	}
	if count, _ := general["topics_count"].(float64); int(count) != 1 {
		t.Errorf("topics_count = %v, want 1 (the index renders this number)", general["topics_count"])
	}
	if count, _ := general["posts_count"].(float64); int(count) != 1 {
		t.Errorf("posts_count = %v, want 1 (the index renders this number)", general["posts_count"])
	}
	if general["last_post_topic_id"] != topicID {
		t.Errorf("last_post_topic_id = %v, want %q (the index links to it)",
			general["last_post_topic_id"], topicID)
	}
	if author, _ := general["last_post_author"].(string); author == "" {
		t.Errorf("last_post_author is empty: %#v", general)
	}

	// The post list, under the key the client reads.
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics/%s/posts?page=1&limit=20", topicID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list posts: got %d, want 200 (%v)", status, payload)
	}
	posts, _ := payload["items"].([]any)
	if len(posts) != 1 {
		t.Fatalf("topic holds one post but `items` has %d — the client reads `items`, not `posts`: %#v",
			len(posts), payload)
	}
	post, _ := posts[0].(map[string]any)
	if author, _ := post["author_name"].(string); author == "" {
		t.Errorf("post.author_name is empty — the post sidebar would render as \"—\": %#v", post)
	}

	// A reply must hand back an id the page can navigate to. It used to look for
	// `postId`, which no route ever sent, so the reply was written and then the
	// page refused to scroll to it.
	status, payload = doJSON(t, server.URL, http.MethodPost,
		fmt.Sprintf("/api/aerun/topics/%s/posts", topicID),
		tokens["player"], "idem-read-contract-2", `{"content":"A reply"}`)
	if status != http.StatusCreated {
		t.Fatalf("create post: got %d, want 201 (%v)", status, payload)
	}
	if id, _ := payload["post_id"].(string); id == "" {
		t.Errorf("create post response carries no `post_id` — the reply cannot be navigated to: %#v", payload)
	}
}
