package pocketbase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// Helper to seed a second player for DM testing
func seedSecondPlayer(t testing.TB, app *tests.TestApp) (string, string) {
	t.Helper()
	id := "userplayer00002"
	token := createTestUser(t, app, id, "player2@example.com", "PlayerTwo", auth.RolePlayer, auth.StatusActive)
	return id, token
}

// ---------------------------------------------------------------------------
// 1. DM Conversation Creation, Membership, Sequencing and In-App Notifications
// ---------------------------------------------------------------------------

func TestSprint5DMConversationAndSequencing(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	var convID string

	// 1. Player 1 creates DM with Player 2
	{
		body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"Secret Plan","text":"Hello Player Two!"}`, player2ID)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Idempotency-Key", "dm-create-1")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(res.Body)
			t.Fatalf("expected 200 OK, got %d: %s", res.StatusCode, string(b))
		}

		var payload struct {
			ConversationID string         `json:"conversation_id"`
			Sequence       int            `json:"sequence"`
			Message        map[string]any `json:"message"`
		}
		_ = json.NewDecoder(res.Body).Decode(&payload)
		res.Body.Close()

		if payload.ConversationID == "" {
			t.Fatal("expected conversation_id")
		}
		convID = payload.ConversationID
		if payload.Sequence != 1 {
			t.Fatalf("expected initial sequence 1, got %d", payload.Sequence)
		}

		// Verify in-app notification created for Player 2
		notif, err := app.FindFirstRecordByFilter(notificationsCollectionName, "recipient_id = {:r}", map[string]any{"r": player2ID})
		if err != nil || notif == nil {
			t.Fatal("expected in-app notification for recipient")
		}
		if notif.GetString("type") != "dm" {
			t.Fatalf("expected type dm, got %s", notif.GetString("type"))
		}

		// Verify outbox email created for Player 2
		dedupeKey := fmt.Sprintf("dm:first-unread:%s:%s", convID, player2ID)
		outbox, err := app.FindFirstRecordByFilter(outboxEventsCollectionName, "dedupe_key = {:key}", map[string]any{"key": dedupeKey})
		if err != nil || outbox == nil {
			t.Fatal("expected outbox event for recipient")
		}
		if outbox.GetString("status") != "pending" {
			t.Fatalf("expected outbox status pending, got %s", outbox.GetString("status"))
		}
	}

	// 2. Player 1 sends a second message in the same conversation
	{
		body := `{"text":"Are you there?"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms/"+convID+"/messages", strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Idempotency-Key", "dm-msg-2")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}

		var payload struct {
			Sequence int `json:"sequence"`
		}
		_ = json.NewDecoder(res.Body).Decode(&payload)
		res.Body.Close()

		if payload.Sequence != 2 {
			t.Fatalf("expected sequence 2, got %d", payload.Sequence)
		}

		// Outbox events count must still be 1 (deduplicated!)
		allOutbox, _ := app.FindAllRecords(outboxEventsCollectionName, nil)
		if len(allOutbox) != 1 {
			t.Fatalf("expected strictly 1 deduplicated outbox event, got %d", len(allOutbox))
		}
	}

	// 3. Player 2 queries unread counts: 1 unread conversation, 2 unread messages
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/unread-counts", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var counts struct {
			UnreadConversations int `json:"unread_conversations"`
			TotalUnreadMessages int `json:"total_unread_messages"`
			UnreadNotifications int `json:"unread_notifications"`
		}
		_ = json.NewDecoder(res.Body).Decode(&counts)
		res.Body.Close()

		if counts.UnreadConversations != 1 {
			t.Fatalf("expected 1 unread conversation, got %d", counts.UnreadConversations)
		}
		if counts.TotalUnreadMessages != 2 {
			t.Fatalf("expected 2 unread messages, got %d", counts.TotalUnreadMessages)
		}
		if counts.UnreadNotifications < 1 {
			t.Fatalf("expected unread notifications >= 1, got %d", counts.UnreadNotifications)
		}
	}

	// 4. Player 2 reads conversation: POST /api/aerun/dms/{id}/read
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms/"+convID+"/read", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Unread count is now 0
		reqCounts, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/unread-counts", nil)
		reqCounts.Header.Set("Authorization", player2Token)
		resCounts, _ := http.DefaultClient.Do(reqCounts)
		var counts struct {
			TotalUnreadMessages int `json:"total_unread_messages"`
		}
		_ = json.NewDecoder(resCounts.Body).Decode(&counts)
		resCounts.Body.Close()

		if counts.TotalUnreadMessages != 0 {
			t.Fatalf("expected 0 unread messages after reading, got %d", counts.TotalUnreadMessages)
		}
	}

	// 5. Player 2 clears conversation: POST /api/aerun/dms/{id}/clear
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms/"+convID+"/clear", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Messages list returns 0 items for Player 2
		reqMsgs, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/dms/"+convID+"/messages", nil)
		reqMsgs.Header.Set("Authorization", player2Token)
		resMsgs, _ := http.DefaultClient.Do(reqMsgs)
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resMsgs.Body).Decode(&p)
		resMsgs.Body.Close()
		if len(p.Items) != 0 {
			t.Fatalf("expected 0 messages after clear, got %d", len(p.Items))
		}
	}

	// 6. Player 1 sends message 3 -> Player 2 now sees only message 3
	{
		time.Sleep(10 * time.Millisecond) // ensure timestamp > cleared_at
		body := `{"text":"New message after your clear!"}`
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms/"+convID+"/messages", strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Idempotency-Key", "dm-msg-3")
		req.Header.Set("Content-Type", "application/json")
		res, _ := http.DefaultClient.Do(req)
		res.Body.Close()

		reqMsgs, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/dms/"+convID+"/messages", nil)
		reqMsgs.Header.Set("Authorization", player2Token)
		resMsgs, _ := http.DefaultClient.Do(reqMsgs)
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resMsgs.Body).Decode(&p)
		resMsgs.Body.Close()
		if len(p.Items) != 1 {
			t.Fatalf("expected exactly 1 new message after clear, got %d", len(p.Items))
		}
		if p.Items[0]["sequence"].(float64) != 3 {
			t.Fatalf("expected sequence 3, got %v", p.Items[0]["sequence"])
		}
	}
}

