package pocketbase

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedRankedTopic makes a live topic whose last_post_created is pinned to an
// explicit moment, so the list endpoint's ORDER BY can be observed without
// depending on wall-clock drift between two seeds.
func seedRankedTopic(t testing.TB, app *tests.TestApp, authorID, title string, pinned bool, lastPost time.Time) string {
	t.Helper()
	catID := getGeneralCategoryID(t, app)
	topicCol, err := app.FindCollectionByNameOrId(topicsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(topicCol)
	rec.Set("category_id", catID)
	rec.Set("author_id", authorID)
	rec.Set("title", title)
	rec.Set("posts_count", 1)
	rec.Set("pinned", pinned)
	rec.Set("last_post_created", lastPost)
	if err := app.Save(rec); err != nil {
		t.Fatalf("seed ranked topic: %v", err)
	}
	return rec.Id
}

// TestTopicPinRankingIsCategoryViewOnly is the guard for the rule that pinned
// topics outrank by recency ONLY inside a category page.
//
// listTopicsHandler serves both the category page (category_id present) and the
// global /active-topics + /new-replies feeds (category_id absent). It used to
// order every caller by `pinned DESC, last_post_created DESC, id DESC`, so a
// member scanning "latest activity" saw an old pinned announcement stranded
// above every recent reply. The rule is now: pin-aware ordering inside a
// category, pure recency everywhere else.
func TestTopicPinRankingIsCategoryViewOnly(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	server := newTestServer(t, app)
	defer server.Close()

	now := time.Now().UTC()
	// An OLD pinned topic vs a FRESH unpinned one. Under recency the fresh topic
	// must come first; under pin-priority the old pinned one would.
	freshID := seedRankedTopic(t, app, fixPlayerID, "Fresh unpinned", false, now)
	oldPinnedID := seedRankedTopic(t, app, fixPlayerID, "Old pinned", true, now.Add(-48*time.Hour))

	firstItemID := func(payload map[string]any) string {
		items, _ := payload["items"].([]any)
		if len(items) == 0 {
			return ""
		}
		first, _ := items[0].(map[string]any)
		id, _ := first["id"].(string)
		return id
	}

	catID := getGeneralCategoryID(t, app)

	// Category PAGE (pinned_first=1): the pinned topic is ranked first even though
	// it is stale — that is the category page's contract, paged offset-style.
	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics?category_id=%s&pinned_first=1&page=1&limit=20", catID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("category page: got %d, want 200 (%v)", status, payload)
	}
	if got := firstItemID(payload); got != oldPinnedID {
		t.Fatalf("category page must rank the pinned topic first (pin-aware), got %s, want %s", got, oldPinnedID)
	}

	// subscribeToTopics: a category read WITHOUT pinned_first (the index and
	// last-post cards) must ignore the pin and stay in pure recency, exactly like
	// /active-topics — "newest first", not a pinned block.
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics?category_id=%s&limit=100", catID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("category feed (no pinned_first): got %d, want 200 (%v)", status, payload)
	}
	if got := firstItemID(payload); got != freshID {
		t.Fatalf("a category read without pinned_first must ignore the pin and rank by recency, got %s, want %s (fresh unpinned)", got, freshID)
	}

	// Global feed (no category_id): pure recency — the pinned topic must NOT
	// outrank the fresh one.
	status, payload = doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics?page=1&limit=20",
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("global feed: got %d, want 200 (%v)", status, payload)
	}
	if got := firstItemID(payload); got != freshID {
		t.Fatalf("global feed must ignore pin and rank by recency, got %s, want %s (fresh unpinned)", got, freshID)
	}
}
