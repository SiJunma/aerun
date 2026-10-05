package pocketbase

import (
	"fmt"
	"net/http"
	"testing"
)

// TestCategoryCountersFollowRealTopics proves the index numbers are derived
// rather than copied: create a topic, delete it, and watch both counters return
// to zero. A cached counter would still be showing the deleted topic — the
// drift the Firestore trigger-based projection used to accumulate.
func TestCategoryCountersFollowRealTopics(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)

	readCounters := func(label string) (topics, posts int, hasLastPost bool) {
		t.Helper()
		status, payload := doJSON(t, server.URL, http.MethodGet, "/api/aerun/categories",
			tokens["player"], "", "")
		if status != http.StatusOK {
			t.Fatalf("%s: list categories: got %d, want 200 (%v)", label, status, payload)
		}
		cats, _ := payload["items"].([]any)
		for _, raw := range cats {
			entry, _ := raw.(map[string]any)
			if entry["id"] != catID {
				continue
			}
			tc, _ := entry["topics_count"].(float64)
			pc, _ := entry["posts_count"].(float64)
			_, present := entry["last_post_topic_id"]
			return int(tc), int(pc), present
		}
		t.Fatalf("%s: category %s missing from the list", label, catID)
		return 0, 0, false
	}

	if tc, pc, present := readCounters("empty"); tc != 0 || pc != 0 || present {
		t.Fatalf("a category with no topics reported topics=%d posts=%d last_post=%v; want 0/0/absent",
			tc, pc, present)
	}

	status, payload := doJSON(t, server.URL, http.MethodPost, "/api/aerun/topics",
		tokens["player"], "idem-counters-1",
		fmt.Sprintf(`{"category_id":"%s","title":"Counted","content":"Body"}`, catID))
	if status != http.StatusCreated {
		t.Fatalf("create topic: got %d, want 201 (%v)", status, payload)
	}
	topicMap, _ := payload["topic"].(map[string]any)
	topicID, _ := topicMap["id"].(string)

	if tc, pc, present := readCounters("after create"); tc != 1 || pc != 1 || !present {
		t.Fatalf("after create reported topics=%d posts=%d last_post=%v; want 1/1/present", tc, pc, present)
	}

	status, payload = doJSON(t, server.URL, http.MethodDelete,
		fmt.Sprintf("/api/aerun/topics/%s", topicID), tokens["player"], "idem-counters-2", "")
	if status != http.StatusOK {
		t.Fatalf("delete topic: got %d, want 200 (%v)", status, payload)
	}

	if tc, pc, present := readCounters("after delete"); tc != 0 || pc != 0 || present {
		t.Fatalf("after delete reported topics=%d posts=%d last_post=%v; want 0/0/absent — a stale counter",
			tc, pc, present)
	}
}