// ---------------------------------------------------------------------------
// 2. Outbox Worker, Retry/Backoff, and Definition of Done (DoD)
// ---------------------------------------------------------------------------

type mockMailSender struct {
	mu           sync.Mutex
	calls        int
	failUntil    int
	sentMessages []string
}

func (m *mockMailSender) Send(ctx context.Context, to, subject, body string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.calls <= m.failUntil {
		return errors.New("temporary SMTP connection timeout")
	}
	m.sentMessages = append(m.sentMessages, to)
	return nil
}

func TestSprint5OutboxWorkerRetryAndDoD(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	// 1. Enqueue outbox event
	payload := MailPayload{
		RecipientID: "user1",
		ToEmail:     "user1@example.com",
		Subject:     "Test Subject",
		BodyText:    "Test Body",
	}
	err := app.RunInTransaction(func(txApp core.App) error {
		return enqueueOutboxEvent(txApp, "test:dedupe:key-1", "email:test", payload)
	})
	if err != nil {
		t.Fatal(err)
	}

	worker := &OutboxWorker{
		BaseDelay: 10 * time.Millisecond,
	}

	// 2. Run worker with failing sender (fails 1 time)
	sender := &mockMailSender{failUntil: 1}
	processed, err := worker.ProcessBatch(context.Background(), app, sender, 10)
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}

	// Record should be pending with attempts=1, next_attempt_at set
	rec, err := app.FindFirstRecordByFilter(outboxEventsCollectionName, "dedupe_key = 'test:dedupe:key-1'")
	if err != nil || rec == nil {
		t.Fatal("expected outbox record")
	}
	if rec.GetString("status") != "pending" {
		t.Fatalf("expected status pending, got %s", rec.GetString("status"))
	}
	if rec.GetInt("attempts") != 1 {
		t.Fatalf("expected attempts 1, got %d", rec.GetInt("attempts"))
	}
	if rec.GetString("last_error") == "" {
		t.Fatal("expected last_error to be recorded")
	}

	// 3. Fast-forward next_attempt_at to now and re-process: sender succeeds
	rec.Set("next_attempt_at", "")
	_ = app.Save(rec)

	processed, err = worker.ProcessBatch(context.Background(), app, sender, 10)
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 {
		t.Fatalf("expected 1 processed event, got %d", processed)
	}

	rec, _ = app.FindFirstRecordByFilter(outboxEventsCollectionName, "dedupe_key = 'test:dedupe:key-1'")
	if rec.GetString("status") != "sent" {
		t.Fatalf("expected status sent, got %s", rec.GetString("status"))
	}
	if rec.GetString("sent_at") == "" {
		t.Fatal("expected sent_at timestamp to be set")
	}

	// -----------------------------------------------------------------------
	// DoD Requirement: Restarting the worker does NOT resend an already successful event.
	// -----------------------------------------------------------------------
	senderCallsBefore := sender.calls
	processedAgain, err := worker.ProcessBatch(context.Background(), app, sender, 10)
	if err != nil {
		t.Fatal(err)
	}
	if processedAgain != 0 {
		t.Fatalf("DOD VIOLATION: worker reprocessed already successful event! processed=%d", processedAgain)
	}
	if sender.calls != senderCallsBefore {
		t.Fatalf("DOD VIOLATION: mail sender called again for sent event! calls=%d", sender.calls)
	}

	// -----------------------------------------------------------------------
	// DoD Requirement: Disabling SMTP still permits all forum and DM actions.
	// -----------------------------------------------------------------------
	tokens := seedIdentityFixtures(t, app)
	playerToken := tokens["player"]
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	// Sender is nil / explicit no-SMTP mode: DM action succeeds 100%
	body := fmt.Sprintf(`{"recipient_ids":["%s"],"title":"No SMTP Test","text":"Works without SMTP!"}`, player2ID)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
	req.Header.Set("Authorization", playerToken)
	req.Header.Set("Idempotency-Key", "no-smtp-dm-1")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK with disabled SMTP, got %d", res.StatusCode)
	}
	res.Body.Close()

	// Worker run with nil sender processes gracefully without errors
	workerProcessed, err := worker.ProcessBatch(context.Background(), app, nil, 10)
	if err != nil {
		t.Fatalf("worker failed with nil sender: %v", err)
	}
	if workerProcessed != 0 {
		t.Fatalf("expected 0 processed events with nil sender, got %d", workerProcessed)
	}
}

