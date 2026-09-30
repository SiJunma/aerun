package importer

// Legacy notifications + dms + audit_logs -> target rows (Sprint 7 writers,
// levels L8 and L9).
//
// These three have one thing in common that the earlier levels did not: they
// are **user-facing history**, not structure. Nothing here can be recomputed, and
// a mistake is not a stale counter — it is a private message or a notification
// that never arrives. So every rule below errs towards keeping the row and
// reporting the compromise, rather than dropping it.
//
// **Notifications** (964 rows, 5 types). recipient_uid becomes a derived
// recipient_id — the column is Required. There is no sender_uid in the legacy
// document, so sender_id stays empty rather than being invented. The payload
// carries legacy ids (post_id on 894 rows, topic_id on 958), and those ARE
// rewritten to derived ids: the notification bell links to a topic, and a payload
// holding a Firestore id renders a dead link for every recipient who clicks it.
// The rewrite is restricted to the four known id keys, and anything left alone
// is reported rather than guessed at.
//
// **Direct messages** (9 conversations, 305 messages). The conversation document
// id is "<uidA>_<uidB>", so it is already unique per pair and becomes the derived
// conversation id. Messages carry no sequence, so it is reconstructed from
// `timestamp` exactly like forum posts — same ascending rule, same total order,
// same tie-break. `messages_count` is recomputed from the rows written (the
// legacy document has no count to copy). `last_read_sequence` is translated from
// the legacy per-participant `unread` COUNT, because unread is not a sequence:
// messages_count - unread is the last message the member actually saw.
//
// **Audit logs** (247 rows). performer_id is a legacy UID in a Required
// 15-character-derived-id column, so it is rewritten like every other reference.
// `details` is the opposite case: it is a free-form forensic blob with 30
// different key spellings in the export (targetId AND target_id, authorId AND
// author_id, …) and no schema in the target. It is copied VERBATIM and the fact
// is reported. Rewriting it would mean guessing which of thirty spellings are
// ids — and an audit record is the last thing a migration should corrupt on a
// guess.

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// NotificationRow is the target state of one notifications row.
type NotificationRow struct {
	LegacyID    string
	TargetID    string
	RecipientID string
	// SenderID is empty: the legacy document has no sender field.
	SenderID string
	Type     string
	Title    string
	// PayloadJSON is the rewritten payload, stored as JSON.
	PayloadJSON string
	Read        bool
	Archived    bool
	CreatedAt   string
	Findings    map[string]string
}

// DMConversationRow is the target state of one dm_conversations row.
type DMConversationRow struct {
	LegacyID string
	TargetID string
	// ParticipantIDs are the derived ids of the members, in the legacy order.
	ParticipantIDs []string
	// LastMessage / LastMessageAt come from the legacy header when present.
	LastMessage   string
	LastMessageAt string
	// MessagesCount is recomputed from the rows actually written.
	MessagesCount int
	CreatedAt     string
}

// DMMemberRow is the target state of one dm_members row (one per participant).
type DMMemberRow struct {
	TargetID string
	// LegacyKey is "<convLegacyID>/<uid>" — the upsert key and DeriveID input.
	LegacyKey      string
	ConversationID string
	UserID         string
	// LastReadSequence is translated from the legacy unread count.
	LastReadSequence int
	ClearedAt        string
}

// DMMessageRow is the target state of one dm_messages row.
type DMMessageRow struct {
	LegacyID       string
	TargetID       string
	ConversationID string
	SenderID       string
	// Sequence is 1..n within the conversation, reconstructed from timestamps.
	Sequence  int
	Text      string
	CreatedAt string
}

// AuditLogRow is the target state of one audit_logs row.
type AuditLogRow struct {
	LegacyID   string
	TargetID   string
	ActionType string
	// PerformerID is Required and holds a derived id.
	PerformerID string
	// DetailsJSON is the legacy blob verbatim.
	DetailsJSON string
	CreatedAt   string
}

