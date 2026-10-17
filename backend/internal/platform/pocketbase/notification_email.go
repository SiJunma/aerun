package pocketbase

// Topic-reply notification emails (2026-10-07).
//
// The in-app side of this contract lives in post_notifications.go; this file
// is the email side, reproduced from the legacy Cloud Function
// (functions/index.js, handlePostNotifications) because the behaviour — not
// the implementation — is what users signed up for when they subscribed:
//
//   - ONLY the first unread reply in a topic produces mail. While the
//     subscriber has an unread topic_reply notification for the topic,
//     further replies pile up silently; the next mail comes after they read
//     (Firebase's isFirstUnreadReply). The in-app feed still gets one
//     notification per reply — only the email is coalesced.
//   - Guard: settings.email_notifications.topic_replies !== false (default
//     true), the toggle the profile page writes.
//   - The author never mails themselves (handled by the caller's dedupe in
//     dispatchPostNotifications).
//
// Delivery is outbox-only, inside the post's own transaction, and the body
// resolves through loadEmailTemplates — the .clinerules rule that every SMTP
// mail shares the admin-editable wrapper. The dispatch worker re-checks the
// toggle before sending: up to a minute (or a retry backoff far longer)
// passes between enqueue and send.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const (
	// topicReplyUnreadScanLimit bounds the first-unread scan: only the most
	// recent notifications are inspected for an earlier unread reply. Past
	// this depth the subscriber is demonstrably not reading their feed, and
	// a missed match at worst costs one extra email — never a lost one.
	topicReplyUnreadScanLimit = 50
	// postSnippetRunes mirrors the Firebase substring(0, 200) of the stripped
	// post content.
	postSnippetRunes = 200
	// dmSnippetRunes mirrors the Firebase substring(0, 150) of the raw text.
	dmSnippetRunes = 150
)

// bbCodeTagRegex mirrors the JS /\[.*?\]/ strip used before the snippet was
// quoted into the mail: the shortest span from "[" to the next "]", which in
// Go spelling is \[[^\]]*\]. Quotes, rolls and other markup leave the
// highlight-box as plain readable text.
var bbCodeTagRegex = regexp.MustCompile(`\[[^\]]*\]`)

// truncateRunes cuts on RUNE boundaries: a UTF-8 byte cut (or the JS UTF-16
// one) can slice a Cyrillic letter in half, and a half-letter in an email is
// worse than a shorter preview.
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

// postEmailSnippet is the topic-reply preview: BBCode stripped, trimmed, up
// to postSnippetRunes. An empty result falls back to the Firebase default so
// the highlight-box never renders as a bare pair of quotation marks.
func postEmailSnippet(content string) string {
	snippet := strings.TrimSpace(bbCodeTagRegex.ReplaceAllString(content, ""))
	if snippet == "" {
		return "New post submitted."
	}
	return truncateRunes(snippet, postSnippetRunes)
}

// dmEmailSnippet is the DM preview: the first dmSnippetRunes of the raw text,
// no BBCode stripping — the Firebase DM path quoted the text as written.
func dmEmailSnippet(text string) string {
	if strings.TrimSpace(text) == "" {
		return "..."
	}
	return truncateRunes(text, dmSnippetRunes)
}

// topicReplyEmailEnabled mirrors the Firebase check
// `settings.email_notifications.topic_replies !== false` (default true).
func topicReplyEmailEnabled(user *core.Record) bool {
	return emailNotificationsPref(user, "topic_replies")
}

// hasUnreadTopicReply reports whether the recipient already has an unread
// topic_reply notification for this topic — the first-unread gate Firebase
// ran before every send. dispatchPostNotifications calls it BEFORE creating
// the current reply's notification, so the reply being dispatched never
// counts itself into its own gate.
func hasUnreadTopicReply(txApp core.App, recipientID, topicID string) bool {
	records := []*core.Record{}
	if err := txApp.RecordQuery(notificationsCollectionName).
		AndWhere(dbx.HashExp{
			"recipient_id": recipientID,
			"type":         "topic_reply",
			"read":         false,
		}).
		OrderBy("created DESC").
		Limit(topicReplyUnreadScanLimit).
		All(&records); err != nil {
		// A failed scan must not suppress the mail the way a "true" would;
		// it queues one, and the dedupe key keeps it singular.
		return false
	}
	for _, row := range records {
		payload, _ := notificationPayload(row)["payload"].(map[string]any)
		if payload != nil && payload["topic_id"] == topicID {
			return true
		}
	}
	return false
}