// ---------------------------------------------------------------------------
// 3. Concurrency: 20 Parallel DM Messages in One Conversation
// ---------------------------------------------------------------------------

func TestSprint5ConcurrentDMMessagesSequencing(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, _ := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	// Create conversation first
	var convID string
	{
		body := fmt.Sprintf(`{"recipient_ids":["%s"],"text":"Init DM"}`, player2ID)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms", strings.NewReader(body))
		req.Header.Set("Authorization", player1Token)
		req.Header.Set("Idempotency-Key", "concurrent-dm-init")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var p struct {
			ConversationID string `json:"conversation_id"`
		}
		_ = json.NewDecoder(res.Body).Decode(&p)
		res.Body.Close()
		convID = p.ConversationID
	}

	// 20 concurrent messages to the same conversation
	const concurrency = 20
	var wg sync.WaitGroup
	wg.Add(concurrency)

	type msgOutcome struct {
		StatusCode int
		Sequence   int
	}
	results := make([]msgOutcome, concurrency)

	for i := 0; i < concurrency; i++ {
		go func(idx int) {
			defer wg.Done()
			body := fmt.Sprintf(`{"text":"Concurrent message %d"}`, idx)
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/dms/"+convID+"/messages", strings.NewReader(body))
			req.Header.Set("Authorization", player1Token)
			req.Header.Set("Idempotency-Key", fmt.Sprintf("concurrent-dm-msg-%d", idx))
			req.Header.Set("Content-Type", "application/json")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				return
			}
			var p struct {
				Sequence int `json:"sequence"`
			}
			_ = json.NewDecoder(res.Body).Decode(&p)
			results[idx] = msgOutcome{
				StatusCode: res.StatusCode,
				Sequence:   p.Sequence,
			}
			res.Body.Close()
		}(i)
	}
	wg.Wait()

	// Verify all returned 200 OK
	seqMap := make(map[int]bool)
	for i, r := range results {
		if r.StatusCode != http.StatusOK {
			t.Fatalf("request %d failed with status %d", i, r.StatusCode)
		}
		if seqMap[r.Sequence] {
			t.Fatalf("duplicate sequence assigned: %d", r.Sequence)
		}
		seqMap[r.Sequence] = true
	}

	// Sequence numbers must be strictly contiguous from 2 to 21
	for seq := 2; seq <= concurrency+1; seq++ {
		if !seqMap[seq] {
			t.Fatalf("missing sequence number %d", seq)
		}
	}

	// Conversation messages_count in database must be exactly 21
	conv, _ := app.FindRecordById(dmConversationsCollectionName, convID)
	if conv.GetInt("messages_count") != 21 {
		t.Fatalf("expected conversation messages_count=21, got %d", conv.GetInt("messages_count"))
	}
}

