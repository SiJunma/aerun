package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDeriveID_ShapeAndStability locks the contract the whole import relies
// on: every derived id must be exactly 15 characters of PocketBase's alphabet,
// and it must be a pure function of (space, legacyID).
func TestDeriveID_ShapeAndStability(t *testing.T) {
	cases := []struct {
		space  IDSpace
		legacy string
	}{
		{SpaceUser, "KunGboFv3gcADRDOWwmlWeCzkbo1"},
		{SpaceTopic, "NjyrN2ofUwEUuD5HDljX"},
		{SpacePost, "NjyrN2ofUwEUuD5HDljX"},
		{SpaceRole, "player"},
	}
	for _, tc := range cases {
		id := DeriveID(tc.space, tc.legacy)
		if len(id) != pbIDLength {
			t.Fatalf("DeriveID(%s,%s) = %q, want %d characters", tc.space, tc.legacy, id, pbIDLength)
		}
		for i := 0; i < len(id); i++ {
			if !strings.ContainsRune(pbIDAlphabet, rune(id[i])) {
				t.Fatalf("id %q contains %q outside the PocketBase alphabet", id, id[i])
			}
		}
	}

	if DeriveID(SpaceTopic, "NjyrN2ofUwEUuD5HDljX") != DeriveID(SpaceTopic, "NjyrN2ofUwEUuD5HDljX") {
		t.Fatal("DeriveID is not deterministic")
	}
	if DeriveID(SpaceTopic, "NjyrN2ofUwEUuD5HDljX") == DeriveID(SpacePost, "NjyrN2ofUwEUuD5HDljX") {
		t.Fatal("the same legacy id in two spaces must not collide")
	}
	if DeriveID(SpaceTopic, "a") == DeriveID(SpaceTopic, "b") {
		t.Fatal("different legacy ids must not collide")
	}
}

// TestDeriveID_GoldenValues fails if the derivation function is ever changed.
// That is deliberate: changing it would invalidate every mapping table written
// by an earlier rehearsal and silently turn a rehearsed import into a different
// database.
func TestDeriveID_GoldenValues(t *testing.T) {
	golden := []struct {
		space  IDSpace
		legacy string
		want   string
	}{
		{SpaceUser, "KunGboFv3gcADRDOWwmlWeCzkbo1", "M9prT4Y0Fe1S3at"},
		{SpaceTopic, "NjyrN2ofUwEUuD5HDljX", "W0V2zP0iHIQaXpJ"},
		{SpaceRole, "player", "usO42MmmVJWQQ33"},
	}
	for _, tc := range golden {
		if got := DeriveID(tc.space, tc.legacy); got != tc.want {
			t.Fatalf("DeriveID(%s, %s) = %q, want %q — the derivation changed",
				tc.space, tc.legacy, got, tc.want)
		}
	}
}

func newTestPlan() *ImportPlan {
	return &ImportPlan{
		Users: map[string]map[string]any{
			"uid-1":            {"nickname": "Arin"},
			"uid-2":            {"nickname": "Rough"},
			"uid-1/characters": {"avatar": "x"}, // subcollection row, not a record
		},
		Categories:     map[string]map[string]any{"cat-1": {"name": "General"}},
		CategoryGroups: map[string]map[string]any{"grp-1": {"name": "Northbay"}},
		Topics:         map[string]map[string]any{"top-1": {"title": "Hello"}},
		Posts:          map[string]map[string]any{"post-1": {"topic_id": "top-1"}},
		Roles:          map[string]map[string]any{"player": {"name": "Player"}},
		DMs: map[string]map[string]any{
			"conv-1": {"participants": []any{"uid-1", "uid-2", ""}},
		},
		DMMessages: map[string]map[string]any{"conv-1/messages/m-1": {"text": "hi"}},
		Drafts: map[string]map[string]any{
			"uid-1/drafts/top-1": map[string]any{
				"topic_id": "top-1", "author_id": "uid-1", "is_draft": true, "content": "wip",
			},
		},
		Skipped: map[string]int{},
	}
}

