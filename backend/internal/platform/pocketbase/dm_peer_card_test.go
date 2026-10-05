package pocketbase

// GET /api/aerun/peers/{id} - the DM header's view of the correspondent.
//
// REPORTED: "the handler that brings EVERYTHING about a user, including their
// settings, still loads" on a private conversation.
//
// That is accurate, and it is not a server leak. Two effects in DirectMessages
// each read the profile DTO for the SAME peer - the chat header (a nickname and
// an avatar) and the composer lock (one boolean) - and /api/aerun/users/{id} is
// the profile PAGE: bio, birthday, occupation, interests, contacts, three
// counters, the registration day, and a `settings` object. The DTO already
// narrows `settings` to three keys for a non-owner, so this was never a
// stranger's private preferences being published on purpose. It is a page being
// fetched to render a corner of it.
//
// The fix is a route that answers the question actually being asked. These tests
// pin both halves: the small set really does carry what the thread renders (so a
// refactor cannot quietly drop `status` and leave the composer unlocked for a
// banned peer), and the payload really does carry nothing else (so the profile
// DTO cannot creep back in through a copy-paste).

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// fetchPeerCard reads the peer card as `token`.
func fetchPeerCard(t *testing.T, tsURL, token, peerID string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, tsURL+"/api/aerun/peers/"+peerID, nil)
	if token != "" {
		req.Header.Set("Authorization", token)
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

// TestPeerCardCarriesWhatTheThreadRenders pins the contract from the client's
// side: nickname, avatar and status, and nothing this screen cannot use.
func TestPeerCardCarriesWhatTheThreadRenders(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, card := fetchPeerCard(t, ts.URL, tokens["player"], secondID)
	if status != http.StatusOK {
		t.Fatalf("peer card = %d: %v", status, card)
	}

	if got, _ := card["id"].(string); got != secondID {
		t.Errorf("id = %q, want %q", got, secondID)
	}
	// The header renders this, so an absent nickname would show "User".
	if _, has := card["nickname"]; !has {
		t.Error("the card must carry a nickname - the chat header renders it")
	}
	if _, has := card["avatar"]; !has {
		t.Error("the card must carry an avatar field, even when empty")
	}
	// The load-bearing one. The composer lock compares this against 'banned', and
	// the old code compared the ROLE column instead, so the lock never engaged.
	if _, has := card["status"]; !has {
		t.Error("the card must carry `status` - the composer lock cannot read the role column")
	}
}

// TestPeerCardCarriesNoProfilePayload is the reported bug as a test.
//
// Each key listed here is one the DM thread has no use for, and they are named
// individually so a failure says which one crept back.
func TestPeerCardCarriesNoProfilePayload(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	_, card := fetchPeerCard(t, ts.URL, tokens["player"], secondID)

	for _, key := range []string{
		// The one from the report. `settings` holds sound volume, which
		// notifications are muted, mail preferences, theme and language.
		"settings",
		"bio", "location", "birthday", "occupation", "interests", "contacts",
		// The profile page's counters and identity facts.
		"posts_count", "topics_count", "reputation", "status_line", "verified",
		"created_at",
		// A DM header draws no role badge.
		"role", "custom_role_id",
	} {
		if _, present := card[key]; present {
			t.Errorf("the peer card must not carry %q - the DM thread renders no such thing", key)
		}
	}
}

// TestPeerCardIsReadByGuests pins visibility: a nickname, an avatar and a status
// are what every profile page already shows to anyone, so the chat header must
// not 403 for a signed-out visitor and leave a blank name.
func TestPeerCardIsReadByGuests(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, card := fetchPeerCard(t, ts.URL, "", secondID)
	if status != http.StatusOK {
		t.Fatalf("a guest reading a peer card = %d: %v (visibility matches /users/{id})", status, card)
	}
}

// TestPeerCardUnknownPeerIs404: an account that does not exist is an error the
// composer can act on, not a card of empty strings that reads as "active".
func TestPeerCardUnknownPeerIs404(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	status, _ := fetchPeerCard(t, ts.URL, tokens["player"], "doesnotexist000000")
	if status != http.StatusNotFound {
		t.Errorf("an unknown peer = %d, want 404", status)
	}
}

// TestPeerCardReportsBannedStatus: the composer's whole reason for reading this
// endpoint. `banned` is an ACCOUNT STATUS and not a role (internal/auth), so this
// fails if the payload ever starts reading the other column.
func TestPeerCardReportsBannedStatus(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	secondID, _ := seedSecondPlayer(t, app)
	ts := newTestServer(t, app)
	defer ts.Close()

	record, err := app.FindRecordById(usersCollectionName, secondID)
	if err != nil || record == nil {
		t.Fatalf("fixture peer missing: %v", err)
	}
	record.Set("status", "banned")
	if err := app.Save(record); err != nil {
		t.Fatalf("ban the fixture peer: %v", err)
	}

	_, card := fetchPeerCard(t, ts.URL, tokens["player"], secondID)
	if got, _ := card["status"].(string); got != "banned" {
		t.Errorf("status = %q, want banned - the composer lock reads exactly this", got)
	}
}
