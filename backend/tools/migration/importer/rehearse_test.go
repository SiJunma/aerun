package importer

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// testSystemRoles is the compiled system-role registry as BuildRolePlan expects
// to receive it: the target rows, not the legacy documents. The fixture ledger
// contains one legacy `roles/player` document, so the rehearsal must find it
// 1:1 and report every other system role as missing (the target registry is
// compiled, not source-driven).
func testSystemRoles() []RoleRow {
	return []RoleRow{
		{RoleID: "root", Name: "Root", Rank: 1000, Color: "danger", IsSystem: true,
			Permissions: []string{"admin_access", "moderate_content", "view_forum"}},
		{RoleID: "admin", Name: "Admin", Rank: 800, Color: "danger", IsSystem: true,
			Permissions: []string{"admin_access", "moderate_content", "view_forum"}},
		{RoleID: "moderator", Name: "Moderator", Rank: 600, Color: "info", IsSystem: true,
			Permissions: []string{"moderate_content", "view_forum"}},
		{RoleID: "player", Name: "Player", Rank: 400, Color: "primary", IsSystem: true,
			Permissions: []string{"post_reply", "use_dice", "view_forum"}},
		{RoleID: "spectator", Name: "Spectator", Rank: 300, Color: "secondary", IsSystem: true,
			Permissions: []string{"view_forum"}},
		{RoleID: "guest", Name: "Guest", Rank: 200, Color: "light", IsSystem: true,
			Permissions: []string{"view_forum"}},
	}
}

// scal helper builds a tagged scalar for the fixture ledger.
func scal(v any) TaggedValue {
	payload, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return TaggedValue{Type: "scalar", Value: payload}
}

// stamp builds a tagged timestamp for the fixture ledger.
func stamp(seconds int64) TaggedValue {
	s := seconds
	return TaggedValue{Type: "timestamp", Seconds: &s}
}

// mapOf builds a tagged map out of already-tagged children.
func mapOf(fields map[string]TaggedValue) TaggedValue {
	payload, err := json.Marshal(fields)
	if err != nil {
		panic(err)
	}
	return TaggedValue{Type: "map", Value: payload}
}

// newFixtureLedger assembles a tiny but complete forum: one user, one role, a
// category, a topic with its post, a subscription and a DM with one message.
// Every foreign key resolves, so a passing rehearsal must report none.
func newFixtureLedger() *StagingLedger {
	return &StagingLedger{
		Version:   1,
		ProjectID: "fixture-project",
		StartedAt: "2026-09-25T00:00:00Z",
		Snapshot:  "fixture",
		Records: []StagingRecord{
			{Kind: "firestore", Path: "roles/player", Data: mapOf(map[string]TaggedValue{
				"name": scal("Player"), "base_role_id": scal("player"), "is_system": scal(true),
			})},
			{Kind: "firestore", Path: "users/u1", Data: mapOf(map[string]TaggedValue{
				"nickname": scal("Arin"), "role_id": scal("player"), "status": scal("active"),
				"post_count": scal(1), "reputation": scal(0), "created_at": stamp(1700000000),
			})},
			{Kind: "firestore", Path: "categories/c1", Data: mapOf(map[string]TaggedValue{
				"name": scal("General"), "topic_count": scal(1),
			})},
			{Kind: "firestore", Path: "topics/t1", Data: mapOf(map[string]TaggedValue{
				"title": scal("First"), "author_id": scal("u1"), "category_id": scal("c1"),
				"posts_count": scal(1), "created_at": stamp(1700000100),
			})},
			{Kind: "firestore", Path: "posts/p1", Data: mapOf(map[string]TaggedValue{
				"content": scal("Hello"), "topic_id": scal("t1"), "author_id": scal("u1"),
				"category_id": scal("c1"), "created_at": stamp(1700000200),
			})},
			{Kind: "firestore", Path: "topic_subscriptions/s1", Data: mapOf(map[string]TaggedValue{
				"user_id": scal("u1"), "topic_id": scal("t1"),
			})},
			{Kind: "firestore", Path: "dms/d1", Data: mapOf(map[string]TaggedValue{
				"participants": {Type: "array", Value: json.RawMessage(`[{"type":"scalar","value":"u1"}]`)},
			})},
			{Kind: "firestore", Path: "dms/d1/messages/m1", Data: mapOf(map[string]TaggedValue{
				"sender_id": scal("u1"), "content": scal("hi"), "created_at": stamp(1700000300),
			})},
		},
	}
}