// ---------------------------------------------------------------------------
// 4. Admin Outbox Visibility and Retry Endpoints
// ---------------------------------------------------------------------------

func TestSprint5AdminOutboxVisibilityAndRetry(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	rootToken := tokens["root"]
	playerToken := tokens["player"]

	ts := newTestServer(t, app)
	defer ts.Close()

	// Seed a failed outbox event
	col, _ := app.FindCollectionByNameOrId(outboxEventsCollectionName)
	event := core.NewRecord(col)
	event.Set("dedupe_key", "failed:event:1")
	event.Set("event_type", "email:test")
	event.Set("status", "failed")
	event.Set("attempts", 5)
	event.Set("last_error", "Hard bounce error")
	if err := app.Save(event); err != nil {
		t.Fatal(err)
	}

	// 1. Regular player denied from viewing outbox (403)
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/admin/outbox-events", nil)
		req.Header.Set("Authorization", playerToken)
		res, _ := http.DefaultClient.Do(req)
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden for player, got %d", res.StatusCode)
		}
		res.Body.Close()
	}

	// 2. Staff views outbox events (200)
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/admin/outbox-events", nil)
		req.Header.Set("Authorization", rootToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK for root, got %d", res.StatusCode)
		}
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(res.Body).Decode(&p)
		res.Body.Close()
		if len(p.Items) != 1 {
			t.Fatalf("expected 1 outbox event, got %d", len(p.Items))
		}
		if p.Items[0]["status"] != "failed" {
			t.Fatalf("expected status failed, got %v", p.Items[0]["status"])
		}
	}

	// 3. Staff retries event: POST /api/aerun/admin/outbox-events/{id}/retry
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/admin/outbox-events/"+event.Id+"/retry", nil)
		req.Header.Set("Authorization", rootToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK on retry, got %d", res.StatusCode)
		}
		res.Body.Close()

		updated, _ := app.FindRecordById(outboxEventsCollectionName, event.Id)
		if updated.GetString("status") != "pending" {
			t.Fatalf("expected status pending after retry, got %s", updated.GetString("status"))
		}
		if updated.GetInt("attempts") != 0 {
			t.Fatalf("expected attempts 0 after retry, got %d", updated.GetInt("attempts"))
		}
	}
}

// ---------------------------------------------------------------------------
// 5. User In-App Notifications Endpoints: List, Read, Read-All, Archive
// ---------------------------------------------------------------------------

