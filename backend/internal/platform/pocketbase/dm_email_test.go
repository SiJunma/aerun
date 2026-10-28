package pocketbase

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"
)

// markMemberOnlineForTest registers userID in the in-process presence map as
// if a heartbeat just landed. Presence is process-local, so tests share the
// same map the handlers read.
func markMemberOnlineForTest(userID string) {
	presenceMu.Lock()
	defer presenceMu.Unlock()
	onlineMembers[userID] = userPresence{UserID: userID, Nickname: "t", LastSeen: time.Now()}
}

// clearMemberOnlineForTest removes userID from the presence map.
func clearMemberOnlineForTest(userID string) {
	presenceMu.Lock()
	delete(onlineMembers, userID)
	presenceMu.Unlock()
}

func setDMEmailPref(t testing.TB, app *tests.TestApp, userID string, enabled bool) {
	t.Helper()
	rec, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || rec == nil {
		t.Fatalf("user missing: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"email_notifications": map[string]any{"dms": enabled}})
	rec.Set("settings", string(raw))
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to set email pref: %v", err)
	}
}

func postDM(t testing.TB, url, token, key, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Authorization", token)
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	var p map[string]any
	_ = json.Unmarshal(b, &p)
	return res.StatusCode, p
}

func countOutboxByKey(t testing.TB, app *tests.TestApp, dedupeKey string) int {
	t.Helper()
	rows, err := app.FindAllRecords(outboxEventsCollectionName, nil)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range rows {
		if dedupeKey == "" || r.GetString("dedupe_key") == dedupeKey {
			n++
		}
	}
	return n
}

// TestDMEmailSkippedWhenRecipientOnline verifies the enqueue-time guard: when
// the DM recipient is online, no outbox email is queued at all and no in-app
// notification is created.
func TestDMEmailSkippedWhenRecipientOnline(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)
	markMemberOnlineForTest(player2ID)
	defer clearMemberOnlineForTest(player2ID)

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, _ := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-online-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if n := countOutboxByKey(t, app, ""); n != 0 {
		t.Fatalf("online recipient must queue no email, got %d outbox rows", n)
	}
	stale, _ := app.FindFirstRecordByFilter(notificationsCollectionName, "recipient_id = {:r} && type = 'dm'", map[string]any{"r": player2ID})
	if stale != nil {
		t.Fatal("online or not, DMs must not create in-app notifications")
	}
}

// TestDMEmailSkippedWhenDisabled verifies that when the recipient has disabled
// DM mail (settings.email_notifications.dms = false), no outbox email is queued.
func TestDMEmailSkippedWhenDisabled(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)
	clearMemberOnlineForTest(player2ID)
	setDMEmailPref(t, app, player2ID, false)

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, _ := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-disabled-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if n := countOutboxByKey(t, app, ""); n != 0 {
		t.Fatalf("disabled DM mail must queue no email, got %d rows", n)
	}
}

// TestDMEmailSkippedWhenBothOnline verifies the regression fix for the case
// where BOTH the sender and the recipient are online: a DM email must never be
// queued (enqueue-time guard), and no in-app notification may be created.
func TestDMEmailSkippedWhenBothOnline(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)
	markMemberOnlineForTest(fixPlayerID)
	markMemberOnlineForTest(player2ID)
	defer func() {
		clearMemberOnlineForTest(fixPlayerID)
		clearMemberOnlineForTest(player2ID)
	}()

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, _ := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-bothonline-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if n := countOutboxByKey(t, app, ""); n != 0 {
		t.Fatalf("both-online recipient must queue no email, got %d outbox rows", n)
	}
	stale, _ := app.FindFirstRecordByFilter(notificationsCollectionName, "recipient_id = {:r} && type = 'dm'", map[string]any{"r": player2ID})
	if stale != nil {
		t.Fatal("both-online DMs must not create in-app notifications")
	}
}

// TestDMEmailSentWhenRecipientLoggedOut verifies that when the recipient
// signed out long ago (users.last_seen older than presenceTTL), they are
// recognized as offline and an outbox email is properly enqueued.
func TestDMEmailSentWhenRecipientLoggedOut(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)

	// Simulate player2 having left a long time ago: not in the live map and
	// last_seen well outside the 15-minute online window.
	clearMemberOnlineForTest(player2ID)
	rec, _ := app.FindRecordById(usersCollectionName, player2ID)
	rec.Set(userLastSeenField, time.Now().UTC().Add(-20*time.Minute).Format(time.RFC3339))
	_ = app.Save(rec)

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, payload := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-logout-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	convID := payload["conversation_id"].(string)

	dedupeKey := fmt.Sprintf("dm:first-unread:%s:%s", convID, player2ID)
	if n := countOutboxByKey(t, app, dedupeKey); n != 1 {
		t.Fatalf("offline recipient must queue exactly 1 outbox row, got %d", n)
	}
}