func TestBuildMappings_CoversEveryDurableRecord(t *testing.T) {
	plan := newTestPlan()
	m, err := BuildMappings(plan, "aerun-forum")
	if err != nil {
		t.Fatalf("BuildMappings: %v", err)
	}

	// 2 users + 1 category + 1 group + 1 topic + 1 post + 1 draft + 1 role
	// + 1 dm conversation + 1 dm message + 2 dm members = 12. The
	// "uid-1/characters" subcollection row and the empty participant id must
	// not produce entries. The draft maps into the post space under its
	// composite legacy id "uid-1/drafts/top-1".
	if m.Len() != 12 {
		t.Fatalf("Len() = %d, want 11: %v", m.Len(), m.Entries())
	}

	for _, want := range []struct {
		space  IDSpace
		legacy string
	}{
		{SpaceUser, "uid-1"},
		{SpaceCategory, "cat-1"},
		{SpaceCategoryGroup, "grp-1"},
		{SpaceTopic, "top-1"},
		{SpacePost, "post-1"},
		{SpaceRole, "player"},
		{SpaceDM, "conv-1"},
		{SpaceDMMessage, "conv-1/messages/m-1"},
		{SpaceDMMember, "conv-1/uid-1"},
	} {
		if _, ok := m.Target(want.space, want.legacy); !ok {
			t.Errorf("missing mapping for %s/%s", want.space, want.legacy)
		}
	}
	if _, ok := m.Target(SpaceUser, "uid-1/characters"); ok {
		t.Error("subcollection rows must not be mapped as records")
	}
	if _, ok := m.Target(SpaceDMMember, "conv-1/"); ok {
		t.Error("empty participants must be ignored")
	}
}

// TestBuildMappings_TargetsMatchDerivation is the idempotency proof: re-running
// the build on the same plan must yield exactly the same ids, which is what
// lets a rehearsal be interrupted and replayed without duplicates.
func TestBuildMappings_TargetsMatchDerivation(t *testing.T) {
	plan := newTestPlan()
	first, err := BuildMappings(plan, "p")
	if err != nil {
		t.Fatalf("BuildMappings: %v", err)
	}
	second, err := BuildMappings(plan, "p")
	if err != nil {
		t.Fatalf("BuildMappings (second): %v", err)
	}

	a, b := first.Entries(), second.Entries()
	if len(a) != len(b) {
		t.Fatalf("entry count differs between runs: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("entry %d differs: %+v vs %+v", i, a[i], b[i])
		}
		if want := DeriveID(a[i].Space, a[i].LegacyID); want != a[i].TargetID {
			t.Fatalf("entry %+v does not match DeriveID %q", a[i], want)
		}
	}
}

func TestMappings_EntriesAreSorted(t *testing.T) {
	m := NewMappings()
	for _, e := range []struct {
		space  IDSpace
		legacy string
	}{{SpaceTopic, "z"}, {SpaceUser, "a"}, {SpaceUser, "b"}, {SpacePost, "a"}} {
		if _, err := m.Add(e.space, e.legacy); err != nil {
			t.Fatalf("Add: %v", err)
		}
	}
	entries := m.Entries()
	if len(entries) != 4 {
		t.Fatalf("Len() = %d, want 4", len(entries))
	}
	for i := 1; i < len(entries); i++ {
		prev, cur := entries[i-1], entries[i]
		if prev.Space > cur.Space || (prev.Space == cur.Space && prev.LegacyID >= cur.LegacyID) {
			t.Fatalf("entries not canonical: %+v before %+v", prev, cur)
		}
	}
}

func TestMappings_RejectsEmptyLegacyID(t *testing.T) {
	if _, err := NewMappings().Add(SpaceUser, ""); err == nil {
		t.Fatal("empty legacy id must be rejected")
	}
	if _, ok := NewMappings().Target(SpaceUser, ""); ok {
		t.Fatal("empty legacy id must never resolve")
	}
}

func TestMappingTable_SaveLoadRoundTrip(t *testing.T) {
	plan := newTestPlan()
	m, err := BuildMappings(plan, "aerun-forum")
	if err != nil {
		t.Fatalf("BuildMappings: %v", err)
	}

	path := filepath.Join(t.TempDir(), "mapping.json")
	if err := m.Table("aerun-forum").SaveTable(path); err != nil {
		t.Fatalf("SaveTable: %v", err)
	}

	// Exclusive creation: a checkpoint from an earlier rehearsal may be read
	// and diffed, never silently replaced.
	if err := m.Table("aerun-forum").SaveTable(path); err == nil {
		t.Fatal("SaveTable must refuse to overwrite an existing artifact")
	}

	reloaded, err := LoadMappingTable(path)
	if err != nil {
		t.Fatalf("LoadMappingTable: %v", err)
	}
	if reloaded.Len() != m.Len() {
		t.Fatalf("round trip lost entries: %d vs %d", reloaded.Len(), m.Len())
	}
	for _, e := range m.Entries() {
		got, ok := reloaded.Target(e.Space, e.LegacyID)
		if !ok || got != e.TargetID {
			t.Fatalf("round trip mismatch for %s/%s: %q %v", e.Space, e.LegacyID, got, ok)
		}
	}
	table, err := LoadTable(path)
	if err != nil {
		t.Fatalf("LoadTable: %v", err)
	}
	if table.ProjectID != "aerun-forum" {
		t.Fatalf("ProjectID = %q, want aerun-forum", table.ProjectID)
	}
}

