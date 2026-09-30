package importer

// Tests for the L8/L9 plan: notifications, direct messages, audit logs.
//
// These three are user-facing history, so the properties worth pinning are the
// ones that decide whether a person sees a message at all: the DM sequence, the
// payload id rewrite, and the unread-count translation.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func socialFixture() *ImportPlan {
	return &ImportPlan{
		Notifications: map[string]map[string]any{},
		DMs:           map[string]map[string]any{},
		DMMessages:    map[string]map[string]any{},
		AuditLogs:     map[string]map[string]any{},
	}
}

func socialAt(sec int64) time.Time { return time.Unix(sec, 0).UTC() }

func dmMessage(conv, msg, sender, text string, at time.Time) map[string]any {
	return map[string]any{
		"sender_uid": sender, "text": text, "timestamp": at,
	}
}

// TestDMSequenceFollowsTimestamps pins the reconstruction: messages are numbered
// 1..n in timestamp order, and a conversation with no sequence field of its own
// is still readable in the target.
func TestDMSequenceFollowsTimestamps(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants": []any{"u1", "u2"},
	}
	// Stored deliberately out of order: the map key sort must not decide the
	// sequence, only the timestamps may.
	plan.DMMessages["u1_u2/messages/m3"] = dmMessage("u1_u2", "m3", "u1", "third", socialAt(300))
	plan.DMMessages["u1_u2/messages/m1"] = dmMessage("u1_u2", "m1", "u1", "first", socialAt(100))
	plan.DMMessages["u1_u2/messages/m2"] = dmMessage("u1_u2", "m2", "u2", "second", socialAt(200))

	sp := BuildSocialPlan(plan, existsAlways)

	if len(sp.MessageRows) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(sp.MessageRows))
	}
	want := map[string]string{"first": "1", "second": "2", "third": "3"}
	for _, m := range sp.MessageRows {
		if want[m.Text] != string(rune('0'+m.Sequence)) {
			t.Fatalf("message %q got sequence %d, want %s", m.Text, m.Sequence, want[m.Text])
		}
	}
	if sp.SequenceCount != 3 {
		t.Fatalf("expected 3 sequences assigned, got %d", sp.SequenceCount)
	}
	if len(sp.ConversationRows) != 1 || sp.ConversationRows[0].MessagesCount != 3 {
		t.Fatalf("messages_count must be recomputed from the rows written, got %+v", sp.ConversationRows)
	}
}

// TestDMSequenceStartsAtOne pins the difference from forum posts: a draft may
// carry sequence 0, a DM message may not.
func TestDMSequenceStartsAtOne(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{"participants": []any{"u1", "u2"}}
	plan.DMMessages["u1_u2/messages/only"] = dmMessage("u1_u2", "only", "u1", "hello", socialAt(100))

	sp := BuildSocialPlan(plan, existsAlways)

	if sp.MessageRows[0].Sequence != 1 {
		t.Fatalf("a DM conversation must start at 1, got %d", sp.MessageRows[0].Sequence)
	}
}

// TestDMConversationsAreIndependentlyNumbered guards against numbering running
// across the whole export: two conversations both start at 1.
func TestDMConversationsAreIndependentlyNumbered(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{"participants": []any{"u1", "u2"}}
	plan.DMs["u3_u4"] = map[string]any{"participants": []any{"u3", "u4"}}
	plan.DMMessages["u1_u2/messages/a"] = dmMessage("u1_u2", "a", "u1", "hi", socialAt(100))
	plan.DMMessages["u3_u4/messages/b"] = dmMessage("u3_u4", "b", "u3", "yo", socialAt(50))

	sp := BuildSocialPlan(plan, existsAlways)

	if len(sp.MessageRows) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(sp.MessageRows))
	}
	for _, m := range sp.MessageRows {
		if m.Sequence != 1 {
			t.Fatalf("each conversation numbers from 1, got %d for %s", m.Sequence, m.LegacyID)
		}
	}
	if sp.MessageRows[0].ConversationID == sp.MessageRows[1].ConversationID {
		t.Fatal("the two conversations must have distinct target ids")
	}
}

