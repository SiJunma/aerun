package pocketbase

// Social import (Sprint 7 writers, levels L8 and L9): notifications, direct
// messages and audit logs.
//
// All three are user-facing history. Nothing here is a derived counter, so there
// is no "recompute later" fallback: a row that is not written is a private
// message or a notification that never arrives. Every handler therefore writes
// the full batch or refuses the whole batch — no partial import.
//
// Ordering inside the DM transaction is the load-bearing part:
//
//	conversations -> members -> messages
//
// dm_members.conversation_id and dm_messages.conversation_id are plain text
// columns with no foreign key, so nothing would technically stop the reverse
// order — but a conversation row carries messages_count and last_message, and
// those are computed from the rows this same call writes. Writing them first
// would mean computing a projection from rows that do not exist yet.
//
// dm_messages.sequence is Required (unlike posts, which allows 0 for drafts),
// so every message gets 1..n and the UNIQUE(conversation_id, sequence) index is
// checked for duplicates before the transaction opens.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// NotificationUpsert is the desired state of one notifications row.
type NotificationUpsert struct {
	TargetID    string
	RecipientID string
	SenderID    string
	Type        string
	Title       string
	// PayloadJSON is stored as JSON.
	PayloadJSON string
	Read        bool
	Archived    bool
	CreatedAt   string
}

// DMConversationUpsert is the desired state of one dm_conversations row.
type DMConversationUpsert struct {
	TargetID      string
	LastMessage   string
	LastMessageAt string
	MessagesCount int
	CreatedAt     string
}

// DMMemberUpsert is the desired state of one dm_members row.
type DMMemberUpsert struct {
	TargetID         string
	ConversationID   string
	UserID           string
	LastReadSequence int
	ClearedAt        string
}

// DMMessageUpsert is the desired state of one dm_messages row.
type DMMessageUpsert struct {
	TargetID       string
	ConversationID string
	SenderID       string
	Sequence       int
	Text           string
	CreatedAt      string
}

// AuditLogUpsert is the desired state of one audit_logs row.
type AuditLogUpsert struct {
	TargetID    string
	ActionType  string
	PerformerID string
	// DetailsJSON is stored as JSON, verbatim from the legacy document.
	DetailsJSON string
	CreatedAt   string
}

// SocialImportReport states what the import changed.
type SocialImportReport struct {
	NotificationsCreated []string
	ConversationsCreated []string
	MembersCreated       []string
	MessagesCreated      []string
	AuditCreated         []string
	ExtraNotificationIDs []string
	ExtraConversationIDs []string
	ExtraMemberIDs       []string
	ExtraMessageIDs      []string
	ExtraAuditIDs        []string
}

// Changed reports whether the import modified anything.
func (r SocialImportReport) Changed() bool {
	return len(r.NotificationsCreated) > 0 || len(r.ConversationsCreated) > 0 ||
		len(r.MembersCreated) > 0 || len(r.MessagesCreated) > 0 || len(r.AuditCreated) > 0
}

// ImportSocial writes notifications, direct messages and audit logs.
func ImportSocial(
	app core.App,
	notifications []NotificationUpsert,
	conversations []DMConversationUpsert,
	members []DMMemberUpsert,
	messages []DMMessageUpsert,
	audit []AuditLogUpsert,
) (SocialImportReport, error) {
	report := SocialImportReport{}
	if err := validateSocialUpserts(notifications, conversations, members, messages, audit); err != nil {
		return report, err
	}
	if len(notifications)+len(conversations)+len(members)+len(messages)+len(audit) == 0 {
		return report, nil
	}

	users, err := recordIDs(app, usersCollectionName)
	if err != nil {
		return report, fmt.Errorf("read users: %w", err)
	}

	if err := importNotifications(app, users, notifications, &report); err != nil {
		return SocialImportReport{}, err
	}
	if err := importConversations(app, conversations, &report); err != nil {
		return SocialImportReport{}, err
	}
	if err := importDMMembers(app, users, members, &report); err != nil {
		return SocialImportReport{}, err
	}
	if err := importDMMessages(app, users, messages, &report); err != nil {
		return SocialImportReport{}, err
	}
	if err := importAuditLogs(app, users, audit, &report); err != nil {
		return SocialImportReport{}, err
	}

	sort.Strings(report.NotificationsCreated)
	sort.Strings(report.ConversationsCreated)
	sort.Strings(report.MembersCreated)
	sort.Strings(report.MessagesCreated)
	sort.Strings(report.AuditCreated)
	for _, list := range [][]string{
		report.ExtraNotificationIDs, report.ExtraConversationIDs, report.ExtraMemberIDs,
		report.ExtraMessageIDs, report.ExtraAuditIDs,
	} {
		sort.Strings(list)
	}
	return report, nil
}

