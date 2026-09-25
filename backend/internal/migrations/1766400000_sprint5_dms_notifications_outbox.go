package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766400000_sprint5_dms_notifications_outbox.go creates the Sprint 5 schema:
//
//   - `dm_conversations` — header metadata for direct message threads.
//   - `dm_members` — tracks participants, their per-conversation read sequence
//     and cleared_at horizon. UNIQUE(conversation_id, user_id).
//   - `dm_messages` — sequenced messages in conversations. UNIQUE(conversation_id, sequence).
//   - `notifications` — persistent in-app notifications for users.
//   - `outbox_events` — transactional email/event outbox with deduplication keys.
//     UNIQUE(dedupe_key).
//
// Direct browser mutation for all five collections is locked (superuser-only).
const (
	dmConversationsCollectionTable = "dm_conversations"
	dmMembersCollectionTable       = "dm_members"
	dmMessagesCollectionTable      = "dm_messages"
	notificationsCollectionTable   = "notifications"
	outboxEventsCollectionTable    = "outbox_events"
)

func init() {
	m.Register(func(app core.App) error {
		if err := createDMConversations(app); err != nil {
			return fmt.Errorf("dm_conversations: %w", err)
		}
		if err := createDMMembers(app); err != nil {
			return fmt.Errorf("dm_members: %w", err)
		}
		if err := createDMMessages(app); err != nil {
			return fmt.Errorf("dm_messages: %w", err)
		}
		if err := createNotifications(app); err != nil {
			return fmt.Errorf("notifications: %w", err)
		}
		if err := createOutboxEvents(app); err != nil {
			return fmt.Errorf("outbox_events: %w", err)
		}
		return nil
	}, func(app core.App) error {
		for _, name := range []string{
			outboxEventsCollectionTable,
			notificationsCollectionTable,
			dmMessagesCollectionTable,
			dmMembersCollectionTable,
			dmConversationsCollectionTable,
		} {
			col, err := app.FindCollectionByNameOrId(name)
			if err == nil && col != nil {
				if err := app.Delete(col); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func createDMConversations(app core.App) error {
	col := core.NewBaseCollection(dmConversationsCollectionTable)
	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "title", Max: 256},
		&core.TextField{Name: "last_message", Max: 1024},
		&core.TextField{Name: "last_message_at", Max: 64},
		&core.NumberField{Name: "messages_count", OnlyInt: true},
	)
	lockBrowserRules(col)
	return app.Save(col)
}

func createDMMembers(app core.App) error {
	col := core.NewBaseCollection(dmMembersCollectionTable)
	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "conversation_id", Required: true, Max: 15},
		&core.TextField{Name: "user_id", Required: true, Max: 15},
		&core.NumberField{Name: "last_read_sequence", OnlyInt: true},
		&core.TextField{Name: "cleared_at", Max: 64},
	)
	lockBrowserRules(col)
	col.AddIndex("idx_dm_members_conv_user", true, "conversation_id, user_id", "")
	col.AddIndex("idx_dm_members_user_updated", false, "user_id, updated", "")
	return app.Save(col)
}

func createDMMessages(app core.App) error {
	col := core.NewBaseCollection(dmMessagesCollectionTable)
	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "conversation_id", Required: true, Max: 15},
		&core.TextField{Name: "sender_id", Required: true, Max: 15},
		&core.NumberField{Name: "sequence", Required: true, OnlyInt: true},
		&core.TextField{Name: "text", Required: true, Max: 65536},
	)
	lockBrowserRules(col)
	col.AddIndex("idx_dm_messages_conv_seq", true, "conversation_id, sequence", "")
	col.AddIndex("idx_dm_messages_conv_seq_id", false, "conversation_id, sequence, id", "")
	return app.Save(col)
}

func createNotifications(app core.App) error {
	col := core.NewBaseCollection(notificationsCollectionTable)
	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "recipient_id", Required: true, Max: 15},
		&core.TextField{Name: "sender_id", Max: 15},
		&core.TextField{Name: "type", Required: true, Max: 64},
		&core.TextField{Name: "title", Max: 256},
		&core.JSONField{Name: "payload", MaxSize: 65536},
		&core.BoolField{Name: "read"},
		&core.BoolField{Name: "archived"},
	)
	lockBrowserRules(col)
	col.AddIndex("idx_notif_recipient_lookup", false, "recipient_id, read, created, id", "")
	return app.Save(col)
}

func createOutboxEvents(app core.App) error {
	col := core.NewBaseCollection(outboxEventsCollectionTable)
	col.Fields.Add(
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		&core.TextField{Name: "dedupe_key", Required: true, Max: 255},
		&core.TextField{Name: "event_type", Required: true, Max: 64},
		&core.JSONField{Name: "payload", MaxSize: 65536},
		&core.TextField{Name: "status", Required: true, Max: 32},
		&core.NumberField{Name: "attempts", OnlyInt: true},
		&core.NumberField{Name: "max_attempts", OnlyInt: true},
		&core.TextField{Name: "last_error", Max: 4096},
		&core.TextField{Name: "next_attempt_at", Max: 64},
		&core.TextField{Name: "sent_at", Max: 64},
	)
	lockBrowserRules(col)
	col.AddIndex("idx_outbox_dedupe_key", true, "dedupe_key", "")
	col.AddIndex("idx_outbox_status_next", false, "status, next_attempt_at", "")
	return app.Save(col)
}