// TestUnreadCountBecomesLastReadSequence pins the translation. The legacy field is
// a COUNT of unread messages, while the target stores the sequence number of the
// last one read — so 5 messages with 2 unread means last_read_sequence 3, not 2.
func TestUnreadCountBecomesLastReadSequence(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants": []any{"u1", "u2"},
		"unread":       map[string]any{"u1": float64(2), "u2": float64(0)},
	}
	for i := 0; i < 5; i++ {
		plan.DMMessages["u1_u2/messages/m"+string(rune('a'+i))] = dmMessage(
			"u1_u2", "m", "u1", "msg", socialAt(int64(100+i)))
	}

	sp := BuildSocialPlan(plan, existsAlways)

	got := map[string]int{}
	for _, m := range sp.MemberRows {
		got[m.UserID] = m.LastReadSequence
	}
	u1 := DeriveID(SpaceUser, "u1")
	u2 := DeriveID(SpaceUser, "u2")
	if got[u1] != 3 {
		t.Fatalf("2 unread of 5 means last_read_sequence 3, got %d", got[u1])
	}
	if got[u2] != 5 {
		t.Fatalf("0 unread of 5 means last_read_sequence 5, got %d", got[u2])
	}
}

// TestUnreadLargerThanTotalClamps pins the guard on a count that cannot be right.
func TestUnreadLargerThanTotalClamps(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants": []any{"u1", "u2"},
		"unread":       map[string]any{"u1": float64(99)},
	}
	plan.DMMessages["u1_u2/messages/a"] = dmMessage("u1_u2", "a", "u1", "hi", socialAt(100))

	sp := BuildSocialPlan(plan, existsAlways)

	for _, m := range sp.MemberRows {
		if m.LastReadSequence < 0 {
			t.Fatalf("last_read_sequence must never go negative, got %d", m.LastReadSequence)
		}
	}
}

// TestLastMessageComesFromTheRowsNotTheHeader pins which source wins. The legacy
// header is present on only 8 of 9 conversations in the export, so a copied value
// is a fallback; the row this run wrote is the authority.
func TestLastMessageComesFromTheRowsNotTheHeader(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants":  []any{"u1", "u2"},
		"lastMessage":   "STALE HEADER",
		"lastTimestamp": "1789181253.239000000",
	}
	plan.DMMessages["u1_u2/messages/a"] = dmMessage("u1_u2", "a", "u1", "the real last", socialAt(100))

	sp := BuildSocialPlan(plan, existsAlways)

	conv := sp.ConversationRows[0]
	if conv.LastMessage != "the real last" {
		t.Fatalf("the written row must win over the header, got %q", conv.LastMessage)
	}
	if conv.LastMessageAt != TimestampToISO(socialAt(100)) {
		t.Fatalf("last_message_at must follow the newest row, got %q", conv.LastMessageAt)
	}
}

// TestLastTimestampIsATaggedTimestamp pins the encoding. I first assumed
// lastTimestamp was a decimal string; it is a tagged Firestore timestamp that
// decodes to a time.Time. Reading it with stringField formatted the time.Time
// with %v and produced "2026-05-06 15:50:24.389 +0000 UTC" — a 33-character
// string in a date column.
func TestLastTimestampIsATaggedTimestamp(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants":  []any{"u1", "u2"},
		"lastMessage":   "stale",
		"lastTimestamp": socialAt(100),
	}

	sp := BuildSocialPlan(plan, existsAlways)

	conv := sp.ConversationRows[0]
	if conv.LastMessageAt != TimestampToISO(socialAt(100)) {
		t.Fatalf("last_message_at = %q, want %q", conv.LastMessageAt, TimestampToISO(socialAt(100)))
	}
	if strings.Contains(conv.LastMessageAt, "UTC") || len(conv.LastMessageAt) > 32 {
		t.Fatalf("a Go time.Time was stringified instead of formatted: %q", conv.LastMessageAt)
	}
}

