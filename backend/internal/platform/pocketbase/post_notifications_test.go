package pocketbase

// post_notifications_test.go pins the notification rules, which are a product
// contract copied from the legacy Cloud Function (functions/index.js,
// handlePostNotifications) rather than a design of ours:
//
//	QUOTE   [quote="#pPOSTID,tAUTHORID,Nick"]  → the POST's real author
//	MENTION [b]Name[/b]                        → nickname, else character owner
//	REPLY   every subscriber of the topic
//
// The security property is asserted first: the author id embedded in a quote is
// IGNORED. A client could otherwise quote a post and name somebody else in the
// markup to aim the notification at them, which is why the legacy read the
// author back from the quoted POST — and why that must not be "simplified"
// later into trusting the attribute.

import (
	"testing"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func TestQuoteRegexTakesOnlyThePostID(t *testing.T) {
	// Exactly the markup the legacy Firestore data contains, verbatim.
	ids := quotePostIDs(`[quote="#pNUh6PuCdLvtaNCnG5H2m,tNjyrN2ofUwEUuD5HDljX,Shimadzu"]` + "\nтекст\n[/quote]")
	if len(ids) != 1 || ids[0] != "NUh6PuCdLvtaNCnG5H2m" {
		t.Fatalf("quotePostIDs = %v, want [NUh6PuCdLvtaNCnG5H2m]", ids)
	}
	// The embedded author id must never be usable as a recipient.
	for _, id := range ids {
		if id == "tNjyrN2ofUwEUuD5HDljX" {
			t.Fatal("the quote's embedded author id was treated as a post id")
		}
	}
}

func TestQuotePostIDsAreDeduplicatedInOrder(t *testing.T) {
	content := `[quote="#pAAA,t1,A"][/quote] текст [quote="#pBBB,t1,A"][/quote] [quote="#pAAA,t1,A"][/quote]`
	got := quotePostIDs(content)
	if len(got) != 2 || got[0] != "AAA" || got[1] != "BBB" {
		t.Fatalf("quotePostIDs = %v, want [AAA BBB]", got)
	}
}

func TestMentionRegexSkipsBoldThatWrapsMarkup(t *testing.T) {
	// The legacy guard is `[^[]+`: a bold span wrapping markup is NOT a name.
	names := mentionedNames(`[b]Alice[/b] привет [b]какой-то [i]текст[/i][/b] конец`)
	if len(names) != 1 || names[0] != "Alice" {
		t.Fatalf("mentionedNames = %v, want [Alice]", names)
	}
}

func TestMentionLookupUsesTheNormalisedNickname(t *testing.T) {
	// The legacy compared `nickname` for exact equality, so "[b]alice [/b]" or
	// "[b]ALICE[/b]" notified nobody. The normalised key is the one the
	// uniqueness index enforces, so bold text resolves as a reader reads it.
	for _, in := range []string{"  ALICE  ", "Alice", "alice"} {
		if got := auth.NormalizeNickname(in); got != "alice" {
			t.Errorf("NormalizeNickname(%q) = %q, want alice", in, got)
		}
	}
}

// seedNotificationPost creates a published post by authorID inside the topic
// seedDraftTopic just opened, and returns it with that topic's id.
func seedNotificationPost(t testing.TB, app *tests.TestApp, authorID, content string) (*core.Record, string) {
	t.Helper()
	topicID := seedDraftTopic(t, app, authorID, "Тема")

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}

	var out *core.Record
	if err := app.RunInTransaction(func(txApp core.App) error {
		post := core.NewRecord(postsCol)
		post.Set("topic_id", topicID)
		post.Set("author_id", authorID)
		post.Set("content", content)
		post.Set("is_draft", false)
		if err := txApp.Save(post); err != nil {
			return err
		}
		out = post
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out, topicID
}

func notificationCount(t testing.TB, app *tests.TestApp, recipientID string) int {
	t.Helper()
	n, err := app.CountRecords(notificationsCollectionName, dbx.HashExp{"recipient_id": recipientID})
	if err != nil {
		t.Fatal(err)
	}
	return int(n)
}

func TestQuoteNotifiesTheQuotedPostsAuthorAndNobodyElse(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	// fixPlayerID writes the post that will be quoted.
	quoted, _ := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")

	// fixModeratorID replies, quoting it. The markup NAMES fixRootID as the
	// author, the way a hand-edited or hostile client would.
	replyContent := `[quote="#p` + quoted.Id + `,t` + fixRootID + `,RootOne"]цитата[/quote] мой ответ`
	reply, _ := seedNotificationPost(t, app, fixModeratorID, replyContent)

	if err := app.RunInTransaction(func(txApp core.App) error {
		dispatchPostNotifications(txApp, fixModeratorID, reply, "Тема")
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if n := notificationCount(t, app, fixPlayerID); n != 1 {
		t.Errorf("the quoted post's real author received %d notifications, want 1", n)
	}
	if n := notificationCount(t, app, fixRootID); n != 0 {
		t.Errorf("the name embedded in the markup received %d notifications; only the post's real author may be notified", n)
	}
	if n := notificationCount(t, app, fixModeratorID); n != 0 {
		t.Errorf("the author received %d notifications about their own post, want 0", n)
	}
}

// postInTopic creates a published reply inside an EXISTING topic. The reply path
// needs this: seedNotificationPost opens a fresh topic each time, which would
// leave the subscription pointing at a topic nobody replied to.
func postInTopic(t testing.TB, app *tests.TestApp, topicID, authorID, content string) *core.Record {
	t.Helper()
	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		t.Fatal(err)
	}

	var out *core.Record
	if err := app.RunInTransaction(func(txApp core.App) error {
		post := core.NewRecord(postsCol)
		post.Set("topic_id", topicID)
		post.Set("author_id", authorID)
		post.Set("content", content)
		post.Set("is_draft", false)
		if err := txApp.Save(post); err != nil {
			return err
		}
		out = post
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

// The reply path is the most frequent notification of all, and the only one that
// did not have a test: a wrong collection name or field name here would make
// EVERY reply notification silently vanish while quotes and mentions kept
// working. It is pinned below so that failure cannot hide again.
func TestTopicSubscribersAreNotifiedOfAReply(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	_, topicID := seedNotificationPost(t, app, fixPlayerID, "оригинальный пост")

	subCol, err := app.FindCollectionByNameOrId(topicSubscriptionsCollectionName)
	if err != nil {
		t.Fatalf("topic_subscriptions collection missing: %v", err)
	}
	sub := core.NewRecord(subCol)
	sub.Set("topic_id", topicID)
	sub.Set("user_id", fixBannedID)
	if err := app.Save(sub); err != nil {
		t.Fatal(err)
	}

	// fixModeratorID replies to the SAME topic fixBannedID follows.
	reply := postInTopic(t, app, topicID, fixModeratorID, "мой ответ")

	if err := app.RunInTransaction(func(txApp core.App) error {
		dispatchPostNotifications(txApp, fixModeratorID, reply, "Тема")
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if n := notificationCount(t, app, fixBannedID); n != 1 {
		t.Errorf("the subscriber received %d notifications for the reply, want 1", n)
	}
	if n := notificationCount(t, app, fixPlayerID); n != 0 {
		t.Errorf("a NON-subscriber received %d notifications, want 0", n)
	}
	if n := notificationCount(t, app, fixModeratorID); n != 0 {
		t.Errorf("the reply author received %d notifications about their own reply, want 0", n)
	}
}

func TestMentionResolvesThroughAMaskToItsOwner(t *testing.T) {
	app := newAerunTestApp(t)
	defer app.Cleanup()
	seedIdentityFixtures(t, app)

	// fixPlayerID posts under a mask. Bolding the MASK must reach its owner,
	// which is the entire point of having masks.
	seedRuntimeCharacter(t, app, "charmask0000001", fixPlayerID, "Shimadzu")

	// Lowercased in the bold text: the legacy's exact `nickname` match on a
	// CHARACTER name still applies, but this proves the nickname branch does not
	// steal the mention either.
	reply, _ := seedNotificationPost(t, app, fixModeratorID, `[b]Shimadzu[/b] твой ход`)

	if err := app.RunInTransaction(func(txApp core.App) error {
		dispatchPostNotifications(txApp, fixModeratorID, reply, "Тема")
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if n := notificationCount(t, app, fixPlayerID); n != 1 {
		t.Errorf("the mask's owner received %d notifications, want 1", n)
	}
	if n := notificationCount(t, app, fixModeratorID); n != 0 {
		t.Errorf("the mentioning author received %d notifications, want 0", n)
	}
}
