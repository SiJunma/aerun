package pocketbase

// dm_deleted_peer_test.go — regression for the deleted-peer inbox (M2 / D1+D3).
//
// Deleting an account is a plain delete with no cascade (adminDeleteUserHandler),
// and dm_members stores user_id as a plain TEXT id, not a RelationField — so the
// membership row outlives the users row it points at. Two very different shapes
// land in the inbox and must be told apart by the `peer_missing` flag:
//
//   - runtime-deleted real member: the dm_members row is ORPHANED (no users row
//     behind it). loadConversationParticipants now LEFT JOINs users, so the row
//     survives with an empty nickname — the thread still lists and its history
//     stays readable, and the frontend renders the "Deleted user" placeholder.
//     Sending into it is refused (D3). peers is non-empty → peer_missing=false.
//
//   - migration ghost: the second participant never imported, so there is NO
//     membership row at all — only the caller's. peers is empty → peer_missing
//     is true, the cue the frontend uses to refuse to open the thread (only the
//     trash affordance remains).
//
// The control (both alive) pins the healthy contract the two cases deviate from.

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// seedDMConversation creates a dm_conversations header plus one dm_members row
// per supplied uid and returns the conversation id. It mirrors the direct
// seeding in account_isolation_test.go: opening a thread through the API is
// refused for a removed counterpart, so the orphan/ghost states can only be
// reached by writing the membership rows first and deleting the users row after.
func seedDMConversation(t *testing.T, app *tests.TestApp, members ...string) string {
	t.Helper()
	convCol, err := app.FindCollectionByNameOrId(dmConversationsCollectionName)
	if err != nil {
		t.Fatalf("dm_conversations collection missing: %v", err)
	}
	conv := core.NewRecord(convCol)
	conv.Set("title", "Seeded thread")
	conv.Set("messages_count", 0)
	if err := app.Save(conv); err != nil {
		t.Fatalf("failed to seed conversation: %v", err)
	}
	memCol, err := app.FindCollectionByNameOrId(dmMembersCollectionName)
	if err != nil {
		t.Fatalf("dm_members collection missing: %v", err)
	}
	for _, uid := range members {
		m := core.NewRecord(memCol)
		m.Set("conversation_id", conv.Id)
		m.Set("user_id", uid)
		if err := app.Save(m); err != nil {
			t.Fatalf("failed to seed member %s: %v", uid, err)
		}
	}
	return conv.Id
}

// inboxListItem is one row of GET /api/aerun/dms, only the fields the deleted-
// peer contract is decided on.
type inboxListItem struct {
	ID                 string            `json:"id"`
	Participants       []string          `json:"participants"`
	ParticipantNames   map[string]string `json:"participantNames"`
	ParticipantAvatars map[string]string `json:"participantAvatars"`
	PeerMissing        bool              `json:"peer_missing"`
}

