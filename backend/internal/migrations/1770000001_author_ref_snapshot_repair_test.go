package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestAuthorRefSnapshotRepairRestoresSnapshotColumns(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()
	if err := app.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}

	// Simulate a restore from a snapshot taken before migration 1769800000:
	// the tracker records the migration as applied, but the columns are gone.
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"guest_nickname", authorKindField, guestDisplayNameField} {
			collection.Fields.RemoveByName(field)
		}
		if collectionName == topicsCollectionTable {
			collection.Fields.RemoveByName("last_post_guest_nickname")
			collection.Fields.RemoveByName(lastPostAuthorKindField)
			collection.Fields.RemoveByName(lastPostGuestDisplayNameField)
			collection.RemoveIndex("idx_topics_last_post_author_kind")
		}
		collection.RemoveIndex("idx_" + collectionName + "_author_kind")
		if err := app.Save(collection); err != nil {
			t.Fatal(err)
		}
		if err := app.ReloadCachedCollections(); err != nil {
			t.Fatal(err)
		}
	}

	if err := applyAuthorRefSnapshotRepair(app); err != nil {
		t.Fatalf("operator snapshot repair must restore the columns: %v", err)
	}
	for _, collectionName := range []string{postsCollectionTable, topicsCollectionTable} {
		collection, err := app.FindCollectionByNameOrId(collectionName)
		if err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"guest_nickname", authorKindField, guestDisplayNameField} {
			if collection.Fields.GetByName(field) == nil {
				t.Fatalf("%s.%s must exist after the operator repair", collectionName, field)
			}
		}
	}
	topics, err := app.FindCollectionByNameOrId(topicsCollectionTable)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"last_post_guest_nickname", lastPostAuthorKindField, lastPostGuestDisplayNameField} {
		if topics.Fields.GetByName(field) == nil {
			t.Fatalf("topics.%s must exist after the operator repair", field)
		}
	}

	// Second run must be a no-op report: nothing left to restore.
	added, err := ensureAuthorRefSnapshotColumns(app)
	if err != nil {
		t.Fatal(err)
	}
	if added != 0 {
		t.Fatalf("second repair run must restore 0 columns, got %d", added)
	}

	// The repair must not invent guests: a row without account id or nickname
	// stays unclassified after the re-run backfill.
	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil {
		t.Fatal(err)
	}
	unknown := core.NewRecord(posts)
	unknown.Set("topic_id", "topic-unknown")
	unknown.Set("content", "legacy unknown post")
	if err := app.Save(unknown); err != nil {
		t.Fatal(err)
	}
	if err := applyAuthorRefSnapshotRepair(app); err != nil {
		t.Fatal(err)
	}
	unknown, err = app.FindRecordById(postsCollectionTable, unknown.Id)
	if err != nil {
		t.Fatalf("reload unknown row: %v", err)
	}
	if got := unknown.GetString(authorKindField); got != "" {
		t.Fatalf("unknown author_kind = %q, want empty/unclassified", got)
	}
}