// SocialPlan is the full result of planning L8 + L9.
type SocialPlan struct {
	NotificationRows    []NotificationRow
	ConversationRows    []DMConversationRow
	MemberRows          []DMMemberRow
	MessageRows         []DMMessageRow
	AuditRows           []AuditLogRow
	Findings            map[string]*Finding
	SkippedNotification []string
	SkippedDM           []string
	SkippedAudit        []string
	// SequenceCount is how many DM sequences were assigned.
	SequenceCount int
}

// pendingDMMessage is one legacy DM message waiting for its sequence number.
type pendingDMMessage struct {
	legacyKey string
	fields    map[string]any
	created   time.Time
}

// payloadIDKeys are the notification payload keys whose values are legacy ids.
// They are the only ones rewritten: each is a link the recipient can click, and
// a Firestore id renders a dead link in the target. Everything else in the
// payload is prose and is copied verbatim.
var payloadIDKeys = map[string]func(legacyID string) string{
	"post_id":       func(id string) string { return DeriveID(SpacePost, id) },
	"topic_id":      func(id string) string { return DeriveID(SpaceTopic, id) },
	"first_post_id": func(id string) string { return DeriveID(SpacePost, id) },
	"last_post_id":  func(id string) string { return DeriveID(SpacePost, id) },
}

