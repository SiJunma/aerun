package pocketbase

// dms_tombstone_test.go pins the rule the owner drew: a DELETED direct message
// is a tombstone, not a hole.
//
// The forum deletes a post completely. A DM must not, because it is a
// conversation between two people and both have to keep seeing that something
// was said and where it sat. So this file asserts the three things a hard
// delete would break:
//
//   - the recipient still SEES the message, as a tombstone;
//   - the text is gone, including from the conversation preview;
//   - the messages count and the sequence do not move, because the row is
//     still a message.
//
// It also pins who may edit or delete: the sender only. Not the recipient —
// a conversation must not be forgeable by its audience — and not a moderator,
// because `edit_others_posts` is a FORUM permission and does not reach into
// private mail.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// dmTestConv opens a conversation between the fixture player and a second
// player, with one message from the first.
func dmTestConv(t *testing.T, tsURL, token, secondID, key string) (convID, msgID string) {
	t.Helper()
	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Plans","text":"the original words"}`, secondID)
	req, _ := http.NewRequest(http.MethodPost, tsURL+"/api/aerun/dms", strings.NewReader(body))
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("open conversation = %d: %s", res.StatusCode, b)
	}
	var payload struct {
		ConversationID string         `json:"conversation_id"`
		Message        map[string]any `json:"message"`
	}
	_ = json.NewDecoder(res.Body).Decode(&payload)
	id, _ := payload.Message["id"].(string)
	return payload.ConversationID, id
}

// dmListMessages reads the conversation as `token`.
func dmListMessages(t *testing.T, tsURL, token, convID string) []map[string]any {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/aerun/dms/%s/messages", tsURL, convID), nil)
	req.Header.Set("Authorization", token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("list messages = %d: %s", res.StatusCode, b)
	}
	var payload struct {
		Items []map[string]any `json:"items"`
	}
	_ = json.NewDecoder(res.Body).Decode(&payload)
	return payload.Items
}

func TestDMMessageDeleteLeavesATombstone(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, secondToken := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	convID, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-tomb-1")

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/aerun/dm-messages/"+msgID, nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "dm-tomb-del-1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	// The body is read BEFORE Close: a 500 here is the interesting signal and
	// "delete = 500" alone says nothing about why.
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d: %s", res.StatusCode, body)
	}

	// THE RECIPIENT must still see it — that is the whole point.
	items := dmListMessages(t, ts.URL, secondToken, convID)
	if len(items) != 1 {
		t.Fatalf("recipient sees %d messages, want 1 (a hard delete would leave a hole)", len(items))
	}
	msg := items[0]
	if deleted, _ := msg["deleted"].(bool); !deleted {
		t.Errorf("the message must be flagged deleted, got %v", msg["deleted"])
	}
	if _, hasText := msg["text"]; hasText {
		t.Errorf("a deleted message must not echo a text field, got %q", msg["text"])
	}
	if seq, _ := msg["sequence"].(float64); seq != 1 {
		t.Errorf("tombstone sequence = %v, want 1 (the thread must not renumber)", msg["sequence"])
	}
	if _, err := app.FindRecordById(dmMessagesCollectionName, msgID); err != nil {
		t.Errorf("the tombstone row was removed: %v", err)
	}
}

// TestDMConversationPreviewDropsDeletedText: the conversation list shows the
// newest message's text. If it kept the old copy, a soft delete would leak the
// exact content it was supposed to remove.
func TestDMConversationPreviewDropsDeletedText(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	convID, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-prev-1")

	conv, err := app.FindRecordById(dmConversationsCollectionName, convID)
	if err != nil || conv == nil {
		t.Fatal("conversation missing")
	}
	if conv.GetString("last_message") != "the original words" {
		t.Fatalf("fixture preview = %q", conv.GetString("last_message"))
	}

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/aerun/dm-messages/"+msgID, nil)
	req.Header.Set("Authorization", tokens["player"])
	req.Header.Set("Idempotency-Key", "dm-prev-del-1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	conv, _ = app.FindRecordById(dmConversationsCollectionName, convID)
	if got := conv.GetString("last_message"); got != "" {
		t.Errorf("preview after deleting the newest message = %q, want empty — a stale preview leaks the text", got)
	}
	if got := conv.GetInt("messages_count"); got != 1 {
		t.Errorf("messages_count = %d, want 1 (a tombstone is still a message)", got)
	}
}

// TestDeletedDMMessageCannotBeEdited: a tombstone has no text left to correct,
// and accepting an edit would quietly resurrect a message the sender took back.
func TestDeletedDMMessageCannotBeEdited(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	_, msgID := dmTestConv(t, ts.URL, tokens["player"], secondID, "dm-resur-1")

	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/aerun/dm-messages/"+msgID, nil)
	delReq.Header.Set("Authorization", tokens["player"])
	delReq.Header.Set("Idempotency-Key", "dm-resur-del-1")
	delRes, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	delRes.Body.Close()

	editReq, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/dm-messages/"+msgID,
		strings.NewReader(`{"text":"back from the dead"}`))
	editReq.Header.Set("Authorization", tokens["player"])
	editReq.Header.Set("Idempotency-Key", "dm-resur-edit-1")
	editReq.Header.Set("Content-Type", "application/json")
	editRes, err := http.DefaultClient.Do(editReq)
	if err != nil {
		t.Fatal(err)
	}
	editRes.Body.Close()
	if editRes.StatusCode != http.StatusConflict {
		t.Fatalf("editing a tombstone = %d, want 409", editRes.StatusCode)
	}

	record, _ := app.FindRecordById(dmMessagesCollectionName, msgID)
	if record.GetDateTime("deleted_at").IsZero() {
		t.Error("the message must remain deleted")
	}
}