func TestSprint5NotificationsEndpoints(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()

	tokens := seedIdentityFixtures(t, app)
	player1Token := tokens["player"]
	player2ID, player2Token := seedSecondPlayer(t, app)

	ts := newTestServer(t, app)
	defer ts.Close()

	// Seed 2 notifications for Player 2
	var notif1ID, notif2ID string
	_ = app.RunInTransaction(func(txApp core.App) error {
		n1, _ := createNotification(txApp, player2ID, fixPlayerID, "dm", "Message 1", map[string]any{"text": "one"})
		n2, _ := createNotification(txApp, player2ID, fixPlayerID, "dm", "Message 2", map[string]any{"text": "two"})
		notif1ID = n1.Id
		notif2ID = n2.Id
		return nil
	})

	// 1. Player 2 lists notifications: gets 2
	{
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/notifications", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(res.Body).Decode(&p)
		res.Body.Close()
		if len(p.Items) != 2 {
			t.Fatalf("expected 2 notifications, got %d", len(p.Items))
		}
	}

	// 2. Ownership check: Player 1 tries to mark Player 2's notification read -> 403 Forbidden
	{
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/notifications/"+notif1ID+"/read", nil)
		req.Header.Set("Authorization", player1Token)
		res, _ := http.DefaultClient.Do(req)
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("expected 403 Forbidden for non-owner, got %d", res.StatusCode)
		}
		res.Body.Close()
	}

	// 3. Player 2 marks notif1 as read -> 200 OK
	{
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/notifications/"+notif1ID+"/read", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// unread=true filter now returns only 1 notification (notif2)
		reqUnread, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/notifications?unread=true", nil)
		reqUnread.Header.Set("Authorization", player2Token)
		resUnread, _ := http.DefaultClient.Do(reqUnread)
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resUnread.Body).Decode(&p)
		resUnread.Body.Close()
		if len(p.Items) != 1 || p.Items[0]["id"] != notif2ID {
			t.Fatalf("expected only notif2 in unread filter, got %v", p.Items)
		}
	}

	// 4. Player 2 marks all as read: POST /api/aerun/me/notifications/read-all
	{
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/aerun/me/notifications/read-all", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// unread=true filter now returns 0
		reqUnread, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/notifications?unread=true", nil)
		reqUnread.Header.Set("Authorization", player2Token)
		resUnread, _ := http.DefaultClient.Do(reqUnread)
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resUnread.Body).Decode(&p)
		resUnread.Body.Close()
		if len(p.Items) != 0 {
			t.Fatalf("expected 0 unread notifications after read-all, got %d", len(p.Items))
		}
	}

	// 5. Player 2 archives notif2: PATCH /api/aerun/me/notifications/{id}/archive
	{
		req, _ := http.NewRequest(http.MethodPatch, ts.URL+"/api/aerun/me/notifications/"+notif2ID+"/archive", nil)
		req.Header.Set("Authorization", player2Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", res.StatusCode)
		}
		res.Body.Close()

		// Default listing returns 1 (notif1 only, notif2 is archived)
		reqList, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/notifications", nil)
		reqList.Header.Set("Authorization", player2Token)
		resList, _ := http.DefaultClient.Do(reqList)
		var p struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resList.Body).Decode(&p)
		resList.Body.Close()
		if len(p.Items) != 1 || p.Items[0]["id"] != notif1ID {
			t.Fatalf("expected only notif1 in active list, got %v", p.Items)
		}

		// Listing with archived=true returns both
		reqAll, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/aerun/me/notifications?archived=true", nil)
		reqAll.Header.Set("Authorization", player2Token)
		resAll, _ := http.DefaultClient.Do(reqAll)
		var pAll struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.NewDecoder(resAll.Body).Decode(&pAll)
		resAll.Body.Close()
		if len(pAll.Items) != 2 {
			t.Fatalf("expected 2 items when archived=true, got %d", len(pAll.Items))
		}
	}
}
