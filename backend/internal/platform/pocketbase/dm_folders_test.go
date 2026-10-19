package pocketbase

import (
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// dm_folders_test.go — the personal-projection model for direct messages
// (owner's ruling, 2026-10-19).
//
// A chat is a PERSONAL PROJECTION of a message stream: every participant
// sees their own window over the shared rows, and "I delete this for myself"
// says only that the member will not read them again. The rows stay in the
// database until NO participant can read them any more, and that removal is
// the collector's job (see dm_collector.go), not a request's.
//
// The tests below pin the three properties that make the model work:
//
//   - erasing for myself ALWAYS succeeds, even while the peer can still read
//     the conversation (there is no 409, and no "half done" outcome);
//   - the messages stay in the database while the peer can read them;
//   - a NEW message to a chat the member removed brings the chat back as a
//     NEW dialogue, without the previous history.
//
// The horizon is a SEQUENCE, not a timestamp. It used to be `dm_members.cleared_at`,
// a text field holding the `created` instant of the last message the member had
// seen, and the message list filtered on it with a STRICT comparison:
//
//	query = query.AndWhere(dbx.NewExp("created > {:cleared_at}", …))
//
// `created` is a millisecond-resolution timestamp, so two messages written
// inside the same millisecond carry the SAME value. The reply that followed the
// clear in that millisecond compared EQUAL and vanished from the thread until
// some later message moved the clock. The test that pinned this contract
// failed roughly one run in thirty, on the parent commit as much as on this
// one: a race, not a regression, and unfixable by moving the anchor.
//
// `sequence` is monotonic within the conversation and has no resolution limit,
// so "hidden up to and including N" is exact — the race disappears rather than
// becoming rarer.

// TestDMEraseIsPersonalAndNeverRefused pins the owner's core rule: erasing a
// conversation FOR MYSELF is always accepted, and it removes nothing from the
// database while the peer can still read it.
//
// The earlier model refused with 409 until the peer had erased too, which made
// the step impossible to take: nobody could be first, because being first is
// exactly what the refusal forbade.
func TestDMEraseIsPersonalAndNeverRefused(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 2)

	// The player erases it FOR THEMSELVES. This ALWAYS succeeds, even though
	// the peer has not erased anything and can still read every message.
	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, tokens["player"], "dm-erase-personal-1", "")
	if status != http.StatusOK {
		t.Fatalf("erase for myself = %d: %v", status, payload)
	}
	if erased, _ := payload["erased"].(bool); !erased {
		t.Errorf("the response must report the erase, got %v", payload)
	}

	// The MESSAGES ARE STILL THERE: the peer has not released them, so
	// nobody may remove them.
	if n := countRows(t, app, dmMessagesCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID}); n != 2 {
		t.Errorf("the messages must stay while the peer can read them, %d remain", n)
	}

	// The player no longer sees them: their own window moved past them.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms/"+convID+"/messages", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list the erased messages = %d: %v", status, payload)
	}
	if items, _ := payload["items"].([]any); len(items) != 0 {
		t.Errorf("an erased conversation must show the eraser nothing, got %v", items)
	}

	// The PEER still reads the whole history: the erase was about the
	// player's own projection, not about the shared rows.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms/"+convID+"/messages", player2Token, "", "")
	if status != http.StatusOK {
		t.Fatalf("the peer must still read the conversation = %d: %v", status, payload)
	}
	if items, _ := payload["items"].([]any); len(items) != 2 {
		t.Errorf("the peer must still see both messages, got %v", items)
	}
}

