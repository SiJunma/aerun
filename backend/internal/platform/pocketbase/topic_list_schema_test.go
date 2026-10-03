package pocketbase

// TestListTopicsRunsAgainstLiveSchema guards the one route whose failure mode is
// invisible until a human opens a category.
//
// Migration 1767700000 dropped `topics.deleted` when deletion became hard, but
// listTopicsHandler kept filtering on it. SQLite rejects the whole statement
// ("no such column: deleted"), the handler maps that to 500, and EVERY category
// page failed — with or without topics, since the query died before reading any
// row. The topic suite never noticed because it only ever POSTed.
//
// Two assertions, because the empty case alone would pass against a handler
// that returned 200 for the wrong reason:
//   - the route answers 200 against the real post-migration schema, and
//   - a category that really does hold a topic returns that topic.
// Either regression turns this red.

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestListTopicsRunsAgainstLiveSchema(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	server := newTestServer(t, app)
	defer server.Close()

	tokens := seedIdentityFixtures(t, app)
	catID := getGeneralCategoryID(t, app)
	seedDraftTopic(t, app, fixPlayerID, "A topic that must be listed")

	// 1. Empty category: the route must run the query at all. This is the exact
	//    shape that produced the 500 — a category with no topics.
	catCol, err := app.FindCollectionByNameOrId(categoriesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	emptyCat := core.NewRecord(catCol)
	emptyCat.Set("name", "Empty")
	emptyCat.Set("slug", "empty-for-list-test")
	emptyCat.Set("group_id", "")
	if err := app.Save(emptyCat); err != nil {
		t.Fatalf("seed empty category: %v", err)
	}
	emptyCatID := emptyCat.Id

	status, payload := doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics?category_id=%s&page=1&limit=20", emptyCatID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("empty category: got %d, want 200 — a 500 here is the dropped-column regression (%v)", status, payload)
	}

	// 2. A category WITH a topic must return that topic, so a 200 that silently
	//    returned nothing cannot satisfy this test.
	status, payload = doJSON(t, server.URL, http.MethodGet,
		fmt.Sprintf("/api/aerun/topics?category_id=%s&page=1&limit=20", catID),
		tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("populated category: got %d, want 200 (%v)", status, payload)
	}
	items, ok := payload["items"].([]any)
	if !ok {
		t.Fatalf("response has no items array: %#v", payload)
	}
	if len(items) == 0 {
		t.Fatal("a category holding a topic listed none — the query ran but returned nothing")
	}
}