// importNotifications writes the notification rows.
func importNotifications(app core.App, users map[string]bool, upserts []NotificationUpsert, report *SocialImportReport) error {
	if len(upserts) == 0 {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(notificationsCollectionName)
	if err != nil {
		return fmt.Errorf("notifications collection unavailable: %w", err)
	}
	return app.RunInTransaction(func(txApp core.App) error {
		existing, err := indexRecords(txApp, notificationsCollectionName)
		if err != nil {
			return err
		}
		wanted := toSet(upserts, func(u NotificationUpsert) string { return u.TargetID })
		for _, u := range upserts {
			if !users[u.RecipientID] {
				return fmt.Errorf("notification %s: recipient %q has no users row", u.TargetID, u.RecipientID)
			}
			if u.Type == "" {
				return fmt.Errorf("notification %s: type is required", u.TargetID)
			}
			rec, ok := existing[u.TargetID]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", u.TargetID)
			}
			rec.Set("recipient_id", u.RecipientID)
			rec.Set("sender_id", u.SenderID)
			rec.Set("type", u.Type)
			rec.Set("title", u.Title)
			rec.Set("payload", jsonOrEmpty(u.PayloadJSON))
			rec.Set("read", u.Read)
			rec.Set("archived", u.Archived)
			setAutodateIfGiven(rec, "created", u.CreatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("write notification %s: %w", u.TargetID, err)
			}
			if !ok {
				report.NotificationsCreated = append(report.NotificationsCreated, u.TargetID)
			}
		}
		report.ExtraNotificationIDs = extraIDs(existing, wanted)
		return nil
	})
}

// importConversations writes the conversation headers.
func importConversations(app core.App, upserts []DMConversationUpsert, report *SocialImportReport) error {
	if len(upserts) == 0 {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(dmConversationsCollectionName)
	if err != nil {
		return fmt.Errorf("dm_conversations collection unavailable: %w", err)
	}
	return app.RunInTransaction(func(txApp core.App) error {
		existing, err := indexRecords(txApp, dmConversationsCollectionName)
		if err != nil {
			return err
		}
		wanted := toSet(upserts, func(u DMConversationUpsert) string { return u.TargetID })
		for _, u := range upserts {
			rec, ok := existing[u.TargetID]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", u.TargetID)
			}
			rec.Set("last_message", u.LastMessage)
			rec.Set("last_message_at", u.LastMessageAt)
			rec.Set("messages_count", u.MessagesCount)
			setAutodateIfGiven(rec, "created", u.CreatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("write conversation %s: %w", u.TargetID, err)
			}
			if !ok {
				report.ConversationsCreated = append(report.ConversationsCreated, u.TargetID)
			}
		}
		report.ExtraConversationIDs = extraIDs(existing, wanted)
		return nil
	})
}

// importDMMembers writes the per-participant membership rows.
func importDMMembers(app core.App, users map[string]bool, upserts []DMMemberUpsert, report *SocialImportReport) error {
	if len(upserts) == 0 {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(dmMembersCollectionName)
	if err != nil {
		return fmt.Errorf("dm_members collection unavailable: %w", err)
	}
	conversations, err := recordIDs(app, dmConversationsCollectionName)
	if err != nil {
		return fmt.Errorf("read dm_conversations: %w", err)
	}
	return app.RunInTransaction(func(txApp core.App) error {
		existing, err := indexRecords(txApp, dmMembersCollectionName)
		if err != nil {
			return err
		}
		wanted := toSet(upserts, func(u DMMemberUpsert) string { return u.TargetID })
		for _, u := range upserts {
			if !conversations[u.ConversationID] {
				return fmt.Errorf("dm_member %s: conversation %q has no row", u.TargetID, u.ConversationID)
			}
			if !users[u.UserID] {
				return fmt.Errorf("dm_member %s: user %q has no users row", u.TargetID, u.UserID)
			}
			rec, ok := existing[u.TargetID]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", u.TargetID)
			}
			rec.Set("conversation_id", u.ConversationID)
			rec.Set("user_id", u.UserID)
			rec.Set("last_read_sequence", u.LastReadSequence)
			rec.Set("cleared_at", u.ClearedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("write dm_member %s: %w", u.TargetID, err)
			}
			if !ok {
				report.MembersCreated = append(report.MembersCreated, u.TargetID)
			}
		}
		report.ExtraMemberIDs = extraIDs(existing, wanted)
		return nil
	})
}