// TestClearedAtIsAPerParticipantMap pins the second encoding surprise: clearedAt
// is a MAP of uid to timestamp, like unread — not a single date. Reading it as a
// scalar stringified the whole map and blew the 64-character column limit.
func TestClearedAtIsAPerParticipantMap(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_u2"] = map[string]any{
		"participants": []any{"u1", "u2"},
		"clearedAt":    map[string]any{"u1": socialAt(500)},
	}
	plan.DMMessages["u1_u2/messages/a"] = dmMessage("u1_u2", "a", "u1", "hi", socialAt(100))

	sp := BuildSocialPlan(plan, existsAlways)

	cleared := map[string]string{}
	for _, m := range sp.MemberRows {
		if len(m.ClearedAt) > 64 {
			t.Fatalf("cleared_at must fit its 64-character column, got %d chars", len(m.ClearedAt))
		}
		cleared[m.UserID] = m.ClearedAt
	}
	if cleared[DeriveID(SpaceUser, "u1")] != TimestampToISO(socialAt(500)) {
		t.Fatalf("u1 cleared_at must come from the map, got %q", cleared[DeriveID(SpaceUser, "u1")])
	}
	if cleared[DeriveID(SpaceUser, "u2")] != "" {
		t.Fatalf("a participant with no clearedAt must get an empty string, got %q",
			cleared[DeriveID(SpaceUser, "u2")])
	}
}

// TestConversationKeepsTheKnownMemberWhenOneAccountIsMissing pins the decision
// that cost the most thought here.
//
// The 2026-09 export has two threads where one participant's account document is
// absent entirely — the UID appears in DMs and messages but has no users/ record.
// My first version dropped the whole thread, because dm_members.user_id is
// Required. But that deletes ~8 real messages from a real person because of one
// account the backup never captured, and the runtime can still show the
// conversation to the member who did import. So the thread is kept, the
// unresolvable member is reported, and only that member's own messages go.
func TestConversationKeepsTheKnownMemberWhenOneAccountIsMissing(t *testing.T) {
	plan := socialFixture()
	plan.DMs["u1_ghost"] = map[string]any{"participants": []any{"u1", "ghost"}}
	plan.DMMessages["u1_ghost/messages/a"] = dmMessage("u1_ghost", "a", "u1", "from u1", socialAt(100))
	plan.DMMessages["u1_ghost/messages/b"] = dmMessage("u1_ghost", "b", "ghost", "from ghost", socialAt(200))

	sp := BuildSocialPlan(plan, existsExcept("ghost"))

	if len(sp.ConversationRows) != 1 {
		t.Fatalf("a thread with one known member must survive, got %d", len(sp.ConversationRows))
	}
	if len(sp.ConversationRows[0].ParticipantIDs) != 1 {
		t.Fatalf("only the known member may become a dm_members row, got %v",
			sp.ConversationRows[0].ParticipantIDs)
	}
	if len(sp.MemberRows) != 1 {
		t.Fatalf("expected one member row, got %d", len(sp.MemberRows))
	}
	// u1's message survives; the missing sender's does not, and the sequence
	// closes up so it stays 1..n with no hole.
	if len(sp.MessageRows) != 1 || sp.MessageRows[0].Text != "from u1" || sp.MessageRows[0].Sequence != 1 {
		t.Fatalf("only the known sender's message may be written, got %+v", sp.MessageRows)
	}
	if _, ok := sp.Findings["dm_conversation_member_unresolved"]; !ok {
		t.Fatal("the dropped member must be reported")
	}
	if _, ok := sp.Findings["dm_message_sender_unresolved"]; !ok {
		t.Fatal("the dropped message must be reported")
	}
}

// TestConversationWithNoKnownMemberIsDropped pins the other side of that rule: a
// thread nobody can see is not imported, because every read path joins through
// dm_members and the row would be invisible.
func TestConversationWithNoKnownMemberIsDropped(t *testing.T) {
	plan := socialFixture()
	plan.DMs["g1_g2"] = map[string]any{"participants": []any{"g1", "g2"}}
	plan.DMMessages["g1_g2/messages/a"] = dmMessage("g1_g2", "a", "g1", "hi", socialAt(100))

	sp := BuildSocialPlan(plan, existsExcept("g1", "g2"))

	if len(sp.ConversationRows) != 0 {
		t.Fatalf("an unviewable conversation must not be written, got %d", len(sp.ConversationRows))
	}
	if len(sp.MessageRows) != 0 {
		t.Fatalf("nor its messages, got %d", len(sp.MessageRows))
	}
	if _, ok := sp.Findings["dm_conversation_no_known_members"]; !ok {
		t.Fatal("the drop must be reported")
	}
}