func listInbox(t *testing.T, serverURL, token string) []inboxListItem {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, serverURL+"/api/aerun/dms", nil)
	req.Header.Set("Authorization", token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("list dms: expected 200, got %d: %s", res.StatusCode, b)
	}
	var payload struct {
		Items []inboxListItem `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	return payload.Items
}

func findInboxItem(t *testing.T, items []inboxListItem, convID string) inboxListItem {
	t.Helper()
	for _, it := range items {
		if it.ID == convID {
			return it
		}
	}
	t.Fatalf("conversation %s must stay listed, got %d items", convID, len(items))
	return inboxListItem{}
}

func TestInboxDeletedPeerPlaceholder(t *testing.T) {
	// Case B — a REAL member was deleted at runtime: the dm_members row is
	// orphaned. The LEFT JOIN keeps it, so the thread still lists with one peer
	// whose nickname is empty (the placeholder cue) and whose history is still
	// readable, while a send is refused (D3).
	t.Run("runtime-deleted peer stays listed with an empty nickname and refuses sends", func(t *testing.T) {
		app := newAerunTestApp(t)
		defer app.Cleanup()

		tokens := seedIdentityFixtures(t, app)
		player1Token := tokens["player"]
		player2ID, _ := seedSecondPlayer(t, app)

		convID := seedDMConversation(t, app, fixPlayerID, player2ID)

		// Simulate the admin delete: drop the peer's users row, leaving the
		// membership row behind (no cascade runs — the id is plain TEXT).
		peerRec, err := app.FindRecordById(usersCollectionName, player2ID)
		if err != nil {
			t.Fatalf("peer users row missing before delete: %v", err)
		}
		if err := app.Delete(peerRec); err != nil {
			t.Fatalf("failed to delete peer users row: %v", err)
		}

		ts := newTestServer(t, app)
		defer ts.Close()

		item := findInboxItem(t, listInbox(t, ts.URL, player1Token), convID)
		// The orphaned row survived the LEFT JOIN, so peers is NON-empty — this
		// is NOT the migration-ghost case, and the thread is not "peer_missing".
		if item.PeerMissing {
			t.Fatalf("an orphaned member row must keep peers non-empty; peer_missing must be false")
		}
		if len(item.Participants) != 1 || item.Participants[0] != player2ID {
			t.Fatalf("participants must carry the deleted peer %q, got %v", player2ID, item.Participants)
		}
		// present-but-empty is the contract: the peer resolves to a COALESCE'd
		// empty nickname, which is exactly what makes the frontend print the
		// placeholder instead of a nameless "User".
		if name, ok := item.ParticipantNames[player2ID]; !ok || name != "" {
			t.Fatalf("participantNames must carry an empty entry for the deleted peer, got ok=%v name=%q", ok, name)
		}
		// The avatar entry is present-but-empty too, so a real (removed) account
		// never falls back to a generated initial by accident.
		if _, ok := item.ParticipantAvatars[player2ID]; !ok {
			t.Fatalf("participantAvatars must carry an entry for the deleted peer, got %v", item.ParticipantAvatars)
		}

		// The history stays readable: the caller is still a member, so the
		// thread opens — the whole point of the LEFT JOIN. Before it the row was
		// dropped and the thread could not be addressed at all.
		if status, payload := doJSON(t, ts.URL, http.MethodGet, "/api/aerun/dms/"+convID+"/messages", player1Token, "", ""); status != http.StatusOK {
			t.Fatalf("history must stay readable after the peer is removed, got %d: %v", status, payload)
		}

		// D3: a reply into a thread whose counterpart is gone is refused, not
		// silently dropped into a void.
		if status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms/"+convID+"/messages",
			player1Token, "dm-removed-peer", `{"text":"still there?"}`); status != http.StatusForbidden {
			t.Fatalf("sending into a conversation with a removed peer must be refused (403), got %d: %v", status, payload)
		}
	})

	// Case C — the migration ghost: a conversation carrying ONLY the caller's
	// membership row (the second participant never imported, so there is no row
	// to orphan). peers is empty → peer_missing is true, the cue the frontend
	// uses to render the placeholder and refuse to open the thread.
	t.Run("migration ghost with no peer row is flagged peer_missing", func(t *testing.T) {
		app := newAerunTestApp(t)
		defer app.Cleanup()

		tokens := seedIdentityFixtures(t, app)
		player1Token := tokens["player"]

		convID := seedDMConversation(t, app, fixPlayerID)

		ts := newTestServer(t, app)
		defer ts.Close()

		item := findInboxItem(t, listInbox(t, ts.URL, player1Token), convID)
		if !item.PeerMissing {
			t.Fatalf("a conversation with only the caller's row must be peer_missing=true, got false")
		}
		if len(item.Participants) != 0 {
			t.Fatalf("peer_missing must mean no navigable participants, got %v", item.Participants)
		}
	})

	// Control — both members alive: the healthy contract the two cases deviate
	// from. The peer resolves to its real nickname and a send succeeds.
	t.Run("both members alive resolves the peer and accepts a send", func(t *testing.T) {
		app := newAerunTestApp(t)
		defer app.Cleanup()

		tokens := seedIdentityFixtures(t, app)
		player1Token := tokens["player"]
		player2ID, _ := seedSecondPlayer(t, app)

		convID := seedDMConversation(t, app, fixPlayerID, player2ID)

		ts := newTestServer(t, app)
		defer ts.Close()

		item := findInboxItem(t, listInbox(t, ts.URL, player1Token), convID)
		if item.PeerMissing {
			t.Fatalf("a healthy conversation must not be peer_missing")
		}
		if item.ParticipantNames[player2ID] != "PlayerTwo" {
			t.Fatalf("a live peer must resolve to its nickname, got %q", item.ParticipantNames[player2ID])
		}

		if status, payload := doJSON(t, ts.URL, http.MethodPost, "/api/aerun/dms/"+convID+"/messages",
			player1Token, "dm-live-peer", `{"text":"still there?"}`); status != http.StatusOK {
			t.Fatalf("a send into a healthy conversation must succeed (200), got %d: %v", status, payload)
		}
	})
}