// importDMMessages writes the sequenced messages.
func importDMMessages(app core.App, users map[string]bool, upserts []DMMessageUpsert, report *SocialImportReport) error {
	if len(upserts) == 0 {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(dmMessagesCollectionName)
	if err != nil {
		return fmt.Errorf("dm_messages collection unavailable: %w", err)
	}
	conversations, err := recordIDs(app, dmConversationsCollectionName)
	if err != nil {
		return fmt.Errorf("read dm_conversations: %w", err)
	}
	return app.RunInTransaction(func(txApp core.App) error {
		existing, err := indexRecords(txApp, dmMessagesCollectionName)
		if err != nil {
			return err
		}
		wanted := toSet(upserts, func(u DMMessageUpsert) string { return u.TargetID })
		for _, u := range upserts {
			if !conversations[u.ConversationID] {
				return fmt.Errorf("dm_message %s: conversation %q has no row", u.TargetID, u.ConversationID)
			}
			if !users[u.SenderID] {
				return fmt.Errorf("dm_message %s: sender %q has no users row", u.TargetID, u.SenderID)
			}
			rec, ok := existing[u.TargetID]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", u.TargetID)
			}
			rec.Set("conversation_id", u.ConversationID)
			rec.Set("sender_id", u.SenderID)
			rec.Set("sequence", u.Sequence)
			rec.Set("text", u.Text)
			setAutodateIfGiven(rec, "created", u.CreatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("write dm_message %s: %w", u.TargetID, err)
			}
			if !ok {
				report.MessagesCreated = append(report.MessagesCreated, u.TargetID)
			}
		}
		report.ExtraMessageIDs = extraIDs(existing, wanted)
		return nil
	})
}

// importAuditLogs appends the audit rows.
//
// audit_logs is append-only in the runtime and its collection rules are locked,
// so this is the only writer it will ever have. `details` is copied verbatim:
// see the planner header for why the free-form blob is not rewritten.
func importAuditLogs(app core.App, users map[string]bool, upserts []AuditLogUpsert, report *SocialImportReport) error {
	if len(upserts) == 0 {
		return nil
	}
	col, err := app.FindCollectionByNameOrId(auditLogsCollectionName)
	if err != nil {
		return fmt.Errorf("audit_logs collection unavailable: %w", err)
	}
	return app.RunInTransaction(func(txApp core.App) error {
		existing, err := indexRecords(txApp, auditLogsCollectionName)
		if err != nil {
			return err
		}
		wanted := toSet(upserts, func(u AuditLogUpsert) string { return u.TargetID })
		for _, u := range upserts {
			if !users[u.PerformerID] {
				return fmt.Errorf("audit_log %s: performer %q has no users row", u.TargetID, u.PerformerID)
			}
			if u.ActionType == "" {
				return fmt.Errorf("audit_log %s: action_type is required", u.TargetID)
			}
			rec, ok := existing[u.TargetID]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", u.TargetID)
			}
			rec.Set("action_type", u.ActionType)
			rec.Set("performer_id", u.PerformerID)
			rec.Set("details", jsonOrEmpty(u.DetailsJSON))
			setAutodateIfGiven(rec, "created", u.CreatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("write audit_log %s: %w", u.TargetID, err)
			}
			if !ok {
				report.AuditCreated = append(report.AuditCreated, u.TargetID)
			}
		}
		report.ExtraAuditIDs = extraIDs(existing, wanted)
		return nil
	})
}

