package migrations

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func TestPostsTopicCreatedIndexExists(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	if err := app.RunAllMigrations(); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	posts, err := app.FindCollectionByNameOrId(postsCollectionTable)
	if err != nil {
		t.Fatalf("find posts collection: %v", err)
	}

	indexStr := posts.Indexes.String()
	if !strings.Contains(indexStr, "idx_posts_topic_created") {
		t.Fatalf("expected idx_posts_topic_created on posts collection, got: %s", indexStr)
	}
}
