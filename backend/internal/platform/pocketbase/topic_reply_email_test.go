package pocketbase

// topic_reply_email_test.go pins the email half of the topic-reply
// contract — the Firebase behaviour from functions/index.js
// (handlePostNotifications) that this backend must reproduce:
//
//   - the first unread reply in a subscribed topic queues exactly one email;
//   - further unread replies queue none (the in-app feed still grows);
//   - reading the feed re-opens the gate for the next wave;
//   - the toggle settings.email_notifications.topic_replies gates both
//     enqueue time and dispatch time;
//   - the body is the shared wrapper from loadEmailTemplates with every
//     per-send value escaped, never raw markup.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

// subscribeToTopicForTest records a topic_subscriptions row the way the
// subscribe endpoint would.
func subscribeToTopicForTest(t testing.TB, app *tests.TestApp, topicID, userID string) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(topicSubscriptionsCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(col)
	rec.Set("topic_id", topicID)
	rec.Set("user_id", userID)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
}

// setTopicReplyEmailPref writes the same settings shape the profile page
// saves for the topic-reply email toggle.
func setTopicReplyEmailPref(t testing.TB, app *tests.TestApp, userID string, enabled bool) {
	t.Helper()
	rec, err := app.FindRecordById(usersCollectionName, userID)
	if err != nil || rec == nil {
		t.Fatalf("user missing: %v", err)
	}
	raw, _ := json.Marshal(map[string]any{"email_notifications": map[string]any{"topic_replies": enabled}})
	rec.Set("settings", string(raw))
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to set topic reply pref: %v", err)
	}
}

// outboxRecordByKey finds the outbox row for dedupeKey, or fails the test.
func outboxRecordByKey(t testing.TB, app *tests.TestApp, dedupeKey string) *core.Record {
	t.Helper()
	rec, err := app.FindFirstRecordByFilter(outboxEventsCollectionName, "dedupe_key = {:k}", map[string]any{"k": dedupeKey})
	if err != nil || rec == nil {
		t.Fatalf("outbox row %q missing: %v", dedupeKey, err)
	}
	return rec
}

// decodeOutboxPayload reads the payload column the way the worker does.
func decodeOutboxPayload(t testing.TB, rec *core.Record) map[string]any {
	t.Helper()
	var payload map[string]any
	switch raw := rec.Get("payload").(type) {
	case types.JSONRaw:
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			t.Fatalf("payload is not JSON: %v", err)
		}
	case string:
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			t.Fatalf("payload is not JSON: %v", err)
		}
	default:
		data, _ := json.Marshal(raw)
		_ = json.Unmarshal(data, &payload)
	}
	return payload
}