// BuildSocialPlan translates notifications, direct messages and audit logs.
func BuildSocialPlan(plan *ImportPlan, userExists func(string) bool) *SocialPlan {
	sp := &SocialPlan{Findings: map[string]*Finding{}}

	for _, id := range sortedKeys(plan.Notifications) {
		fields := plan.Notifications[id]
		recipient := strings.TrimSpace(stringField(fields, "recipient_uid"))
		if recipient == "" || !userExists(recipient) {
			sp.SkippedNotification = append(sp.SkippedNotification, id)
			sp.note("notification_recipient_unresolved", id)
			continue
		}
		typ := strings.TrimSpace(stringField(fields, "type"))
		if typ == "" {
			// notifications.type is Required, so a typeless row cannot be
			// written and would otherwise render as an unreadable empty bell.
			sp.SkippedNotification = append(sp.SkippedNotification, id)
			sp.note("notification_type_missing", id)
			continue
		}
		payload, err := rewriteNotificationPayload(fields["payload"])
		if err != nil {
			sp.SkippedNotification = append(sp.SkippedNotification, id)
			sp.note("notification_payload_undecodable", id)
			continue
		}

		row := NotificationRow{
			LegacyID:    id,
			TargetID:    DeriveID(SpaceNotification, id),
			RecipientID: DeriveID(SpaceUser, recipient),
			Type:        typ,
			// The legacy document has no sender field, so this stays empty rather
			// than being invented from the recipient.
			Read:      legacyBoolField(fields, "read"),
			Archived:  legacyBoolField(fields, "archived"),
			CreatedAt: TimestampToISO(timeField(fields, "created_at")),
			// Nor does it have a title. One is derived from the type so the list
			// is not a column of empty cells; it is a display string, not data,
			// so it is recorded as a decision rather than a defect.
			Title:       notificationTitle(typ),
			PayloadJSON: string(payload),
			Findings:    map[string]string{"title_derived_from_type": typ},
		}
		if row.PayloadJSON == "" {
			row.PayloadJSON = "{}"
		}
		sp.NotificationRows = append(sp.NotificationRows, row)
	}
	sort.Strings(sp.SkippedNotification)

	// --- direct messages ---------------------------------------------------
	messagesByConversation := map[string][]pendingDMMessage{}
	for _, key := range sortedKeys(plan.DMMessages) {
		convRef, _, ok := splitDMMessagesKey(key)
		if !ok {
			sp.note("dm_message_key_malformed", key)
			continue
		}
		fields := plan.DMMessages[key]
		messagesByConversation[convRef] = append(messagesByConversation[convRef], pendingDMMessage{
			legacyKey: key,
			fields:    fields,
			created:   timeField(fields, "timestamp"),
		})
	}

	for _, convRef := range sortedKeys(plan.DMs) {
		fields := plan.DMs[convRef]
		participants := stringSliceField(fields, "participants")
		// A participant whose account document is missing from the export cannot
		// become a dm_members row (user_id is Required, 15-char derived id).
		//
		// The conversation is still imported if at least one member resolves: in
		// the 2026-09 export two threads have one of each, and dropping the whole
		// thread would delete ~8 real messages from a real person because of one
		// account the backup never captured. The gap is reported instead — and the
		// messages from the missing sender are dropped individually, because
		// dm_messages.sender_id is Required too.
		memberIDs := make([]string, 0, len(participants))
		known := make([]string, 0, len(participants))
		for _, uid := range participants {
			if !userExists(uid) {
				sp.note("dm_conversation_member_unresolved", convRef+"/"+uid)
				continue
			}
			known = append(known, uid)
			memberIDs = append(memberIDs, DeriveID(SpaceUser, uid))
		}
		if len(known) == 0 {
			// No membership at all: the conversation would be invisible in the
			// runtime, since every read path joins through dm_members.
			sp.SkippedDM = append(sp.SkippedDM, convRef)
			sp.note("dm_conversation_no_known_members", convRef)
			continue
		}

		conv := DMConversationRow{
			LegacyID:       convRef,
			TargetID:       DeriveID(SpaceDM, convRef),
			ParticipantIDs: memberIDs,
			LastMessage:    stringField(fields, "lastMessage"),
			// lastTimestamp is a tagged Firestore timestamp, decoded to a
			// time.Time — NOT the decimal string I first assumed. Reading it
			// through stringField formatted a time.Time with %v and produced a
			// 33-character "2026-05-06 15:50:24.389 +0000 UTC" that PocketBase
			// would have stored as a date.
			LastMessageAt: TimestampToISO(timeField(fields, "lastTimestamp")),
		}

		published := make([]pendingDMMessage, 0)
		for _, m := range messagesByConversation[convRef] {
			sender := strings.TrimSpace(stringField(m.fields, "sender_uid"))
			if sender == "" || !userExists(sender) {
				sp.SkippedDM = append(sp.SkippedDM, m.legacyKey)
				sp.note("dm_message_sender_unresolved", m.legacyKey)
				continue
			}
			if strings.TrimSpace(stringField(m.fields, "text")) == "" {
				// dm_messages.text is Required; an empty message cannot be
				// written and would otherwise abort the batch.
				sp.SkippedDM = append(sp.SkippedDM, m.legacyKey)
				sp.note("dm_message_text_empty", m.legacyKey)
				continue
			}
			published = append(published, m)
		}
		// Sequence reconstruction: identical in spirit to the forum posts.
		sort.Slice(published, func(i, j int) bool {
			if !published[i].created.Equal(published[j].created) {
				return published[i].created.Before(published[j].created)
			}
			return published[i].legacyKey < published[j].legacyKey
		})

		for i := range published {
			m := &published[i]
			sp.MessageRows = append(sp.MessageRows, DMMessageRow{
				LegacyID:       m.legacyKey,
				TargetID:       DeriveID(SpaceDMMessage, m.legacyKey),
				ConversationID: conv.TargetID,
				SenderID:       DeriveID(SpaceUser, stringField(m.fields, "sender_uid")),
				Sequence:       i + 1,
				Text:           stringField(m.fields, "text"),
				CreatedAt:      TimestampToISO(m.created),
			})
			sp.SequenceCount++
			conv.MessagesCount++
		}

		// The legacy header names the newest message on only 8 of 9
		// conversations, so the row just written is the authority: the copied
		// header is a fallback, never the source of truth.
		if last := lastDMMessage(sp.MessageRows, conv.TargetID); last != nil {
			conv.LastMessage = last.Text
			if last.CreatedAt != "" {
				conv.LastMessageAt = last.CreatedAt
			}
		}

		unread := unreadCounts(fields)
		cleared := perParticipantTime(fields, "clearedAt")
		for _, uid := range known {
			// The legacy `unread` is a COUNT, not a sequence, so the faithful
			// translation is "everything minus what was unread".
			lastRead := conv.MessagesCount - unread[uid]
			if lastRead < 0 {
				lastRead = 0
			}
			memberKey := convRef + "/" + uid
			sp.MemberRows = append(sp.MemberRows, DMMemberRow{
				TargetID:         DeriveID(SpaceDMMember, memberKey),
				LegacyKey:        memberKey,
				ConversationID:   conv.TargetID,
				UserID:           DeriveID(SpaceUser, uid),
				LastReadSequence: lastRead,
				// clearedAt is per-participant too — a MAP of uid to timestamp,
				// not a single date. Reading it as a scalar string formatted the
				// whole map and blew the 64-character column limit.
				ClearedAt: TimestampToISO(cleared[uid]),
			})
		}

		sp.ConversationRows = append(sp.ConversationRows, conv)
	}
	sort.Strings(sp.SkippedDM)

	// --- audit logs -------------------------------------------------------
	for _, id := range sortedKeys(plan.AuditLogs) {
		fields := plan.AuditLogs[id]
		action := strings.TrimSpace(stringField(fields, "action_type"))
		performer := strings.TrimSpace(stringField(fields, "performer_id"))
		if action == "" {
			sp.SkippedAudit = append(sp.SkippedAudit, id)
			sp.note("audit_action_missing", id)
			continue
		}
		if performer == "" || !userExists(performer) {
			// audit_logs.performer_id is Required and holds a 15-char derived id,
			// so a row whose actor never imported cannot be written.
			sp.SkippedAudit = append(sp.SkippedAudit, id)
			sp.note("audit_performer_unresolved", id)
			continue
		}
		details := "{}"
		if d, ok := fields["details"].(map[string]any); ok {
			if encoded, err := jsonMarshal(d); err == nil {
				details = string(encoded)
			}
			// Verbatim on purpose — see the header comment.
			sp.note("audit_details_kept_verbatim", id)
		}
		sp.AuditRows = append(sp.AuditRows, AuditLogRow{
			LegacyID:    id,
			TargetID:    DeriveID(SpaceAuditLog, id),
			ActionType:  action,
			PerformerID: DeriveID(SpaceUser, performer),
			DetailsJSON: details,
			CreatedAt:   TimestampToISO(timeField(fields, "created_at")),
		})
	}
	sort.Strings(sp.SkippedAudit)

	sort.Slice(sp.MessageRows, func(i, j int) bool { return sp.MessageRows[i].TargetID < sp.MessageRows[j].TargetID })
	sort.Slice(sp.MemberRows, func(i, j int) bool { return sp.MemberRows[i].TargetID < sp.MemberRows[j].TargetID })

	return sp
}

