package pocketbase

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// TestDMReadSignalWakesOnlyTheReader pins the badge fix.
//
// REPORTED: "messages are on screen, the badge stays". The thread POSTed
// /dms/{id}/read, the server row moved — and nobody re-read it: the
// unread-counts poll has no timer while realtime is connected, and no signal
// was published for a read. So this test asserts that mark-read publishes a
// dm.post nudge ADDRESSED TO THE READER (whose counters changed), and that a
// peer with a live stream does NOT receive it (their counters did not move,
// and a conversation id is not something a non-reader may learn).
func TestDMReadSignalWakesOnlyTheReader(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)
	clearMemberOnlineForTest(player2ID)

	reader := subscribeAsSignalClient(t, app, authRecordFor(t, app, player2ID))
	peer := subscribeAsSignalClient(t, app, authRecordFor(t, app, fixPlayerID))

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, p := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-read-signal-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	convID := p["conversation_id"].(string)

	// Drain the send-time signals (one dm.post to the reader) so the read
	// below is the only thing that can deliver afterwards.
	_, _ = awaitSignal(t, reader, 3*time.Second)

	readURL := fmt.Sprintf("%s/api/aerun/dms/%s/read", ts.URL, convID)
	status, _ = postDM(t, readURL, player2Token, "dm-read-signal-2", `{}`)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on read, got %d", status)
	}

	msg, ok := awaitSignal(t, reader, 3*time.Second)
	if !ok {
		t.Fatal("mark-read must publish a signal to the reader, or the badge keeps the last polled value")
	}
	if body := signalBody(t, msg); !strings.Contains(body, realtimeSignalDMPost) {
		t.Errorf("the read signal must reuse the dm.post topic the counters already listen to: %s", body)
	}

	if extra, ok := awaitSignal(t, peer, 500*time.Millisecond); ok {
		t.Fatalf("the sender must not be woken by somebody else catching up: %s", signalBody(t, extra))
	}
}
