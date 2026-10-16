package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestLastPostAuthorRefBackfillInheritsPostVariant(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil {
		t.Fatal(err)
	}
	topics, err := app.FindCollectionByNameOrId(topicsCollectionTable)
	if err != nil {
		t.Fatal(err)
	}

	accountPost := core.NewRecord(posts)
	accountPost.Set("topic_id", "topic-account")
	accountPost.Set("author_id", "account-id")
	accountPost.Set(authorKindField, authorKindAccount)
	accountPost.Set("content", "account post")
	if err := app.Save(accountPost); err != nil {
		t.Fatal(err)
	}
	guestPost := core.NewRecord(posts)
	guestPost.Set("topic_id", "topic-guest")
	guestPost.Set(authorKindField, authorKindGuest)
	guestPost.Set(guestDisplayNameField, "Guest name")
	guestPost.Set("guest_nickname", "Guest name")
	guestPost.Set("content", "guest post")
	if err := app.Save(guestPost); err != nil {
		t.Fatal(err)
	}

	newTopic := func(id, lastPostID, authorID, guestNickname string) *core.Record {
		topic := core.NewRecord(topics)
		topic.Set("category_id", "cat")
		topic.Set("title", id)
		topic.Set("last_post_id", lastPostID)
		topic.Set("last_post_author_id", authorID)
		topic.Set("last_post_guest_nickname", guestNickname)
		topic.Set(lastPostAuthorKindField, "")
		if err := app.Save(topic); err != nil {
			t.Fatal(err)
		}
		return topic
	}
	accountTopic := newTopic("topic-account", accountPost.Id, "account-id", "")
	guestTopic := newTopic("topic-guest", guestPost.Id, "", "Guest name")
	legacyGuestTopic := newTopic("topic-legacy-guest", "missing-post", "", "Legacy Guest")
	legacyAccountTopic := newTopic("topic-legacy-account", "missing-post", "legacy-account", "")
	unknownTopic := newTopic("topic-unknown", "missing-post", "", "")

	if err := backfillLastPostAuthorRefs(app); err != nil {
		t.Fatal(err)
	}
	reload := func(id string) *core.Record {
		record, err := app.FindRecordById(topicsCollectionTable, id)
		if err != nil {
			t.Fatalf("reload topic %s: %v", id, err)
		}
		return record
	}
	accountTopic = reload(accountTopic.Id)
	guestTopic = reload(guestTopic.Id)
	legacyGuestTopic = reload(legacyGuestTopic.Id)
	legacyAccountTopic = reload(legacyAccountTopic.Id)
	unknownTopic = reload(unknownTopic.Id)

	if got := accountTopic.GetString(lastPostAuthorKindField); got != authorKindAccount {
		t.Errorf("account last-post kind = %q, want %q", got, authorKindAccount)
	}
	if got := guestTopic.GetString(lastPostAuthorKindField); got != authorKindGuest {
		t.Errorf("guest last-post kind = %q, want %q", got, authorKindGuest)
	}
	if got := guestTopic.GetString(lastPostGuestDisplayNameField); got != "Guest name" {
		t.Errorf("guest last-post display name = %q, want normalized name", got)
	}
	if got := legacyGuestTopic.GetString(lastPostAuthorKindField); got != authorKindGuest {
		t.Errorf("legacy guest last-post kind = %q, want %q", got, authorKindGuest)
	}
	if got := legacyGuestTopic.GetString(lastPostGuestDisplayNameField); got != "Legacy Guest" {
		t.Errorf("legacy guest last-post display name = %q, want Legacy Guest", got)
	}
	if got := legacyAccountTopic.GetString(lastPostAuthorKindField); got != authorKindAccount {
		t.Errorf("legacy account last-post kind = %q, want %q", got, authorKindAccount)
	}
	if got := unknownTopic.GetString(lastPostAuthorKindField); got != "" {
		t.Errorf("unknown last-post kind = %q, want empty/unclassified", got)
	}
}