// TestDMNewMessageRevivesAnErasedChatAsNewDialogue pins the owner's rule (г):
// when the peer writes to a chat the member removed, the chat RETURNS to their
// inbox as a NEW dialogue — without the previous history.
//
// The previous history stays behind the member's horizon, and the chat's lower
// visibility edge moves to the new message, so what the member sees is a
// conversation that starts now. Without this the chat would be invisible to
// them forever while the peer keeps writing into it.
func TestDMNewMessageRevivesAnErasedChatAsNewDialogue(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 2)

	// The player erases the conversation for themselves.
	status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, tokens["player"], "dm-revive-erase-1", "")
	if status != http.StatusOK {
		t.Fatalf("erase for myself = %d: %v", status, payload)
	}

	// The chat is out of the player's inbox: they removed it.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list the inbox = %d: %v", status, payload)
	}
	if listContainsID(payload, convID) {
		t.Errorf("an erased conversation must not be in the inbox, got %v", payload)
	}

	// The PEER writes. The chat comes back to the player's inbox.
	status, payload = doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/dms/"+convID+"/messages", player2Token, "dm-revive-msg-1", `{"text":"привет"}`)
	if status != http.StatusOK {
		t.Fatalf("the peer must still be able to write = %d: %v", status, payload)
	}

	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list the inbox = %d: %v", status, payload)
	}
	if !listContainsID(payload, convID) {
		t.Errorf("a new message must bring the chat back to the inbox, got %v", payload)
	}

	// And the player sees ONLY the new message: the revived chat is a new
	// dialogue, not the old history all over again.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms/"+convID+"/messages", tokens["player"], "", "")
	if status != http.StatusOK {
		t.Fatalf("list the messages = %d: %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("the revived chat must hold only the new message, got %v", items)
	}
	if msg, _ := items[0].(map[string]any); msg["text"] != "привет" {
		t.Errorf("the revived chat must start with the new message, got %v", msg)
	}
}

// TestDMCollectorRemovesOnlyUnreadableMessages pins the Min-Watermark
// collector: the rows go when NO participant can read them any more, and not
// before.
//
// The watermark is the LOWEST erase point among the participants, so a member
// who erased early holds the line down and keeps the messages alive for
// everyone. A participant whose ACCOUNT was deleted holds nothing back — it can
// never log in and can never read anything.
func TestDMCollectorRemovesOnlyUnreadableMessages(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 2)

	// Only the player erases. The peer can still read everything, so the
	// collector must not touch a row.
	if status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, tokens["player"], "dm-gc-erase-1", ""); status != http.StatusOK {
		t.Fatalf("erase for myself = %d: %v", status, payload)
	}
	if removed, err := collectDeletedDMMessages(app); err != nil {
		t.Fatalf("the collector failed: %v", err)
	} else if removed != 0 {
		t.Errorf("the collector must not remove a message the peer can read, removed %d", removed)
	}
	if n := countRows(t, app, dmMessagesCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID}); n != 2 {
		t.Errorf("the messages must stay while the peer can read them, %d remain", n)
	}

	// Now the peer erases too. Both released the chat, so the watermark
	// reaches the end and the rows go.
	if status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, player2Token, "dm-gc-erase-2", ""); status != http.StatusOK {
		t.Fatalf("erase for myself (peer) = %d: %v", status, payload)
	}
	removed, err := collectDeletedDMMessages(app)
	if err != nil {
		t.Fatalf("the collector failed: %v", err)
	}
	if removed != 2 {
		t.Errorf("the collector must remove both messages once nobody can read them, removed %d", removed)
	}
	if n := countRows(t, app, dmMessagesCollectionName, "conversation_id = {:c}",
		map[string]any{"c": convID}); n != 0 {
		t.Errorf("the messages must be gone, %d remain", n)
	}
	// The conversation itself goes with them: nothing is left to show.
	if _, err := app.FindRecordById(dmConversationsCollectionName, convID); err == nil {
		t.Errorf("an empty conversation must be removed with its messages")
	}
}

// TestDMDeletedAccountDoesNotHoldTheWatermarkBack pins the owner's rule for a
// deleted account (В3, В7): an account that can never log in can never read
// anything, so it must not hold the collector's watermark back.
//
// The survivor erases their own side of the chat, and that alone is enough for
// the messages to be collected — the deleted account holds nothing back.
func TestDMDeletedAccountDoesNotHoldTheWatermarkBack(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 2)

	// The peer's account is deleted. From now on they can never read
	// anything, and the survivor can read it all.
	softDeleteUserDirectly(t, app, player2ID)

	// The survivor erases their own side.
	if status, payload := doJSON(t, ts.URL, http.MethodDelete,
		"/api/aerun/dms/"+convID, tokens["player"], "dm-gc-deleted-1", ""); status != http.StatusOK {
		t.Fatalf("erase for myself = %d: %v", status, payload)
	}

	// The deleted account holds nothing back, so the survivor's own erase
	// point IS the watermark, and the rows go.
	removed, err := collectDeletedDMMessages(app)
	if err != nil {
		t.Fatalf("the collector failed: %v", err)
	}
	if removed != 2 {
		t.Errorf("a deleted account must not hold the watermark back, removed %d of 2", removed)
	}
}

