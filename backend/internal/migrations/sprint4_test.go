package migrations

import (
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func TestSprint4MigrationSchema(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to boot test app: %v", err)
	}
	defer app.Cleanup()

	// 1. Check reputation field on users and posts
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection missing: %v", err)
	}
	if users.Fields.GetByName("reputation") == nil {
		t.Fatal("expected reputation field on users collection")
	}

	posts, err := app.FindCollectionByNameOrId("posts")
	if err != nil {
		t.Fatalf("posts collection missing: %v", err)
	}
	if posts.Fields.GetByName("reputation") == nil {
		t.Fatal("expected reputation field on posts collection")
	}

	// 2. Check permissions field on categories
	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		t.Fatalf("categories collection missing: %v", err)
	}
	if categories.Fields.GetByName("permissions") == nil {
		t.Fatal("expected permissions field on categories collection")
	}

	// 3. Check reputation_votes collection
	repCol, err := app.FindCollectionByNameOrId(reputationVotesCollectionTable)
	if err != nil {
		t.Fatalf("reputation_votes collection missing: %v", err)
	}
	if repCol.ListRule != nil || repCol.CreateRule != nil {
		t.Fatal("reputation_votes browser access must be locked")
	}

	// 4. Check topic_subscriptions collection
	subCol, err := app.FindCollectionByNameOrId(topicSubscriptionsCollectionTable)
	if err != nil {
		t.Fatalf("topic_subscriptions collection missing: %v", err)
	}
	if subCol.ListRule != nil || subCol.CreateRule != nil {
		t.Fatal("topic_subscriptions browser access must be locked")
	}

	// 5. Check audit_logs collection
	auditCol, err := app.FindCollectionByNameOrId(auditLogsCollectionTable)
	if err != nil {
		t.Fatalf("audit_logs collection missing: %v", err)
	}
	if auditCol.ListRule != nil || auditCol.CreateRule != nil {
		t.Fatal("audit_logs browser access must be locked")
	}
}
