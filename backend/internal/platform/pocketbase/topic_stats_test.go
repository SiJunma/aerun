package pocketbase

// TestTopicStats* pins the B1 route (INPROGRESS_TOPIC_OPEN_READS_AND_DRAFT_SAFETY_PLAN):
// the topic page's 15s freshness read answers only what the loop compares
// (posts_count, last_post_id, last_post_at) plus locked, honours the same
// category-visibility check as the full read, and is guest-safe.
//
// The getTopicHandler-visibility half is pinned here too: the stats route
// would be the wrong way round if the full read next to it answered any
// topic by id. A topic in a category the caller may not see answers 404
// from BOTH routes — byte-identical to a missing topic — so a hidden thread
// never leaks its existence.
//
// NOTE on the seed: seedDraftTopic (drafts_test.go) sets last_post_id but
// NOT last_post_created (a DateField, nullable in the fixture). The stats
// contract therefore asserts the KEY exists, never a non-empty value — the
// client normalises an empty timestamp to null and falls back to `created`.

import (
	"net/http"
	"testing"
)

func TestTopicStatsReturnsOnlyItsContract(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A topic with stats")

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/stats", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("stats: got %d, want 200 (%v)", status, payload)
	}

	want := map[string]bool{
		"topic_id":          true,
		"title":             true,
		"category_id":       true,
		"author_id":         true,
		"author_name":       true,
		"pinned":            true,
		"first_post_pinned": true,
		"created":           true,
		"posts_count":       true,
		"last_post_id":      true,
		"last_post_at":      true,
		"locked":            true,
		"request_id":        true,
	}
	for key := range payload {
		if !want[key] {
			t.Errorf("stats carried %q — unexpected field in stats contract (%v)", key, payload)
		}
	}
	for key := range want {
		if _, ok := payload[key]; !ok {
			t.Errorf("stats missing %q (%v)", key, payload)
		}
	}
	if payload["topic_id"] != topicID {
		t.Errorf("stats topic_id = %v, want %s", payload["topic_id"], topicID)
	}
	if payload["title"] != "A topic with stats" {
		t.Errorf("stats title = %v, want 'A topic with stats'", payload["title"])
	}
	for _, forbidden := range []string{
		"author_avatar",
		"author_status_line",
		"author_signature",
		"author_role_id",
		"author_reputation",
		"author_posts_count",
		"last_post_author",
		"last_post_author_avatar",
		"last_post_author_id",
		"last_post_created",
	} {
		if _, ok := payload[forbidden]; ok {
			t.Errorf("stats carried %q — stats must not carry heavy list decoration", forbidden)
		}
	}
}

func TestTopicStatsIsGuestSafe(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A public topic")

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/stats", "", "", "")
	if status != http.StatusOK {
		t.Fatalf("guest stats: got %d, want 200 (%v)", status, payload)
	}
	if payload["topic_id"] != topicID {
		t.Errorf("guest stats topic_id = %v, want %s", payload["topic_id"], topicID)
	}
}

func TestTopicStatsAndTopicHideARestrictedCategory(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	// An explicit role list with no inherit marker: player cannot read this
	// board, moderator can.
	category := newTestCategory(t, app, "closed-boards", []string{"moderator"})
	topic := newSignalTopic(t, app, "Private topic", category.Id)

	server := newTestServer(t, app)
	defer server.Close()

	for _, path := range []string{
		"/api/aerun/topics/" + topic.Id,
		"/api/aerun/topics/" + topic.Id + "/stats",
	} {
		status, _ := doJSON(t, server.URL, http.MethodGet, path, tokens["player"], "", "")
		if status != http.StatusNotFound {
			t.Errorf("GET %s as player: got %d, want 404 — a hidden thread must read as missing", path, status)
		}
		status, _ = doJSON(t, server.URL, http.MethodGet, path, "", "", "")
		if status != http.StatusNotFound {
			t.Errorf("GET %s as guest: got %d, want 404 — a hidden thread must read as missing", path, status)
		}
		status, payload := doJSON(t, server.URL, http.MethodGet, path, tokens["moderator"], "", "")
		if status != http.StatusOK {
			t.Errorf("GET %s as moderator: got %d, want 200 (%v)", path, status, payload)
		}
	}

	// A banned member is refused by canViewCategory before the role is even
	// consulted, so both routes answer 404 for them too — the same silence
	// the isolation test pins for the category list.
	for _, path := range []string{
		"/api/aerun/topics/" + topic.Id,
		"/api/aerun/topics/" + topic.Id + "/stats",
	} {
		status, _ := doJSON(t, server.URL, http.MethodGet, path, tokens["banned"], "", "")
		if status != http.StatusNotFound {
			t.Errorf("GET %s as banned: got %d, want 404", path, status)
		}
	}
}

func TestTopicStatsReportsLocked(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A topic to lock")

	rec, err := app.FindRecordById(topicsCollectionName, topicID)
	if err != nil || rec == nil {
		t.Fatalf("seeded topic missing: %v", err)
	}
	rec.Set("locked", true)
	if err := app.Save(rec); err != nil {
		t.Fatalf("lock the topic: %v", err)
	}

	server := newTestServer(t, app)
	defer server.Close()

	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/stats", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("stats: got %d, want 200 (%v)", status, payload)
	}
	if locked, _ := payload["locked"].(bool); !locked {
		t.Errorf("stats locked = %v, want true — the reply gate reads this field (%v)", payload["locked"], payload)
	}
}

func TestTopicStatsMissingTopicIs404(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)

	server := newTestServer(t, app)
	defer server.Close()

	status, _ := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/nonexistent0001/stats", tokens["player"], "", "")
	if status != http.StatusNotFound {
		t.Fatalf("stats for a missing topic: got %d, want 404", status)
	}
}