// dispatchReply writes a reply into topicID and runs the dispatcher inside a
// transaction, exactly like the create-post command does.
func dispatchReply(t testing.TB, app *tests.TestApp, topicID, authorID, content string) *core.Record {
	t.Helper()
	reply := postInTopic(t, app, topicID, authorID, content)
	if err := app.RunInTransaction(func(txApp core.App) error {
		dispatchPostNotifications(txApp, authorID, reply, "Тема")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestTopicReplyEmailQueuedForFirstUnreadReply(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	_, topicID := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")
	subscribeToTopicForTest(t, app, topicID, fixBannedID)

	reply := dispatchReply(t, app, topicID, fixModeratorID,
		`[i]важный[/i] ответ <script>alert(1)</script> со сноской`)

	key := messaging.MakeTopicReplyDedupeKey(reply.Id, fixBannedID)
	if n := countOutboxByKey(t, app, key); n != 1 {
		t.Fatalf("the first unread reply must queue exactly 1 email, got %d", n)
	}

	rec := outboxRecordByKey(t, app, key)
	if got := rec.GetString("event_type"); got != "email:topic_reply" {
		t.Fatalf("event_type = %q, want email:topic_reply", got)
	}
	payload := decodeOutboxPayload(t, rec)

	if payload["to_email"] != "banned@example.com" {
		t.Errorf("to_email = %v, want banned@example.com", payload["to_email"])
	}
	if payload["subject"] != "New reply in: Тема" {
		t.Errorf("subject = %v, want %q", payload["subject"], "New reply in: Тема")
	}

	html, _ := payload["body_html"].(string)
	if html == "" {
		t.Fatal("the queued email must carry the HTML wrapper")
	}
	for _, marker := range []string{
		".top-accent",                             // the wrapEmailTemplate design
		"New Reply in Subscribed Topic",           // renderTopicReplyEmail's heading
		"важный ответ",                            // snippet, BBCode stripped
		"/topic/" + topicID + "?post=" + reply.Id, // the deep link
	} {
		if !strings.Contains(html, marker) {
			t.Errorf("body_html must contain %q, got:\n%s", marker, html)
		}
	}
	// Markup is stripped or escaped, never delivered raw.
	if strings.Contains(html, "[i]") || strings.Contains(html, "<script>") {
		t.Errorf("raw markup leaked into the body:\n%s", html)
	}
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Errorf("the snippet must be HTML-escaped, got:\n%s", html)
	}
	// Every placeholder is consumed — nothing reaches the member as {BRACES}.
	for _, ph := range []string{phTitle, phAppName, phRecipientName, phSenderName, phSnippet, phTopicTitle, phTopicURL} {
		if strings.Contains(html, ph) {
			t.Errorf("placeholder %s survived into the body", ph)
		}
	}
	if strings.Contains(payload["subject"].(string), phTopicTitle) {
		t.Errorf("placeholder %s survived into the subject", phTopicTitle)
	}

	// The plain-text alternative carries the same information.
	text, _ := payload["body_text"].(string)
	if !strings.Contains(text, "важный ответ") || !strings.Contains(text, "View the discussion: ") {
		t.Errorf("body_text is missing the snippet or the link:\n%s", text)
	}
}

// TestTopicReplyEmailOnlyForTheFirstUnreadReply pins the coalescing rule:
// while unread replies sit in the feed, further replies add in-app
// notifications but no email — and reading the feed re-opens the gate, so
// the next wave mails again (Firebase parity).
func TestTopicReplyEmailOnlyForTheFirstUnreadReply(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	_, topicID := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")
	subscribeToTopicForTest(t, app, topicID, fixBannedID)

	dispatchReply(t, app, topicID, fixModeratorID, "ответ первый")
	dispatchReply(t, app, topicID, fixModeratorID, "ответ второй")

	if n := countOutboxByKey(t, app, ""); n != 1 {
		t.Fatalf("consecutive unread replies must queue ONE email, got %d", n)
	}
	if n := notificationCount(t, app, fixBannedID); n != 2 {
		t.Fatalf("the in-app feed must still grow per reply, got %d notifications", n)
	}

	// The subscriber reads the feed: both notifications become read.
	rows, err := app.FindAllRecords(notificationsCollectionName, dbx.HashExp{"recipient_id": fixBannedID})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		row.Set("read", true)
		if err := app.Save(row); err != nil {
			t.Fatal(err)
		}
	}

	// The next reply starts a NEW unread wave and must mail again — the
	// per-post dedupe key never blocks it.
	dispatchReply(t, app, topicID, fixModeratorID, "ответ третий")
	if n := countOutboxByKey(t, app, ""); n != 2 {
		t.Fatalf("after the feed was read the next first-unread reply must queue again, got %d rows", n)
	}
}

// TestTopicReplyEmailSkippedWhenDisabled asserts the profile toggle only
// gates the mail: the in-app notification must be created regardless.
func TestTopicReplyEmailSkippedWhenDisabled(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	_, topicID := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")
	subscribeToTopicForTest(t, app, topicID, fixBannedID)
	setTopicReplyEmailPref(t, app, fixBannedID, false)

	dispatchReply(t, app, topicID, fixModeratorID, "ответ")

	if n := countOutboxByKey(t, app, ""); n != 0 {
		t.Fatalf("a member with topic reply mail off must queue no email, got %d", n)
	}
	if n := notificationCount(t, app, fixBannedID); n != 1 {
		t.Fatalf("the mail toggle must not silence the in-app feed, got %d notifications", n)
	}
}

// TestTopicReplyEmailSkippedAtDispatchWhenDisabledAfterEnqueue is the
// dispatch-time re-check: the event was queued while the toggle was on, the
// member switched it off, and the worker must retire the event without
// sending.
func TestTopicReplyEmailSkippedAtDispatchWhenDisabledAfterEnqueue(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	_, topicID := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")
	subscribeToTopicForTest(t, app, topicID, fixBannedID)

	reply := dispatchReply(t, app, topicID, fixModeratorID, "ответ")
	key := messaging.MakeTopicReplyDedupeKey(reply.Id, fixBannedID)
	if n := countOutboxByKey(t, app, key); n != 1 {
		t.Fatalf("expected the email to be queued, got %d rows", n)
	}

	setTopicReplyEmailPref(t, app, fixBannedID, false)

	sender := &mockMailSender{}
	processed, err := NewOutboxWorker().ProcessBatch(context.Background(), app, sender, 10)
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 {
		t.Fatalf("the skipped event must still count as processed, got %d", processed)
	}
	if sender.calls != 0 {
		t.Fatalf("the worker must not send after the toggle went off, made %d calls", sender.calls)
	}
	rec := outboxRecordByKey(t, app, key)
	if rec.GetString("status") != "sent" {
		t.Errorf("a skipped event must be retired as sent, got %q", rec.GetString("status"))
	}
	if !strings.Contains(rec.GetString("last_error"), "skipped: topic reply mail disabled") {
		t.Errorf("last_error must record the skip reason, got %q", rec.GetString("last_error"))
	}
}

// TestOutboxWorkerDeliversBodyHTMLToSender pins the plumbing the template
// delivery stands on: whatever BodyHTML the enqueue path rendered reaches
// the sender untouched (the sender then hands it to PocketBase's mailer as
// the HTML alternative).
func TestOutboxWorkerDeliversBodyHTMLToSender(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	const bodyHTML = `<div class="top-accent"><p>hello</p></div>`
	if err := app.RunInTransaction(func(txApp core.App) error {
		return enqueueOutboxEvent(txApp, "test:html-1", "email:topic_reply", MailPayload{
			RecipientID: fixBannedID,
			ToEmail:     "banned@example.com",
			Subject:     "HTML delivery",
			BodyText:    "plain",
			BodyHTML:    bodyHTML,
		})
	}); err != nil {
		t.Fatal(err)
	}

	sender := &mockMailSender{}
	processed, err := NewOutboxWorker().ProcessBatch(context.Background(), app, sender, 10)
	if err != nil {
		t.Fatal(err)
	}
	if processed != 1 || sender.calls != 1 {
		t.Fatalf("expected 1 processed event and 1 send, got %d and %d", processed, sender.calls)
	}
	got := sender.sentPayloads[0]
	if got.BodyHTML != bodyHTML {
		t.Errorf("BodyHTML must reach the sender untouched, got %q", got.BodyHTML)
	}
	if got.BodyText != "plain" || got.Subject != "HTML delivery" {
		t.Errorf("the rest of the payload must ride along, got %+v", got)
	}
}

// TestEmailSnippets pins the preview rules against their Firebase sources:
// topic replies strip BBCode and cap at 200 runes, DMs quote the raw text
// capped at 150.
func TestEmailSnippets(t *testing.T) {
	if got := postEmailSnippet(`[i]раз[/i] два [quote="#p1,t1,A"]два[/quote]`); got != "раз два два" {
		t.Errorf("postEmailSnippet = %q, want %q", got, "раз два два")
	}
	if got := postEmailSnippet("[roll]\n[/roll]"); got != "New post submitted." {
		t.Errorf("an empty stripped snippet must fall back, got %q", got)
	}
	long := strings.Repeat("я", postSnippetRunes+10)
	if got := postEmailSnippet(long); len([]rune(got)) != postSnippetRunes {
		t.Errorf("postEmailSnippet must cap at %d runes, got %d", postSnippetRunes, len([]rune(got)))
	}
	if got := dmEmailSnippet("[b]как есть[/b]"); got != "[b]как есть[/b]" {
		t.Errorf("the DM snippet must quote the text as written, got %q", got)
	}
	if got := dmEmailSnippet("  "); got != "..." {
		t.Errorf("an empty DM must fall back to %q, got %q", "...", got)
	}
}
