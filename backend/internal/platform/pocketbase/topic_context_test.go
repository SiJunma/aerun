package pocketbase

// TestTopicContext* pins the B2 route (INPROGRESS_TOPIC_OPEN_READS_AND_DRAFT_SAFETY_PLAN):
// the topic page's ONE caller-scoped read answers exactly {topic_id, draft,
// subscribed, votes, request_id}, honours the same category-visibility check
// as the full read and /stats, is guest-safe (200 with the empty shape), and
// refuses a banned caller with 403 — the same global interception the /me/votes
// pin carries, so a ban can never be served an empty context that reads as
// "you simply have no draft".

import (
	"github.com/pocketbase/pocketbase/core"
	"net/http"
	"testing"
)

func TestTopicContextCarriesTheCallerState(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A topic with state")
	openingPostID := openingPostIDFor(t, app, fixPlayerID, topicID)

	server := newTestServer(t, app)
	defer server.Close()

	// A draft, a subscription and one vote, all for the player in this topic.
	if status, payload := doJSON(t, server.URL, http.MethodPut,
		"/api/aerun/topics/"+topicID+"/draft", tokens["player"], "ctx-draft",
		`{"content":"an unsent reply"}`); status != http.StatusOK {
		t.Fatalf("seed draft: got %d (%v)", status, payload)
	}
	subscribeToTopicForTest(t, app, topicID, fixPlayerID)
	seedTopicVote(t, app, fixPlayerID, fixPlayerID, openingPostID, topicID, 1)

	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/context", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("context: got %d, want 200 (%v)", status, payload)
	}

	want := map[string]bool{
		"topic_id":   true,
		"draft":      true,
		"subscribed": true,
		"votes":      true,
		"request_id": true,
	}
	for key := range payload {
		if !want[key] {
			t.Errorf("context carried %q — every extra field is caller-scoped state the page does not read (%v)", key, payload)
		}
	}
	for key := range want {
		if _, ok := payload[key]; !ok {
			t.Errorf("context missing %q (%v)", key, payload)
		}
	}
	if payload["topic_id"] != topicID {
		t.Errorf("context topic_id = %v, want %s", payload["topic_id"], topicID)
	}

	draft, ok := payload["draft"].(map[string]any)
	if !ok || draft == nil {
		t.Fatalf("context draft = %v, want the saved draft object", payload["draft"])
	}
	if got, _ := draft["content"].(string); got != "an unsent reply" {
		t.Errorf("context draft content = %v, want the saved text", draft["content"])
	}

	if subscribed, _ := payload["subscribed"].(bool); !subscribed {
		t.Errorf("context subscribed = %v, want true — the Follow button reads this", payload["subscribed"])
	}

	votes, ok := payload["votes"].([]any)
	if !ok || len(votes) != 1 {
		t.Fatalf("context votes = %v, want exactly the one seeded vote", payload["votes"])
	}
	vote, _ := votes[0].(map[string]any)
	if vote["post_id"] != openingPostID {
		t.Errorf("context vote post_id = %v, want %s", vote["post_id"], openingPostID)
	}
	if value, _ := vote["value"].(float64); value != 1 {
		t.Errorf("context vote value = %v, want 1", vote["value"])
	}
	if comment, _ := vote["comment"].(string); comment != "great post" {
		t.Errorf("context vote comment = %v, want great post", vote["comment"])
	}
	if voterID, _ := vote["voter_id"].(string); voterID != fixPlayerID {
		t.Errorf("context vote voter_id = %v, want %s", vote["voter_id"], fixPlayerID)
	}
}

func TestTopicContextIsGuestSafe(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A public topic")

	server := newTestServer(t, app)
	defer server.Close()

	// The guest contract is a REQUIREMENT: a 403 here would break the whole
	// topic page for a signed-out visitor. 200 with the empty shape.
	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/context", "", "", "")
	if status != http.StatusOK {
		t.Fatalf("guest context: got %d, want 200 — a 403 breaks the whole page (%v)", status, payload)
	}
	if payload["topic_id"] != topicID {
		t.Errorf("guest context topic_id = %v, want %s", payload["topic_id"], topicID)
	}
	if draft, ok := payload["draft"]; ok && draft != nil {
		t.Errorf("guest context draft = %v, want null", draft)
	}
	if subscribed, _ := payload["subscribed"].(bool); subscribed {
		t.Errorf("guest context subscribed = %v, want false", payload["subscribed"])
	}
	if votes, ok := payload["votes"].([]any); !ok || len(votes) != 0 {
		t.Errorf("guest context votes = %v, want an empty list", payload["votes"])
	}
}

func TestTopicContextRefusesBannedWith403(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	topicID := seedDraftTopic(t, app, fixPlayerID, "A topic a banned member opens")

	server := newTestServer(t, app)
	defer server.Close()

	// Banned is intercepted globally (Part 8): 403 before any read, the same
	// refusal listMyVotesHandler gives — never an empty-context 200 that would
	// read as "you have no draft, come on in".
	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topicID+"/context", tokens["banned"], "", "")
	if status != http.StatusForbidden {
		t.Fatalf("banned context: got %d, want 403 (%v)", status, payload)
	}
}

func TestTopicContextHidesARestrictedCategory(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	// An explicit role list with no inherit marker: player cannot read this
	// board, moderator can.
	category := newTestCategory(t, app, "closed-boards-context", []string{"moderator"})
	topic := newSignalTopic(t, app, "Private topic", category.Id)

	server := newTestServer(t, app)
	defer server.Close()

	// A hidden thread must read as missing — 404, byte-identical to a topic
	// that does not exist — so its existence never leaks through /context.
	for _, actor := range []string{"player", ""} {
		status, _ := doJSON(t, server.URL, http.MethodGet,
			"/api/aerun/topics/"+topic.Id+"/context", tokens[actor], "", "")
		if status != http.StatusNotFound {
			t.Errorf("context as %q: got %d, want 404 — a hidden thread must read as missing", actor, status)
		}
	}
	status, payload := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topic.Id+"/context", tokens["moderator"], "", "")
	if status != http.StatusOK {
		t.Errorf("context as moderator: got %d, want 200 (%v)", status, payload)
	}

	// Banned is refused BEFORE the visibility check, so it is 403 here too —
	// the global interception, not a 404 "missing topic".
	status, _ = doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/"+topic.Id+"/context", tokens["banned"], "", "")
	if status != http.StatusForbidden {
		t.Errorf("context as banned: got %d, want 403", status)
	}
}

func TestTopicContextMissingTopicIs404(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)

	server := newTestServer(t, app)
	defer server.Close()

	status, _ := doJSON(t, server.URL, http.MethodGet,
		"/api/aerun/topics/nonexistent0001/context", tokens["player"], "", "")
	if status != http.StatusNotFound {
		t.Fatalf("context for a missing topic: got %d, want 404", status)
	}
}

func seedTopicVote(t testing.TB, app core.App, voter, target, postID, topicID string, value int) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(reputationVotesCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	vote := core.NewRecord(col)
	vote.Set("voter_id", voter)
	vote.Set("target_id", target)
	vote.Set("post_id", postID)
	vote.Set("topic_id", topicID)
	vote.Set("value", value)
	vote.Set("comment", "great post")
	if err := app.Save(vote); err != nil {
		t.Fatal(err)
	}
}