// topicEmailURL builds the deep link to the reply. The frontend route is
// /topic/:id and the post-anchor query param is `post` — the same shape
// NotificationsPage and TopicPage copy-link already use.
func topicEmailURL(app core.App, topicID, postID string) string {
	base := strings.TrimRight(app.Settings().Meta.AppURL, "/")
	return base + "/topic/" + topicID + "?post=" + postID
}

// maybeEnqueueTopicReplyEmail queues the topic-reply email for one subscriber
// — unless the subscriber turned topic-reply mail off or carries no address.
// It runs inside the post's transaction: the mail is a consequence of the
// reply, so a rollback must take the mail with it.
func maybeEnqueueTopicReplyEmail(txApp core.App, recipientID, authorID, topicID, topicTitle, postID, content string) {
	user, err := txApp.FindRecordById(usersCollectionName, recipientID)
	if err != nil || user == nil {
		return
	}
	if !topicReplyEmailEnabled(user) {
		return
	}
	toEmail := strings.TrimSpace(user.Email())
	if toEmail == "" {
		return
	}

	tpl, ok := loadEmailTemplates(txApp)[emailTemplateTopicReply]
	if !ok {
		// The resolver guarantees the built-in default, so this only ever
		// happens if the defaults themselves lose the key — better to skip
		// one mail than to send an empty one.
		return
	}

	title := notificationTitle(emailTemplateTopicReply, topicTitle)
	recipientNick := user.GetString("nickname")
	authorNick := authorNickname(txApp, authorID)
	if authorNick == "" && postID != "" {
		if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
			if name := post.GetString(guestDisplayNameField); name != "" {
				authorNick = name
			} else if name := post.GetString("guest_nickname"); name != "" {
				authorNick = name
			}
		}
	}
	snippet := postEmailSnippet(content)
	topicURL := topicEmailURL(txApp, topicID, postID)

	subject, bodyHTML := renderEmailFromTemplate(tpl, txApp.Settings().Meta.AppName, title, map[string]string{
		phRecipientName: recipientNick,
		phSenderName:    authorNick,
		phTopicTitle:    topicTitle,
		phSnippet:       snippet,
		phTopicURL:      topicURL,
	})

	dedupeKey := messaging.MakeTopicReplyDedupeKey(postID, recipientID)
	_ = enqueueOutboxEvent(txApp, dedupeKey, "email:topic_reply", MailPayload{
		RecipientID: recipientID,
		ToEmail:     toEmail,
		Subject:     subject,
		BodyText:    topicReplyEmailText(recipientNick, authorNick, topicTitle, snippet, topicURL),
		BodyHTML:    bodyHTML,
	})
}

// topicReplyEmailText is the plain-text alternative paired with the HTML
// body, with the same fallbacks as the template so a text-only mail client
// never shows empty gaps.
func topicReplyEmailText(recipientNick, authorNick, topicTitle, snippet, topicURL string) string {
	if recipientNick == "" {
		recipientNick = "Traveler"
	}
	if authorNick == "" {
		authorNick = "Someone"
	}
	if topicTitle == "" {
		topicTitle = "Discussion"
	}
	if snippet == "" {
		snippet = "New post submitted."
	}
	return fmt.Sprintf(
		"Hello %s,\n\n%s has posted a new reply in %q:\n\n%s\n\nView the discussion: %s",
		recipientNick, authorNick, topicTitle, snippet, topicURL,
	)
}

// topicReplyEmailSkipReason re-checks the subscriber's toggle at dispatch
// time, mirroring dmEmailSkipReason: the worker must not mail a member who
// switched topic replies off while the event sat in the queue.
func topicReplyEmailSkipReason(app core.App, rec *core.Record) string {
	var payload MailPayload
	raw := rec.Get("payload")
	if raw != nil {
		switch p := raw.(type) {
		case types.JSONRaw:
			_ = json.Unmarshal([]byte(p), &payload)
		case string:
			_ = json.Unmarshal([]byte(p), &payload)
		default:
			data, _ := json.Marshal(p)
			_ = json.Unmarshal(data, &payload)
		}
	}
	if payload.RecipientID == "" {
		return "unparseable topic_reply event"
	}

	user, err := app.FindRecordById(usersCollectionName, payload.RecipientID)
	if err != nil || user == nil {
		return "recipient gone"
	}
	if !topicReplyEmailEnabled(user) {
		return "topic reply mail disabled"
	}
	return ""
}