// TestDMClearHorizonIsExactOnSequence pins the ordinal horizon.
func TestDMClearHorizonIsExactOnSequence(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	convID := seedDMConversationWithMessages(t, app, fixPlayerID, []string{player2ID}, 1)

	// The peer clears: everything so far is hidden from them.
	status, payload := doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/dms/"+convID+"/clear", player2Token, "dm-horizon-clear", "")
	if status != http.StatusOK {
		t.Fatalf("clear = %d: %v", status, payload)
	}

	// A reply arrives.
	status, payload = doJSON(t, ts.URL, http.MethodPost,
		"/api/aerun/dms/"+convID+"/messages", tokens["player"], "dm-horizon-reply-1", `{"text":"after the clear"}`)
	if status != http.StatusOK {
		t.Fatalf("reply = %d: %v", status, payload)
	}

	// The peer sees EXACTLY the reply — never zero rows, and never the
	// message they had already seen.
	status, payload = doJSON(t, ts.URL, http.MethodGet,
		"/api/aerun/dms/"+convID+"/messages", player2Token, "", "")
	if status != http.StatusOK {
		t.Fatalf("list messages = %d: %v", status, payload)
	}
	items, _ := payload["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("the peer must see exactly the post-clear reply, got %v", payload)
	}
	if msg, _ := items[0].(map[string]any); msg["text"] != "after the clear" {
		t.Errorf("the visible message must be the reply, got %v", msg)
	}
}

// seedDMConversationWithMessages creates a conversation with `count` messages
// written by the FIRST member, and one membership row per member.
//
// The messages are written through the rows (not the API) so the fixture does
// not depend on the send path, and their sequences are consecutive — the
// ordinal the horizon is expressed in.
func seedDMConversationWithMessages(t testing.TB, app *tests.TestApp, authorID string, otherIDs []string, count int) string {
	t.Helper()

	convCol, err := app.FindCollectionByNameOrId(dmConversationsCollectionName)
	if err != nil {
		t.Fatalf("dm_conversations collection missing: %v", err)
	}
	conv := core.NewRecord(convCol)
	conv.Set("title", "Folder fixture")
	conv.Set("messages_count", count)
	if err := app.Save(conv); err != nil {
		t.Fatalf("failed to seed conversation: %v", err)
	}

	memCol, err := app.FindCollectionByNameOrId(dmMembersCollectionName)
	if err != nil {
		t.Fatalf("dm_members collection missing: %v", err)
	}
	msgCol, err := app.FindCollectionByNameOrId(dmMessagesCollectionName)
	if err != nil {
		t.Fatalf("dm_messages collection missing: %v", err)
	}

	members := append([]string{authorID}, otherIDs...)
	for _, uid := range members {
		m := core.NewRecord(memCol)
		m.Set("conversation_id", conv.Id)
		m.Set("user_id", uid)
		m.Set("last_read_sequence", 0)
		m.Set("cleared_sequence", 0)
		m.Set("deleted", false)
		m.Set("erased_sequence", 0)
		// The window opens at the first message: a fresh conversation shows
		// its whole history.
		m.Set("visible_from_sequence", 1)
		if err := app.Save(m); err != nil {
			t.Fatalf("failed to seed member %s: %v", uid, err)
		}
	}

	for i := 1; i <= count; i++ {
		msg := core.NewRecord(msgCol)
		msg.Set("conversation_id", conv.Id)
		msg.Set("sender_id", authorID)
		msg.Set("sequence", i)
		msg.Set("text", "seeded message")
		if err := app.Save(msg); err != nil {
			t.Fatalf("failed to seed message %d: %v", i, err)
		}
	}
	return conv.Id
}
