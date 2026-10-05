package pocketbase

// Post notifications (2026-10-02).
//
// THE RULE: a notification is a CONSEQUENCE of an action, written in the SAME
// transaction as the action. A client may never write one. The legacy client
// called a PocketBase SDK write on `notifications`, which is locked to the
// server — so those notifications failed silently while the UI reported
// success. Server-side creation is not a refactor here, it is the only shape
// that can work, and it is what the legacy Cloud Function did.
//
// The three kinds are reproduced from the legacy implementation
// (functions/index.js, handlePostNotifications), because the behaviour is a
// product contract, not an implementation detail:
//
//	QUOTE   `[quote="#pPOSTID,tAUTHORID,Nick"]` — the embedded author id is NOT
//	        trusted. Only the POST id is used and the author is read back from
//	        that post. Otherwise a client could quote a post and name somebody
//	        else as its author to aim the notification at them.
//	MENTION `[b]Name[/b]` — anything bold, as long as it contains no further
//	        `[`. Resolved against a member nickname first and a CHARACTER name
//	        second, because the forum lets people post under a mask. A mask
//	        resolves to its OWNER: mentioning the mask mentions the person.
//	REPLY   every subscriber of the topic except the author.
//
// The author is never notified about their own post, in all three.
//
// ONE DEVIATION, DELIBERATE. Mention lookup there matched `nickname` for EXACT
// string equality, so "[b]alice [/b]" notified nobody. Here it uses
// `nickname_normalized` — the key the uniqueness index enforces — so bold text
// resolves the way a reader reads it. Character names keep an exact match: a
// mask name is free text with no normalisation contract of its own.
//
// Dedupe is per (recipient, type, post), so one post can never produce two
// identical notifications for the same person.

import (
	"regexp"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// quoteRegex captures the POST id only. The author id and nickname are parsed
// so the pattern matches the legacy markup, but groups 2 and 3 are unused.
var quoteRegex = regexp.MustCompile(`\[quote="#p([a-zA-Z0-9_-]+),t([a-zA-Z0-9_-]+),([^\]]+)"\]`)

// mentionRegex matches bold text containing no further opening bracket. The
// `[^[]+` is the legacy's guard: a bold span wrapping markup is not a name.
var mentionRegex = regexp.MustCompile(`\[b\]([^[]+)\[\/b\]`)

// dispatchPostNotifications writes every notification a new post produces.
//
// It runs INSIDE the caller's transaction and never returns an error to abort
// the post: a notification that cannot be delivered must not cost somebody
// their reply.
func dispatchPostNotifications(txApp core.App, actorID string, post *core.Record, topicTitle string) {
	content := post.GetString("content")
	topicID := post.GetString("topic_id")

	seen := map[string]bool{}
	deliver := func(recipientID, notifType string) {
		if recipientID == "" || recipientID == actorID {
			return
		}
		key := recipientID + "|" + notifType
		if seen[key] {
			return
		}
		seen[key] = true

		payload := map[string]any{
			"topic_id":        topicID,
			"topic_title":     topicTitle,
			"post_id":         post.Id,
			"author_nickname": authorNickname(txApp, actorID),
		}
		_, _ = createNotification(txApp, recipientID, actorID, notifType, notificationTitle(notifType, topicTitle), payload)
	}

	// ── 1. Subscribers ──────────────────────────────────────────────────────
	for _, subscriber := range topicSubscribers(txApp, topicID) {
		deliver(subscriber, "topic_reply")
	}

	if content == "" {
		return
	}

	// ── 2. Quotes ───────────────────────────────────────────────────────────
	for _, quotedPostID := range quotePostIDs(content) {
		deliver(postAuthor(txApp, quotedPostID), "post_quoted")
	}

	// ── 3. Mentions ─────────────────────────────────────────────────────────
	for _, name := range mentionedNames(content) {
		deliver(resolveMention(txApp, name), "post_mentioned")
	}
}

// quotePostIDs returns the DISTINCT quoted post ids, in the order they appear.
func quotePostIDs(content string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range quoteRegex.FindAllStringSubmatch(content, -1) {
		if id := m[1]; id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// mentionedNames returns the DISTINCT bold spans that look like a name.
func mentionedNames(content string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range mentionRegex.FindAllStringSubmatch(content, -1) {
		name := strings.TrimSpace(m[1])
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// resolveMention maps a bold span to an account: a member nickname first, then
// a character's name, which resolves to that mask's OWNER.
//
// The character lookup is EXACT, not normalised: a mask name is free text the
// owner chose, and folding case or whitespace across different people's masks
// would notify the wrong person.
func resolveMention(txApp core.App, name string) string {
	if key := auth.NormalizeNickname(name); key != "" {
		if user, err := txApp.FindFirstRecordByFilter(
			usersCollectionName,
			"nickname_normalized = {:k}",
			dbx.Params{"k": key},
		); err == nil && user != nil {
			return user.Id
		}
	}
	if character, err := txApp.FindFirstRecordByFilter(
		charactersCollectionName,
		"name = {:n}",
		dbx.Params{"n": name},
	); err == nil && character != nil {
		return character.GetString("owner_id")
	}
	return ""
}

// postAuthor reads the author of a quoted post. The quote markup also embeds an
// author id and it is IGNORED: only the database knows who wrote a post now.
func postAuthor(txApp core.App, postID string) string {
	if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
		return post.GetString("author_id")
	}
	return ""
}

// topicSubscribers returns the user ids subscribed to a topic.
func topicSubscribers(txApp core.App, topicID string) []string {
	rows, err := txApp.FindAllRecords(
		topicSubscriptionsCollectionName,
		dbx.NewExp("topic_id = {:t}", dbx.Params{"t": topicID}),
	)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if id := row.GetString("user_id"); id != "" {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

func authorNickname(txApp core.App, userID string) string {
	if user, err := txApp.FindRecordById(usersCollectionName, userID); err == nil && user != nil {
		return user.GetString("nickname")
	}
	return ""
}

func notificationTitle(notifType, topicTitle string) string {
	if topicTitle == "" {
		topicTitle = "Topic"
	}
	switch notifType {
	case "post_quoted":
		return "Your post was quoted in: " + topicTitle
	case "post_mentioned":
		return "You were mentioned in: " + topicTitle
	default:
		return "New reply in: " + topicTitle
	}
}