// validateSocialUpserts rejects a batch that cannot be written cleanly, BEFORE
// any transaction opens.
//
// The load-bearing check is the duplicate (conversation_id, sequence): the target
// has UNIQUE on that pair and dm_messages.sequence is Required, so a collision
// would abort the whole batch mid-way. Checking here names the two messages.
func validateSocialUpserts(
	notifications []NotificationUpsert,
	conversations []DMConversationUpsert,
	members []DMMemberUpsert,
	messages []DMMessageUpsert,
	audit []AuditLogUpsert,
) error {
	notifIDs := map[string]bool{}
	for _, u := range notifications {
		if u.TargetID == "" || notifIDs[u.TargetID] {
			return fmt.Errorf("notification upsert with a missing or duplicate target id %q", u.TargetID)
		}
		notifIDs[u.TargetID] = true
		if u.RecipientID == "" {
			return fmt.Errorf("notification %s: recipient_id is required", u.TargetID)
		}
	}

	convIDs := map[string]bool{}
	for _, u := range conversations {
		if u.TargetID == "" || convIDs[u.TargetID] {
			return fmt.Errorf("dm_conversation upsert with a missing or duplicate target id %q", u.TargetID)
		}
		convIDs[u.TargetID] = true
	}

	memberPairs := map[string]string{}
	memberIDs := map[string]bool{}
	for _, u := range members {
		if u.TargetID == "" || memberIDs[u.TargetID] {
			return fmt.Errorf("dm_member upsert with a missing or duplicate target id %q", u.TargetID)
		}
		memberIDs[u.TargetID] = true
		if u.ConversationID == "" || u.UserID == "" {
			return fmt.Errorf("dm_member %s: conversation_id and user_id are required", u.TargetID)
		}
		// UNIQUE(conversation_id, user_id) in the target.
		key := u.ConversationID + "/" + u.UserID
		if other, taken := memberPairs[key]; taken {
			return fmt.Errorf("dm_members %s and %s both place user %s in conversation %s",
				other, u.TargetID, u.UserID, u.ConversationID)
		}
		memberPairs[key] = u.TargetID
	}

	messageIDs := map[string]bool{}
	// Keyed by BOTH conversation and sequence: the target index is
	// UNIQUE(conversation_id, sequence), so two conversations may legitimately
	// both hold a message numbered 1. Keying on the sequence alone would reject
	// the entire batch for something the schema allows.
	sequences := map[string]string{}
	for _, u := range messages {
		if u.TargetID == "" || messageIDs[u.TargetID] {
			return fmt.Errorf("dm_message upsert with a missing or duplicate target id %q", u.TargetID)
		}
		messageIDs[u.TargetID] = true
		if u.ConversationID == "" || u.SenderID == "" {
			return fmt.Errorf("dm_message %s: conversation_id and sender_id are required", u.TargetID)
		}
		// Unlike posts, a DM message cannot carry sequence 0: there are no drafts.
		if u.Sequence <= 0 {
			return fmt.Errorf("dm_message %s: sequence must be positive, got %d", u.TargetID, u.Sequence)
		}
		if strings.TrimSpace(u.Text) == "" {
			return fmt.Errorf("dm_message %s: text is required", u.TargetID)
		}
		key := u.ConversationID + "#" + fmt.Sprint(u.Sequence)
		if other, taken := sequences[key]; taken {
			return fmt.Errorf("dm_messages %s and %s both claim sequence %d in conversation %s",
				other, u.TargetID, u.Sequence, u.ConversationID)
		}
		sequences[key] = u.TargetID
	}

	auditIDs := map[string]bool{}
	for _, u := range audit {
		if u.TargetID == "" || auditIDs[u.TargetID] {
			return fmt.Errorf("audit_log upsert with a missing or duplicate target id %q", u.TargetID)
		}
		auditIDs[u.TargetID] = true
		if u.PerformerID == "" {
			return fmt.Errorf("audit_log %s: performer_id is required", u.TargetID)
		}
		if u.ActionType == "" {
			return fmt.Errorf("audit_log %s: action_type is required", u.TargetID)
		}
	}
	return nil
}

// indexRecords reads a collection into an id -> record map.
func indexRecords(app core.App, collection string) (map[string]*core.Record, error) {
	rows, err := app.FindAllRecords(collection, nil)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", collection, err)
	}
	out := make(map[string]*core.Record, len(rows))
	for _, rec := range rows {
		out[rec.Id] = rec
	}
	return out, nil
}

// toSet collects the target ids of a batch.
func toSet[T any](upserts []T, id func(T) string) map[string]bool {
	out := make(map[string]bool, len(upserts))
	for _, u := range upserts {
		out[id(u)] = true
	}
	return out
}

// extraIDs returns the ids present in the target but absent from the batch. They
// are reported, never deleted: deletion is a human-approved decision.
func extraIDs(existing map[string]*core.Record, wanted map[string]bool) []string {
	var extra []string
	for id := range existing {
		if !wanted[id] {
			extra = append(extra, id)
		}
	}
	sort.Strings(extra)
	return extra
}

// jsonOrEmpty normalises an optional JSON payload into something a JSONField
// always accepts. An empty string is not valid JSON, and storing it would fail
// validation on every row that legitimately has no payload.
func jsonOrEmpty(payload string) types.JSONRaw {
	if strings.TrimSpace(payload) == "" {
		return types.JSONRaw([]byte("{}"))
	}
	return types.JSONRaw([]byte(payload))
}

var _ = dbx.HashExp{}