// TestNotificationPayloadIDsAreRewritten pins the one thing that makes a
// notification clickable. The payload carries legacy Firestore ids; a reader who
// clicks a "you were mentioned" notification must land on a topic, so those
// values become derived ids.
func TestNotificationPayloadIDsAreRewritten(t *testing.T) {
	plan := socialFixture()
	plan.Notifications["n1"] = map[string]any{
		"recipient_uid": "u1",
		"type":          "post_mentioned",
		"read":          false,
		"created_at":    socialAt(100),
		"payload": map[string]any{
			"post_id":     "p1",
			"topic_id":    "t1",
			"topic_title": "Original title",
		},
	}

	sp := BuildSocialPlan(plan, existsAlways)

	if len(sp.NotificationRows) != 1 {
		t.Fatalf("expected one notification, got %d", len(sp.NotificationRows))
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(sp.NotificationRows[0].PayloadJSON), &payload); err != nil {
		t.Fatalf("payload must stay valid JSON: %v", err)
	}
	if payload["post_id"] != DeriveID(SpacePost, "p1") {
		t.Fatalf("post_id must be a derived id, got %v", payload["post_id"])
	}
	if payload["topic_id"] != DeriveID(SpaceTopic, "t1") {
		t.Fatalf("topic_id must be a derived id, got %v", payload["topic_id"])
	}
	// Prose must survive untouched: rewriting text is how a migration corrupts data.
	if payload["topic_title"] != "Original title" {
		t.Fatalf("prose must be preserved, got %v", payload["topic_title"])
	}
}

