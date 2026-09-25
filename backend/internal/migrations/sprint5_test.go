package migrations

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/tests"
)

func TestSprint5MigrationSchema(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to boot test app: %v", err)
	}
	defer app.Cleanup()

	collections := []string{
		dmConversationsCollectionTable,
		dmMembersCollectionTable,
		dmMessagesCollectionTable,
		notificationsCollectionTable,
		outboxEventsCollectionTable,
	}

	for _, name := range collections {
		col, err := app.FindCollectionByNameOrId(name)
		if err != nil || col == nil {
			t.Fatalf("collection %s is missing: %v", name, err)
		}
		if col.ListRule != nil || col.CreateRule != nil || col.UpdateRule != nil || col.DeleteRule != nil {
			t.Fatalf("collection %s rules must be locked (superuser-only)", name)
		}
	}

	// Verify unique indexes
	membersCol, _ := app.FindCollectionByNameOrId(dmMembersCollectionTable)
	if !strings.Contains(membersCol.Indexes.String(), "idx_dm_members_conv_user") {
		t.Fatalf("expected unique index idx_dm_members_conv_user on dm_members, got %s", membersCol.Indexes.String())
	}

	messagesCol, _ := app.FindCollectionByNameOrId(dmMessagesCollectionTable)
	if !strings.Contains(messagesCol.Indexes.String(), "idx_dm_messages_conv_seq") {
		t.Fatalf("expected unique index idx_dm_messages_conv_seq on dm_messages, got %s", messagesCol.Indexes.String())
	}

	outboxCol, _ := app.FindCollectionByNameOrId(outboxEventsCollectionTable)
	if !strings.Contains(outboxCol.Indexes.String(), "idx_outbox_dedupe_key") {
		t.Fatalf("expected unique index idx_outbox_dedupe_key on outbox_events, got %s", outboxCol.Indexes.String())
	}
}
