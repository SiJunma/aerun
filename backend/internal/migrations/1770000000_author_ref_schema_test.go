package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestAuthorRefSchemaBackfillsKnownAuthorsWithoutInventingGuests(t *testing.T) {
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
	for _, field := range []string{authorKindField, guestDisplayNameField} {
		if posts.Fields.GetByName(field) == nil {
			t.Fatalf("posts.%s must exist after migration", field)
		}
	}

	account := core.NewRecord(posts)
	account.Set("topic_id", "topic-account")
	account.Set("author_id", "account-id")
	account.Set("content", "account post")
	if err := app.Save(account); err != nil {
		t.Fatal(err)
	}
	guest := core.NewRecord(posts)
	guest.Set("topic_id", "topic-guest")
	guest.Set("guest_nickname", "  Guest name  ")
	guest.Set("content", "guest post")
	if err := app.Save(guest); err != nil {
		t.Fatal(err)
	}
	unknown := core.NewRecord(posts)
	unknown.Set("topic_id", "topic-unknown")
	unknown.Set("content", "legacy unknown post")
	if err := app.Save(unknown); err != nil {
		t.Fatal(err)
	}

	if err := backfillAuthorRefs(app); err != nil {
		t.Fatal(err)
	}
	account, err = app.FindRecordById(postsCollectionTable, account.Id)
	if err != nil {
		t.Fatalf("reload account row: %v", err)
	}
	guest, err = app.FindRecordById(postsCollectionTable, guest.Id)
	if err != nil {
		t.Fatalf("reload guest row: %v", err)
	}
	unknown, err = app.FindRecordById(postsCollectionTable, unknown.Id)
	if err != nil {
		t.Fatalf("reload unknown row: %v", err)
	}
	if got := account.GetString(authorKindField); got != authorKindAccount {
		t.Errorf("account author_kind = %q, want %q", got, authorKindAccount)
	}
	if got := guest.GetString(authorKindField); got != authorKindGuest {
		t.Errorf("guest author_kind = %q, want %q", got, authorKindGuest)
	}
	if got := guest.GetString(guestDisplayNameField); got != "Guest name" {
		t.Errorf("guest display name = %q, want normalized name", got)
	}
	if got := unknown.GetString(authorKindField); got != "" {
		t.Errorf("unknown author_kind = %q, want empty/unclassified", got)
	}
}
