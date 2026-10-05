package pocketbase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestDMListingCarriesParticipants pins the inbox contract.
//
// The inbox row is addressed by WHO you are talking to: the client navigates to
// /messages/:uid off the participant list and prints participantNames[uid]. The
// listing returned neither, so every row rendered as a nameless "User" and
// opening one threw `Cannot read properties of undefined (reading 'find')`.
//
// It survived because no conversation had ever been listed in a database — the
// first legacy import brought real DMs with it and made the path reachable.
func TestDMListingCarriesParticipants(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	create := func(recipientID, text, idemKey string) {
		t.Helper()
		body := fmt.Sprintf(`{"recipient_ids":["%s"],"text":%q}`, recipientID, text)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", idemKey)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("create dm: expected 200, got %d: %s", res.StatusCode, b)
		}
		res.Body.Close()
	}

	create(player2ID, "first", "dm-inbox-first")
	create(player2ID, "second", "dm-inbox-second")

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/dms", nil)
	req.Header.Set("Authorization", player1Token)
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
		Items []struct {
			ID                 string            `json:"id"`
			Participants       []string          `json:"participants"`
			ParticipantNames   map[string]string `json:"participantNames"`
			ParticipantAvatars map[string]string `json:"participantAvatars"`
			Unread             map[string]int    `json:"unread"`
		} `json:"items"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) == 0 {
		t.Fatal("expected at least one conversation")
	}

	// Asserted per row rather than on a single item: the listing may hold more
	// than one thread, and every one of them owes the client a peer.
	for _, conv := range payload.Items {
		if len(conv.Participants) != 1 || conv.Participants[0] != player2ID {
			t.Fatalf("participants must be exactly the peer %q, got %v", player2ID, conv.Participants)
		}
		// The caller must not be able to navigate to a conversation with themselves.
		for _, uid := range conv.Participants {
			if uid == fixPlayerID {
				t.Fatalf("participants must exclude the caller %q, got %v", fixPlayerID, conv.Participants)
			}
		}
		if conv.ParticipantNames[player2ID] != "PlayerTwo" {
			t.Fatalf("participantNames must carry the peer nickname, got %v", conv.ParticipantNames)
		}
		// Present-but-empty is the contract: the row must carry the peer's entry
		// so the client reads an avatar rather than silently falling back to a
		// generated initial for every conversation.
		if _, ok := conv.ParticipantAvatars[player2ID]; !ok {
			t.Fatalf("participantAvatars must carry an entry for the peer, got %v", conv.ParticipantAvatars)
		}
		if _, ok := conv.Unread[fixPlayerID]; !ok {
			t.Fatalf("unread must be keyed by the caller, got %v", conv.Unread)
		}
	}
}

// TestListDMMessagesPagesFromTheEnd pins the direction of the thread.
//
// The listing ordered by sequence ASC and kept the first `limit` rows, so it
// returned sequences 1..N — the very BEGINNING of the conversation. Opening a
// thread showed its oldest messages instead of the newest, and the "load older
// messages" button had nothing left to ask for, because what was already on
// screen was the oldest that existed.
func TestListDMMessagesPagesFromTheEnd(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	const total = 25
	convID := ""
	post := func(url, key, body string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, ts.URL+url, strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("post %s: expected 200, got %d: %s", url, res.StatusCode, b)
		}
		return res
	}

	// One conversation, then messages posted into it — the way a thread actually
	// grows. POSTing /dms repeatedly would start a NEW conversation per call.
	res := post("/api/aerun/dms", "dm-page-conv", fmt.Sprintf(`{"recipient_ids":["%s"],"text":"first"}`, player2ID))
	var created struct {
		ConversationID string `json:"conversation_id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	convID = created.ConversationID
	if convID == "" {
		t.Fatal("no conversation was created")
	}

	for i := 1; i < total; i++ {
		res := post(fmt.Sprintf("/api/aerun/dms/%s/messages", convID),
			fmt.Sprintf("dm-page-%d", i),
			fmt.Sprintf(`{"text":"msg %d"}`, i))
		res.Body.Close()
	}

	type page struct {
		Items []struct {
			ID       string `json:"id"`
			Sequence int    `json:"sequence"`
		} `json:"items"`
		HasMore        bool `json:"has_more"`
		OldestSequence int  `json:"oldest_sequence"`
	}
	getPage := func(query string) page {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/dms/"+convID+"/messages?"+query, nil)
		req.Header.Set("Authorization", player1Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("list %s: expected 200, got %d: %s", query, res.StatusCode, b)
		}
		var p page
		if err := json.NewDecoder(res.Body).Decode(&p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	first := getPage("limit=5")
	if len(first.Items) != 5 {
		t.Fatalf("expected a 5-message page, got %d", len(first.Items))
	}
	// The page must END at the newest message, not begin at the oldest.
	lastSeq := first.Items[len(first.Items)-1].Sequence
	if lastSeq != total {
		t.Fatalf("an opened thread must show the newest message (sequence %d), got %d", total, lastSeq)
	}
	// And it reads oldest-first within the page.
	for i := 1; i < len(first.Items); i++ {
		if first.Items[i].Sequence <= first.Items[i-1].Sequence {
			t.Fatalf("page must be chronological, got %d after %d", first.Items[i].Sequence, first.Items[i-1].Sequence)
		}
	}
	if !first.HasMore {
		t.Fatal("a partial page of a longer thread must report older messages exist")
	}
	if first.OldestSequence != first.Items[0].Sequence {
		t.Fatalf("oldest_sequence must be the first row of the page, got %d", first.OldestSequence)
	}

	// Walking back must return strictly older rows, and must not repeat the page
	// just shown — the old implementation ignored the cursor entirely and so
	// handed back the identical set every click.
	second := getPage(fmt.Sprintf("limit=5&before_sequence=%d", first.OldestSequence))
	if len(second.Items) == 0 {
		t.Fatal("walking back must return a page")
	}
	for _, m := range second.Items {
		if m.Sequence >= first.OldestSequence {
			t.Fatalf("page two must be strictly older than %d, got %d", first.OldestSequence, m.Sequence)
		}
	}

	// Walk to the beginning and confirm the thread terminates rather than
	// repeating forever.
	seen := map[int]bool{}
	before := first.OldestSequence
	hasMore := first.HasMore
	for guard := 0; guard < 20 && hasMore; guard++ {
		p := getPage(fmt.Sprintf("limit=5&before_sequence=%d", before))
		if len(p.Items) == 0 {
			break
		}
		for _, m := range p.Items {
			if seen[m.Sequence] {
				t.Fatalf("pagination looped: sequence %d seen twice", m.Sequence)
			}
			seen[m.Sequence] = true
		}
		before = p.OldestSequence
		hasMore = p.HasMore
	}
}

// The browser used to answer this by reading `dm_members` directly, which is a
// server-only collection, so it was refused every time and the client fell
// through to creating a NEW thread — so every visit to a correspondent started
// another "Conversation started". The server now resolves it.
func TestFindConversationWithPeerDoesNotDuplicate(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	peerLookup := func(token, peerID string) string {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/conversations/peer/"+peerID, nil)
		req.Header.Set("Authorization", token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("peer lookup: expected 200, got %d: %s", res.StatusCode, b)
		}
		var payload struct {
			ConversationID string `json:"conversation_id"`
		}
		if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		return payload.ConversationID
	}

	// No thread yet: an empty answer, NOT an error, so the client creates one.
	if id := peerLookup(player1Token, player2ID); id != "" {
		t.Fatalf("expected no conversation before one is started, got %q", id)
	}

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"text":"hello"}`, player2ID)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
	req.Header.Set("Authorization", player1Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "dm-peer-seed")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("create dm: expected 200, got %d: %s", res.StatusCode, b)
	}
	res.Body.Close()

	found := peerLookup(player1Token, player2ID)
	if found == "" {
		t.Fatal("peer lookup must find the conversation that now exists")
	}

	// The answer must be the SAME thread on every repeat, or the client creates
	// a duplicate every time the page is opened.
	if again := peerLookup(player1Token, player2ID); again != found {
		t.Fatalf("peer lookup must be stable, got %q then %q", found, again)
	}

	// Symmetry: the other member resolves the same thread.
	if other := peerLookup(player2Token, fixPlayerID); other != found {
		t.Fatalf("both members must resolve the same conversation, got %q vs %q", other, found)
	}

	// And it must never hand back a conversation the caller is not part of.
	if third := peerLookup(player2Token, fixBannedID); third != "" {
		t.Fatalf("must not resolve a conversation with a non-correspondent, got %q", third)
	}
}

// TestDMEditAndDeleteSignalTheOtherSide proves the mutation is VISIBLE to the
// other participant, not merely stored.
//
// Sending a DM published a `dm.post` signal; editing and deleting one did not.
// So a member who corrected or withdrew their own message left the other side
// reading the old words until some unrelated poll happened to land - which,
// with the message list now event-driven and only polling as a fallback, could
// be a long time.
//
// Asserted through the real handlers, because what broke is exactly the wiring
// between "the row changed" and "the other browser was told".
func TestDMEditAndDeleteSignalTheOtherSide(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"text":"original words"}`, player2ID)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
	req.Header.Set("Authorization", player1Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "dm-signal-edit")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		ConversationID string `json:"conversation_id"`
		Message        struct {
			ID string `json:"id"`
		} `json:"message"`
	}
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	msgID := created.Message.ID
	if created.ConversationID == "" || msgID == "" {
		t.Fatalf("expected a conversation and a message, got %q / %q", created.ConversationID, msgID)
	}

	mutate := func(method, path, payload, key string) {
		t.Helper()
		r, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(payload))
		r.Header.Set("Authorization", player1Token)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", key)
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("%s %s: expected 200, got %d: %s", method, path, resp.StatusCode, b)
		}
	}

	player2 := subscribeAsSignalClient(t, app, authRecordFor(t, app, player2ID))

	// Edit and delete live on /dm-messages/{id}, NOT under /dms/{id}/... — the
	// message is addressed on its own, which is also why the signal is keyed by
	// message id.
	mutate(http.MethodPatch, "/api/aerun/dm-messages/"+msgID, `{"text":"corrected words"}`, "dm-signal-edit-op")

	msg, ok := awaitSignal(t, player2, 3*time.Second)
	if !ok {
		t.Fatal("editing a DM did not reach the other participant in realtime")
	}
	if b := signalBody(t, msg); !strings.Contains(b, realtimeSignalDMPost) {
		t.Errorf("the edit signal must be a dm.post signal: %s", b)
	}

	mutate(http.MethodDelete, "/api/aerun/dm-messages/"+msgID, "", "dm-signal-delete-op")

	if _, ok := awaitSignal(t, player2, 3*time.Second); !ok {
		t.Fatal("deleting a DM did not reach the other participant in realtime")
	}
}