// TestNotificationTopicReplyPayloadRewritesBothPostIDs pins the shape that has two
// post links — first_post_id and last_post_id — so that "jump to the reply you are
// following" still points at a real post.
func TestNotificationTopicReplyPayloadRewritesBothPostIDs(t *testing.T) {
	plan := socialFixture()
	plan.Notifications["n1"] = map[string]any{
		"recipient_uid": "u1",
		"type":          "topic_reply",
		"created_at":    socialAt(100),
		"payload": map[string]any{
			"first_post_id": "p1", "last_post_id": "p9", "post_count": float64(4),
		},
	}

	sp := BuildSocialPlan(plan, existsAlways)

	var payload map[string]any
	if err := json.Unmarshal([]byte(sp.NotificationRows[0].PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["first_post_id"] != DeriveID(SpacePost, "p1") ||
		payload["last_post_id"] != DeriveID(SpacePost, "p9") {
		t.Fatalf("both post links must be rewritten, got %v", payload)
	}
	if payload["post_count"] != float64(4) {
		t.Fatalf("non-id values must survive, got %v", payload["post_count"])
	}
}

// TestNotificationWithoutSenderStaysEmpty pins that an absent sender is not
// invented. The legacy document has no sender field; filling it with the
// recipient would make every notification look self-sent.
func TestNotificationWithoutSenderStaysEmpty(t *testing.T) {
	plan := socialFixture()
	plan.Notifications["n1"] = map[string]any{
		"recipient_uid": "u1", "type": "post_quoted", "created_at": socialAt(100),
	}

	sp := BuildSocialPlan(plan, existsAlways)

	if sp.NotificationRows[0].SenderID != "" {
		t.Fatalf("sender_id must stay empty, got %q", sp.NotificationRows[0].SenderID)
	}
}

func TestNotificationRequiresRecipientAndType(t *testing.T) {
	plan := socialFixture()
	plan.Notifications["noRecipient"] = map[string]any{"type": "post_quoted"}
	plan.Notifications["noType"] = map[string]any{"recipient_uid": "u1"}
	plan.Notifications["ghostRecipient"] = map[string]any{"recipient_uid": "ghost", "type": "post_quoted"}

	sp := BuildSocialPlan(plan, existsExcept("ghost"))

	if len(sp.NotificationRows) != 0 {
		t.Fatalf("none of these can be written, got %d", len(sp.NotificationRows))
	}
	if len(sp.SkippedNotification) != 3 {
		t.Fatalf("all three must be recorded, got %v", sp.SkippedNotification)
	}
	for _, code := range []string{"notification_recipient_unresolved", "notification_type_missing"} {
		if _, ok := sp.Findings[code]; !ok {
			t.Fatalf("finding %s must be reported", code)
		}
	}
}

// TestAuditDetailsAreCopiedVerbatim pins the deliberate decision NOT to rewrite
// the details blob. It is free-form forensic data with no schema in the target —
// the export uses 30 different key spellings — so a guessed rewrite could corrupt
// an audit record. performer_id, which IS a real reference, is still rewritten.
func TestAuditDetailsAreCopiedVerbatim(t *testing.T) {
	plan := socialFixture()
	plan.AuditLogs["a1"] = map[string]any{
		"action_type":  "category_updated",
		"performer_id": "u1",
		"created_at":   socialAt(100),
		"details": map[string]any{
			"targetId":  "OLDLEGACYID",
			"target_id": "OLDLEGACYID",
			"title":     "Something",
		},
	}

	sp := BuildSocialPlan(plan, existsAlways)

	if len(sp.AuditRows) != 1 {
		t.Fatalf("expected one audit row, got %d", len(sp.AuditRows))
	}
	row := sp.AuditRows[0]
	if !strings.Contains(row.DetailsJSON, "OLDLEGACYID") {
		t.Fatalf("details must be copied verbatim, got %s", row.DetailsJSON)
	}
	if row.PerformerID != DeriveID(SpaceUser, "u1") {
		t.Fatalf("performer_id must be a derived id, got %q", row.PerformerID)
	}
	if _, ok := sp.Findings["audit_details_kept_verbatim"]; !ok {
		t.Fatal("the verbatim copy must be reported")
	}
}

func TestAuditRequiresActionAndKnownPerformer(t *testing.T) {
	plan := socialFixture()
	plan.AuditLogs["noAction"] = map[string]any{"performer_id": "u1"}
	plan.AuditLogs["ghostPerformer"] = map[string]any{"action_type": "x", "performer_id": "ghost"}

	sp := BuildSocialPlan(plan, existsExcept("ghost"))

	if len(sp.AuditRows) != 0 {
		t.Fatalf("neither row is writable, got %d", len(sp.AuditRows))
	}
	if _, ok := sp.Findings["audit_performer_unresolved"]; !ok {
		t.Fatal("an unknown performer must be reported")
	}
}

// TestSocialPlanIsDeterministic guards the two-database comparison: the same
// input must produce the same rows in the same order on every run.
func TestSocialPlanIsDeterministic(t *testing.T) {
	build := func() *SocialPlan {
		plan := socialFixture()
		plan.DMs["u1_u2"] = map[string]any{"participants": []any{"u2", "u1"}}
		for i := 0; i < 4; i++ {
			key := "u1_u2/messages/m" + string(rune('a'+i))
			plan.DMMessages[key] = dmMessage("u1_u2", "m", "u1", "x", socialAt(int64(100+i)))
		}
		plan.Notifications["n1"] = map[string]any{"recipient_uid": "u1", "type": "post_quoted"}
		plan.Notifications["n2"] = map[string]any{"recipient_uid": "u2", "type": "topic_reply"}
		plan.AuditLogs["a1"] = map[string]any{"action_type": "x", "performer_id": "u1"}
		return BuildSocialPlan(plan, existsAlways)
	}

	first, second := build(), build()
	a, b := first.SortedRowLines(), second.SortedRowLines()
	if len(a) != len(b) {
		t.Fatalf("row counts differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("line %d differs:\n%s\n%s", i, a[i], b[i])
		}
	}
	fa, fb := first.SortedFindingLines(), second.SortedFindingLines()
	if strings.Join(fa, "|") != strings.Join(fb, "|") {
		t.Fatalf("findings differ:\n%v\n%v", fa, fb)
	}
}
