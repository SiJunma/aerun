// dm_race_test.go pins the owner's race ruling (2026-10-14): when two members
// send the first message of the same pair at nearly the same moment, the pair
// ends up with ONE conversation carrying BOTH messages — never two threads.
//
// The defect this closes: before the draft flow, every POST /api/aerun/dms ran
// straight to INSERT. Two concurrent first-sends (A→B and B→A, the exact shape
// of two drafts opened on both sides) produced two conversations with one
// message each. The in-transaction pair re-check in createDMHandler converts
// the loser into an append through the same appendMessageToConversation body
// that reply sends use, so the two paths share sequence assignment, preview
// updates, watermarks and delivery.
//
// Both posts carry DIFFERENT idempotency keys and DIFFERENT actors, so the
// convergence must not come from idempotency replay: the response of each call
// is its author's own row, and both rows land in the one surviving thread.
package pocketbase

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// dmRaceResult is one concurrent first-send and what the server answered.
type dmRaceResult struct {
	StatusCode     int
	ConversationID string
	Message        map[string]any
	Raw            string
}

// postDMCreate POSTs one first message to /api/aerun/dms and decodes the
// response the way the draft client reads it: conversation_id + the author's
// own normalized message row.
func postDMCreate(t testing.TB, tsURL, token, recipientID, text, idemKey string) dmRaceResult {
	t.Helper()
	body := fmt.Sprintf(`{"recipient_ids":[%q],"title":"Race","text":%q}`, recipientID, text)
	req, _ := http.NewRequest(http.MethodPost, tsURL+"/api/aerun/dms", strings.NewReader(body))
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", idemKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var payload struct {
		ConversationID string         `json:"conversation_id"`
		Message        map[string]any `json:"message"`
	}
	_ = json.Unmarshal(raw, &payload)
	return dmRaceResult{
		StatusCode:     res.StatusCode,
		ConversationID: payload.ConversationID,
		Message:        payload.Message,
		Raw:            string(raw),
	}
}

