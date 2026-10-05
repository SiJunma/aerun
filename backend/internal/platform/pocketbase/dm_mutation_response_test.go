package pocketbase

// The write path must return the row it just wrote.
//
// REPORTED: "I edited the message — nothing appeared. I deleted it — the toast
// arrived and the bubble did not change at all."
//
// Both handlers were correct on the server and the row really was saved; the
// client simply had nothing to apply. The proof is in the design itself:
//
//   - a message mutation publishes `dm.post` to the OTHER participant only
//     (publishDMSignalToPeers, dms.go), so the author is deliberately never
//     signalled about their own change;
//   - shared-poll REMOVES its fallback interval the first time any realtime
//     signal is delivered, on the reasoning that the stream is now carrying.
//
// Together those mean the author's own thread has no delivery path at all. The
// response body is the only remaining carrier, so an answer of `{deleted:true,
// id}` — no row — left the sender holding the exact text they had withdrawn,
// under a success toast that said it had been deleted.
//
// The edit handler already returned `message`; the delete handler did not, and
// the difference is the whole bug.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// dmMutate sends one PATCH/DELETE to a message and decodes the response.
func dmMutate(t *testing.T, tsURL, token, msgID, method, body, key string) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, tsURL+"/api/aerun/dm-messages/"+msgID, reader)
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", key)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	return res.StatusCode, payload
}

// TestDmEditReturnsTheCorrectedRow pins that PATCH hands back the message.
func TestDmEditReturnsTheCorrectedRow(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	_, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-mut-edit")

	status, payload := dmMutate(t, ts.URL, tokens["player"], msgID,
		http.MethodPatch, `{"text":"the corrected words"}`, "dm-mut-edit-1")
	if status != http.StatusOK {
		t.Fatalf("edit = %d: %v", status, payload)
	}

	msg, _ := payload["message"].(map[string]any)
	if msg == nil {
		t.Fatalf("the edit response must carry the corrected row, got %v", payload)
	}
	if got, _ := msg["id"].(string); got != msgID {
		t.Errorf("returned id = %q, want %q — the client matches its state by id", got, msgID)
	}
	if got, _ := msg["text"].(string); got != "the corrected words" {
		t.Errorf("returned text = %q, want the corrected words", got)
	}
	if edited, _ := msg["edited"].(string); edited == "" {
		t.Error("an edited message must report when it was edited, so the thread can say so")
	}
	if deleted, _ := msg["deleted"].(bool); deleted {
		t.Error("an edit must not leave the message flagged deleted")
	}
}

// TestDmDeleteReturnsTheTombstone is the reported bug, as a test.
//
// The delete persisted, the list served the tombstone to the RECIPIENT, and the
// sender's own screen never changed — because the response said only that it
// had happened, and nothing re-read it.
func TestDmDeleteReturnsTheTombstone(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	_, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-mut-del")

	status, payload := dmMutate(t, ts.URL, tokens["player"], msgID,
		http.MethodDelete, "", "dm-mut-del-1")
	if status != http.StatusOK {
		t.Fatalf("delete = %d: %v", status, payload)
	}

	msg, _ := payload["message"].(map[string]any)
	if msg == nil {
		t.Fatalf("the delete response must carry the tombstone, got %v", payload)
	}
	if got, _ := msg["id"].(string); got != msgID {
		t.Errorf("returned id = %q, want %q", got, msgID)
	}
	if deleted, _ := msg["deleted"].(bool); !deleted {
		t.Error("the returned row must be flagged deleted, or the bubble stays a normal message")
	}
	// The load-bearing half. A tombstone with a `text` key is merged by
	// spreading it over the old row, and the withdrawn words come straight back.
	if text, hasText := msg["text"]; hasText {
		t.Errorf("a tombstone must not carry text, got %v", text)
	}
}

// TestDmRepeatDeleteStillReturnsTheRow covers the idempotent branch.
//
// It short-circuits before the write, so it is a separate return statement and
// a separate chance to drop the row again — and a client that retries a delete
// (double click, flaky network) must be handed the same tombstone, not a bare
// acknowledgement.
func TestDmRepeatDeleteStillReturnsTheRow(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	_, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-mut-del2")

	if status, payload := dmMutate(t, ts.URL, tokens["player"], msgID,
		http.MethodDelete, "", "dm-mut-del2-a"); status != http.StatusOK {
		t.Fatalf("first delete = %d: %v", status, payload)
	}

	status, payload := dmMutate(t, ts.URL, tokens["player"], msgID,
		http.MethodDelete, "", "dm-mut-del2-b")
	if status != http.StatusOK {
		t.Fatalf("second delete = %d: %v (a repeat must stay a 200)", status, payload)
	}
	msg, _ := payload["message"].(map[string]any)
	if msg == nil {
		t.Fatalf("a repeated delete must still return the tombstone, got %v", payload)
	}
	if deleted, _ := msg["deleted"].(bool); !deleted {
		t.Error("a repeated delete must return a row flagged deleted")
	}
	if text, hasText := msg["text"]; hasText {
		t.Errorf("a repeated delete must not resurrect the text, got %v", text)
	}
}