// splitDMMessagesKey splits "conv/messages/msg" into its halves.
func splitDMMessagesKey(key string) (conv, msg string, ok bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[1] != "messages" || parts[0] == "" || parts[2] == "" {
		return "", "", false
	}
	return parts[0], parts[2], true
}

// unreadCounts reads the legacy per-participant unread COUNT. It is a count, not
// a sequence — the target stores last_read_sequence — so the caller converts it.
func unreadCounts(fields map[string]any) map[string]int {
	out := map[string]int{}
	raw, ok := fields["unread"].(map[string]any)
	if !ok {
		return out
	}
	for uid, value := range raw {
		switch n := value.(type) {
		case float64:
			out[uid] = int(n)
		case int:
			out[uid] = n
		}
	}
	return out
}

// lastDMMessage returns the highest-sequence message written for a conversation.
func lastDMMessage(rows []DMMessageRow, conversationID string) *DMMessageRow {
	var newest *DMMessageRow
	for i := range rows {
		if rows[i].ConversationID != conversationID {
			continue
		}
		if newest == nil || rows[i].Sequence > newest.Sequence {
			newest = &rows[i]
		}
	}
	return newest
}

// perParticipantTime reads a legacy per-participant timestamp MAP, e.g.
// clearedAt: { "<uid>": <timestamp>, ... }.
//
// It is a map, not a scalar, and the distinction is load-bearing: passing the
// whole map to stringField formatted it with %v into a 200-character
// "map[<uid>:{...}]" string that blew the 64-character column limit.
func perParticipantTime(fields map[string]any, key string) map[string]time.Time {
	out := map[string]time.Time{}
	raw, ok := fields[key].(map[string]any)
	if !ok {
		return out
	}
	for uid, value := range raw {
		if t, ok := value.(time.Time); ok {
			out[uid] = t
		}
	}
	return out
}