// TestDMEmailSkippedWhenRecipientRecentlyActive verifies that a recipient who
// is not in the live onlineMembers map (e.g. background tab throttled the
// heartbeat) but whose users.last_seen is inside the 15-minute window still
// blocks the DM email — they were recently on the forum.
func TestDMEmailSkippedWhenRecipientRecentlyActive(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, _ := seedSecondPlayer(t, app)

	// Not in onlineMembers at all, but last_seen is 2 minutes ago — inside the
	// 15-minute active window.
	clearMemberOnlineForTest(player2ID)
	rec, _ := app.FindRecordById(usersCollectionName, player2ID)
	rec.Set(userLastSeenField, time.Now().UTC().Add(-2*time.Minute).Format(time.RFC3339))
	_ = app.Save(rec)

	ts := newTestServer(t, app)
	defer ts.Close()

	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"hello"}`, player2ID)
	status, _ := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-recent-1", body)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if n := countOutboxByKey(t, app, ""); n != 0 {
		t.Fatalf("recently active recipient must queue no email, got %d outbox rows", n)
	}
	stale, _ := app.FindFirstRecordByFilter(notificationsCollectionName, "recipient_id = {:r} && type = 'dm'", map[string]any{"r": player2ID})
	if stale != nil {
		t.Fatal("recently active recipient must not get an in-app DM notification")
	}
}

// TestDMEmailDeduplicationAndResetOnRead verifies that:
// 1. Multiple messages while offline send only 1 email (deduplicated).
// 2. Marking conversation as read resets dedupe so the next message wave sends an email.
func TestDMEmailDeduplicationAndResetOnRead(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player2ID, player2Token := seedSecondPlayer(t, app)
	clearMemberOnlineForTest(player2ID)

	ts := newTestServer(t, app)
	defer ts.Close()

	// 1. Send first message while Player 2 is offline
	body1 := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Hi","text":"msg 1"}`, player2ID)
	status, p1 := postDM(t, ts.URL+"/api/aerun/dms", tokens["player"], "dm-dedupe-1", body1)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	convID := p1["conversation_id"].(string)
	dedupeKey := fmt.Sprintf("dm:first-unread:%s:%s", convID, player2ID)

	if n := countOutboxByKey(t, app, dedupeKey); n != 1 {
		t.Fatalf("expected 1 outbox event, got %d", n)
	}

	// 2. Send second message while Player 2 is STILL offline -> deduplicated, no second outbox row
	msgURL := fmt.Sprintf("%s/api/aerun/dms/%s/messages", ts.URL, convID)
	status, _ = postDM(t, msgURL, tokens["player"], "dm-dedupe-2", `{"text":"msg 2"}`)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if n := countOutboxByKey(t, app, dedupeKey); n != 1 {
		t.Fatalf("second message must be deduplicated, expected 1 outbox row, got %d", n)
	}

	// 3. Worker dispatches the outbox event (status -> sent)
	sender := &mockMailSender{}
	worker := NewOutboxWorker()
	processed, err := worker.ProcessBatch(context.Background(), app, sender, 10)
	if err != nil || processed != 1 {
		t.Fatalf("expected 1 processed event, got %d (err: %v)", processed, err)
	}

	// 4. Player 2 comes online, reads the conversation
	readURL := fmt.Sprintf("%s/api/aerun/dms/%s/read", ts.URL, convID)
	status, _ = postDM(t, readURL, player2Token, "read-1", `{}`)
	if status != http.StatusOK {
		t.Fatalf("expected 200 on read, got %d", status)
	}

	// The original dedupeKey must now be freed (retired with suffix)
	if n := countOutboxByKey(t, app, dedupeKey); n != 0 {
		t.Fatalf("marking read must retire old dedupe key, found %d rows with exact key", n)
	}

	// 5. Player 2 goes offline again
	clearMemberOnlineForTest(player2ID)

	// 6. Player 1 sends third message -> this is a NEW unread wave, so an outbox event MUST be queued!
	status, _ = postDM(t, msgURL, tokens["player"], "dm-dedupe-3", `{"text":"msg 3"}`)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}

	if n := countOutboxByKey(t, app, dedupeKey); n != 1 {
		t.Fatalf("new unread wave must queue fresh outbox email, got %d rows", n)
	}
}