// TestDMRaceTwoFirstSendsShareOneConversation is the ruling test: two members
// open drafts with each other and both press send before either request lands.
// Both calls must answer 200, exactly ONE conversation may exist for the pair,
// and the thread must carry BOTH messages as sequence 1 and 2 with
// messages_count == 2.
//
// The two posts differ in ACTOR and in Idempotency-Key, so convergence cannot
// come from idempotency replay: it has to come from the loser's in-transaction
// re-check finding the winner's conversation and appending through
// appendMessageToConversation.
func TestDMRaceTwoFirstSendsShareOneConversation(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	playerToken := tokens["player"]
	player2ID, player2Token := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	// One virgin pair, one race: A→B and B→A at the same instant.
	aText := "race: A opens first"
	bText := "race: B opens first"
	results := make([]dmRaceResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		results[0] = postDMCreate(t, ts.URL, playerToken, player2ID, aText, "dm-race-a-1")
	}()
	go func() {
		defer wg.Done()
		results[1] = postDMCreate(t, ts.URL, player2Token, fixPlayerID, bText, "dm-race-b-1")
	}()
	wg.Wait()

	for i, r := range results {
		if r.StatusCode != http.StatusOK {
			t.Fatalf("race send %d = %d: %s (both first-sends must succeed)", i, r.StatusCode, r.Raw)
		}
		if r.Message == nil {
			t.Fatalf("race send %d returned no message row: %s", i, r.Raw)
		}
	}
	if results[0].ConversationID == "" || results[1].ConversationID == "" {
		t.Fatalf("both sends must name a conversation, got %q and %q",
			results[0].ConversationID, results[1].ConversationID)
	}
	if results[0].ConversationID != results[1].ConversationID {
		t.Fatalf("the two first-sends converged on DIFFERENT conversations %q and %q — want one thread",
			results[0].ConversationID, results[1].ConversationID)
	}
	convID := results[0].ConversationID
	// Each answer is its AUTHOR's own row, not the peer's: the winner carries
	// sequence 1, the loser sequence 2. That is the whole "no replay" proof —
	// an idempotency replay would have handed back someone else's message.
	seqOf := func(r dmRaceResult) int {
		n, _ := r.Message["sequence"].(float64)
		return int(n)
	}
	gotSeqs := map[int]bool{seqOf(results[0]): true, seqOf(results[1]): true}
	if !gotSeqs[1] || !gotSeqs[2] {
		t.Fatalf("answer sequences = %v, want one 1 and one 2", gotSeqs)
	}
	ownText := func(r dmRaceResult) string {
		text, _ := r.Message["text"].(string)
		return text
	}
	if !((ownText(results[0]) == aText && ownText(results[1]) == bText) ||
		(ownText(results[0]) == bText && ownText(results[1]) == aText)) {
		t.Fatalf("the answers do not carry their own rows: %q vs %q", ownText(results[0]), ownText(results[1]))
	}

	// Ground truth from the tables, not the API answers above: exactly one
	// conversation may have both members.
	pairConvs, err := app.FindRecordsByFilter(
		dmMembersCollectionName,
		"user_id = {:u}",
		"",
		1000,
		0,
		map[string]any{"u": fixPlayerID},
	)
	if err != nil {
		t.Fatal(err)
	}
	shared := 0
	for _, m := range pairConvs {
		if partner, perr := app.FindRecordsByFilter(
			dmMembersCollectionName,
			"conversation_id = {:c} && user_id = {:p}",
			"",
			1,
			0,
			map[string]any{"c": m.GetString("conversation_id"), "p": player2ID},
		); perr != nil {
			t.Fatal(perr)
		} else if len(partner) > 0 {
			shared++
			if m.GetString("conversation_id") != convID {
				t.Fatalf("an extra shared conversation exists: %q — want only %q",
					m.GetString("conversation_id"), convID)
			}
		}
	}
	if shared != 1 {
		t.Fatalf("the pair shares %d conversations, want exactly 1", shared)
	}

	// The thread carries both texts, in sequence order 1 then 2.
	conv, _ := app.FindRecordById(dmConversationsCollectionName, convID)
	if got := conv.GetInt("messages_count"); got != 2 {
		t.Fatalf("messages_count = %d, want 2 — the loser's message was dropped", got)
	}
	items := dmListMessages(t, ts.URL, playerToken, convID)
	if len(items) != 2 {
		t.Fatalf("the thread serves %d messages, want 2", len(items))
	}
	asNum := func(v any) int {
		n, _ := v.(float64)
		return int(n)
	}
	if asNum(items[0]["sequence"]) != 1 || asNum(items[1]["sequence"]) != 2 {
		t.Fatalf("sequences = [%v %v], want [1 2]", items[0]["sequence"], items[1]["sequence"])
	}
	seen := map[string]bool{}
	for _, it := range items {
		text, _ := it["text"].(string)
		seen[text] = true
	}
	if !seen[aText] || !seen[bText] {
		t.Fatalf("the thread texts = %v, want both first-sends %q and %q", seen, aText, bText)
	}

	// Read watermarks. The create path sets the WINNER's sender watermark to 1
	// once, at creation, and the append path only ever advances the SENDER's
	// own row — so after the race:
	//   - the winner's watermark stays 1 (their own seed row; the loser's seq-2
	//     row is unread FOR them — exactly what lights their badge);
	//   - the loser entered as a recipient (watermark 0) and their append
	//     advanced their own row to 2 (they have read everything, badge off).
	// The badge therefore tells the winner "you have the loser's message" and
	// tells the loser nothing — which is the correct per-member accounting.
	memberOf := func(uid string) int {
		rows, merr := app.FindRecordsByFilter(
			dmMembersCollectionName,
			"conversation_id = {:c} && user_id = {:u}",
			"",
			1,
			0,
			map[string]any{"c": convID, "u": uid},
		)
		if merr != nil || len(rows) == 0 {
			t.Fatalf("member row missing for %s: %v", uid, merr)
		}
		return rows[0].GetInt("last_read_sequence")
	}
	winner := fixPlayerID
	if seqOf(results[1]) == 1 {
		winner = player2ID
	}
	loser := fixPlayerID
	if winner == fixPlayerID {
		loser = player2ID
	}
	if got := memberOf(winner); got != 1 {
		t.Fatalf("the winner %s has watermark %d, want 1 (their seed; the peer's seq 2 is their unread)", winner, got)
	}
	if got := memberOf(loser); got != 2 {
		t.Fatalf("the loser %s has watermark %d, want 2 (their append read everything)", loser, got)
	}
}