// TestMappingTable_ByteIdenticalAcrossRuns is the Sprint 7 DoD check in the
// narrow sense: two imports of one export must describe the same target state,
// so their mapping tables must literally be the same file.
func TestMappingTable_ByteIdenticalAcrossRuns(t *testing.T) {
	plan := newTestPlan()
	m, err := BuildMappings(plan, "aerun-forum")
	if err != nil {
		t.Fatalf("BuildMappings: %v", err)
	}
	dir := t.TempDir()
	first, second := filepath.Join(dir, "a.json"), filepath.Join(dir, "b.json")

	if err := m.Table("aerun-forum").SaveTable(first); err != nil {
		t.Fatalf("SaveTable first: %v", err)
	}
	if err := m.Table("aerun-forum").SaveTable(second); err != nil {
		t.Fatalf("SaveTable second: %v", err)
	}
	a, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(second)
	if err != nil {
		t.Fatal(err)
	}
	if string(a) != string(b) {
		t.Fatal("two runs over the same export produced different mapping tables")
	}
}

// TestDraftsMapIntoPostSpaceAndValidateFK covers the draft import contract:
// a draft is post-shaped content that maps into the post space under its
// composite "uid/drafts/topicId" legacy id, and its foreign keys (plus the
// legacy owner/topic pairing encoded in the path) must validate.
func TestDraftsMapIntoPostSpaceAndValidateFK(t *testing.T) {
	plan := newTestPlan()

	m, err := BuildMappings(plan, "aerun-forum")
	if err != nil {
		t.Fatalf("BuildMappings: %v", err)
	}
	// Draft id must derive in the post space under the composite legacy id.
	if _, ok := m.Target(SpacePost, "uid-1/drafts/top-1"); !ok {
		t.Error("draft is not mapped into the post space")
	}
	postID, _ := m.Target(SpacePost, "post-1")
	if got, ok := m.Target(SpacePost, "uid-1/drafts/top-1"); ok && got == postID {
		t.Error("a draft must not collide with a real post id")
	}

	// A consistent draft passes FK validation.
	if errs := ValidateForeignKeys(plan); len(errs) != 0 {
		t.Fatalf("FK errors for a consistent draft: %v", errs)
	}

	// A draft whose topic vanished must be reported, not imported.
	plan.Posts = map[string]map[string]any{}
	plan.Topics = map[string]map[string]any{}
	errs := ValidateForeignKeys(plan)
	if len(errs) != 1 || !strings.Contains(errs[0], "draft uid-1/drafts/top-1") {
		t.Fatalf("orphan draft FK errors = %v, want exactly the draft error", errs)
	}
}

func TestLoadMappingTable_RejectsStaleAndForeign(t *testing.T) {
	dir := t.TempDir()

	stale := filepath.Join(dir, "stale.json")
	table := &MappingTable{Version: MappingTableVersion, Entries: []MappingEntry{
		{Space: SpaceUser, LegacyID: "uid-1", TargetID: "notWhatWeDerive15"},
	}}
	if err := table.SaveTable(stale); err != nil {
		t.Fatalf("SaveTable: %v", err)
	}
	if _, err := LoadMappingTable(stale); err == nil {
		t.Fatal("a table that disagrees with the derivation rules must be rejected")
	}

	foreign := filepath.Join(dir, "version.json")
	if err := (&MappingTable{Version: 99}).SaveTable(foreign); err != nil {
		t.Fatalf("SaveTable: %v", err)
	}
	if _, err := LoadMappingTable(foreign); err == nil {
		t.Fatal("an unknown mapping table version must be rejected")
	}

	if _, err := LoadMappingTable(filepath.Join(dir, "missing.json")); err == nil {
		t.Fatal("a missing checkpoint must be an error, not an empty table")
	}
}