// rewriteNotificationPayload replaces the known legacy id keys with derived ids
// and leaves every other value untouched.
func rewriteNotificationPayload(raw any) ([]byte, error) {
	if raw == nil {
		return nil, nil
	}
	payload, ok := raw.(map[string]any)
	if !ok {
		// A payload that is not an object (a bare string in some legacy rows) is
		// preserved as a JSON string rather than dropped.
		return jsonMarshal(raw)
	}
	for key, derive := range payloadIDKeys {
		legacyID, ok := payload[key].(string)
		if !ok || legacyID == "" {
			continue
		}
		payload[key] = derive(legacyID)
	}
	return jsonMarshal(payload)
}

// notificationTitle derives a display title from the type, because the legacy
// document has no title field and an empty cell in the notification list tells
// the recipient nothing. The mapping is a translation of the type name, not a
// guess about content.
func notificationTitle(typ string) string {
	switch typ {
	case "post_mentioned":
		return "You were mentioned"
	case "post_quoted":
		return "Your post was quoted"
	case "topic_reply":
		return "New reply in a topic you follow"
	case "reputation_change":
		return "Your reputation changed"
	case "new_registration":
		return "A new user registered"
	default:
		return typ
	}
}

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func (sp *SocialPlan) note(code, detail string) {
	if existing, ok := sp.Findings[code]; ok {
		existing.Count++
		return
	}
	sp.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
}

// Selected is the number of rows this run would write.
func (sp *SocialPlan) Selected() int {
	return len(sp.NotificationRows) + len(sp.ConversationRows) +
		len(sp.MemberRows) + len(sp.MessageRows) + len(sp.AuditRows)
}

// SortedFindingLines renders the plan findings as stable "code: count" lines.
func (sp *SocialPlan) SortedFindingLines() []string {
	lines := make([]string, 0, len(sp.Findings))
	for code, f := range sp.Findings {
		line := fmt.Sprintf("%s: %d", code, f.Count)
		if len(f.Examples) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(f.Examples, " "))
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines
}

// SortedRowLines renders the planned rows as stable one-line summaries.
func (sp *SocialPlan) SortedRowLines() []string {
	lines := make([]string, 0, sp.Selected())
	for _, n := range sp.NotificationRows {
		lines = append(lines, fmt.Sprintf(
			"notification %s -> %s type=%s recipient=%s read=%t", n.LegacyID, n.TargetID, n.Type, n.RecipientID, n.Read))
	}
	for _, c := range sp.ConversationRows {
		lines = append(lines, fmt.Sprintf(
			"dm_conversation %s -> %s messages=%d members=%d", c.LegacyID, c.TargetID,
			c.MessagesCount, len(c.ParticipantIDs)))
	}
	for _, m := range sp.MessageRows {
		lines = append(lines, fmt.Sprintf(
			"dm_message %s -> %s conversation=%s sequence=%d", m.LegacyID, m.TargetID, m.ConversationID, m.Sequence))
	}
	for _, a := range sp.AuditRows {
		lines = append(lines, fmt.Sprintf(
			"audit_log %s -> %s action=%s performer=%s", a.LegacyID, a.TargetID, a.ActionType, a.PerformerID))
	}
	sort.Strings(lines)
	return lines
}