// writeFixtureLedger persists the fixture ledger so Rehearse can be exercised
// through its real file-reading path. The checksum is computed exactly the way
// LoadStagingLedger does, so the fixture does not trip the tamper warning.
func writeFixtureLedger(t *testing.T) string {
	t.Helper()
	ledger := newFixtureLedger()
	payload, err := json.Marshal(ledger)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	var parsed StagingLedger
	if err := json.Unmarshal(payload, &parsed); err != nil {
		t.Fatalf("round-trip fixture: %v", err)
	}
	checksumPayload, err := json.Marshal(struct {
		Version   int             `json:"version"`
		ProjectID string          `json:"projectId"`
		StartedAt string          `json:"startedAt"`
		Snapshot  string          `json:"snapshot"`
		Records   []StagingRecord `json:"records"`
	}{parsed.Version, parsed.ProjectID, parsed.StartedAt, parsed.Snapshot, parsed.Records})
	if err != nil {
		t.Fatalf("marshal checksum payload: %v", err)
	}
	parsed.Checksum = fmt.Sprintf("%x", sha256.Sum256(checksumPayload))
	final, err := json.Marshal(&parsed)
	if err != nil {
		t.Fatalf("marshal signed fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), "stage.json")
	if err := os.WriteFile(path, final, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

// TestRehearse_TwoRunsAgree is the Sprint 7 Definition of Done in miniature:
// two rehearsals of the same export must describe the same target state, so
// their mapping digests and their (duration-free) reports must match exactly.
func TestRehearse_TwoRunsAgree(t *testing.T) {
	path := writeFixtureLedger(t)
	logger := slog.New(slog.DiscardHandler)

	first, _, err := Rehearse(path, "", testSystemRoles(), nil, logger)
	if err != nil {
		t.Fatalf("first run: %v", err)
	}
	second, _, err := Rehearse(path, "", testSystemRoles(), nil, logger)
	if err != nil {
		t.Fatalf("second run: %v", err)
	}

	if len(first.ForeignKeyErrors) != 0 {
		t.Fatalf("fixture must have no FK errors, got %v", first.ForeignKeyErrors)
	}
	// 8 source records + 1 derived dm_members row for (d1, u1).
	if first.MappingSize != 9 {
		t.Errorf("MappingSize = %d, want 9 mapped records", first.MappingSize)
	}
	if first.RecordCounts["posts"] != 1 || first.RecordCounts["topics"] != 1 {
		t.Errorf("record counts wrong: %v", first.RecordCounts)
	}
	if first.MappingDigest != second.MappingDigest {
		t.Errorf("mapping digests differ: %s vs %s", first.MappingDigest, second.MappingDigest)
	}
	// posts have no legacy sequence, so exactly that finding is explainable.
	if got := first.Compatibility.Findings["post_sequence_recomputed"].Count; got != 1 {
		t.Errorf("post_sequence_recomputed count = %d, want 1", got)
	}

	dir := t.TempDir()
	p1, p2 := filepath.Join(dir, "r1.json"), filepath.Join(dir, "r2.json")
	if err := WriteReport(first, p1); err != nil {
		t.Fatalf("write first report: %v", err)
	}
	if err := WriteReport(second, p2); err != nil {
		t.Fatalf("write second report: %v", err)
	}
	b1, err := os.ReadFile(p1)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := os.ReadFile(p2)
	if err != nil {
		t.Fatal(err)
	}
	if string(b1) != string(b2) {
		t.Error("two reports of the same export are not byte-identical")
	}
}

// TestWriteReport_RefusesOverwrite locks the exclusive-creation discipline: a
// later rehearsal must never clobber an earlier artefact.
func TestWriteReport_RefusesOverwrite(t *testing.T) {
	result := &RehearsalResult{ProjectID: "p"}
	path := filepath.Join(t.TempDir(), "report.json")
	if err := WriteReport(result, path); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := WriteReport(result, path); err == nil {
		t.Fatal("second write to the same path must fail")
	}
}
