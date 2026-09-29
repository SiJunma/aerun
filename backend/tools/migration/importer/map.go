package importer

// Deterministic legacy -> PocketBase id mapping (Sprint 7 task 2).
//
// Only the `users` collection has a place to remember where a row came from
// (`legacy_firebase_uid`). Every other target collection stores relations as
// plain `TextField{Max: 15}` columns holding a PocketBase record id, so a
// 20/28-character Firestore document id cannot be reused verbatim, and a
// random id would make re-runs create duplicates.
//
// Import idempotency therefore rests on *derived* ids: a target id is a pure
// function of (collection space, legacy id). Re-running an import recomputes
// the same id, so every row is addressed in place instead of duplicated, and
// the mapping table is a checkpoint that can be diffed across rehearsals or
// resumed after an interruption.
//
// The table is also the audit artefact that answers "which legacy document is
// this row?" after cutover, which is why it is written to disk rather than
// kept in memory.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

const (
	// pbIDLength mirrors the length PocketBase generates for record ids.
	pbIDLength = 15
	// pbIDAlphabet is PocketBase's *record id* alphabet. v0.40.4 generates ids
	// from core/db.go DefaultIdAlphabet and validates every collection's id
	// field against core/collection_model.go defaultLowercaseRecordIdPattern
	// ("^[a-z0-9]+$", Min/Max 15): uppercase letters are rejected with
	// "id: Invalid value format." Older PocketBase releases accepted a
	// 62-character alphabet for ids, but nothing does any more, so an id
	// outside this set can never be written.
	pbIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	// keySeparator delimits the space from the legacy id inside a map key.
	// It cannot appear in a Firestore document id or collection name.
	keySeparator = "\x1f"
	// MappingTableVersion is the on-disk schema version.
	//
	// v2 corrected pbIDAlphabet to PocketBase's lowercase record id alphabet:
	// version 1 derived 62-character-alphabet ids whose uppercase letters the
	// target schema rejects, so every table written by an earlier rehearsal is
	// refused on load instead of being silently reused with unusable ids.
	MappingTableVersion = 2
)

// IDSpace namespaces a legacy id so the same id string in two different
// collections (or an id used as both a topic and a post) cannot derive the
// same target id.
type IDSpace string

// One space per legacy collection the importer understands.
const (
	SpaceUser          IDSpace = "user"
	SpaceCategoryGroup IDSpace = "category_group"
	SpaceCategory      IDSpace = "category"
	SpaceTopic         IDSpace = "topic"
	SpacePost          IDSpace = "post"
	SpaceSubscription  IDSpace = "subscription"
	SpaceReputationLog IDSpace = "reputation_log"
	SpaceAuditLog      IDSpace = "audit_log"
	SpaceNotification  IDSpace = "notification"
	SpaceDM            IDSpace = "dm"
	SpaceDMMessage     IDSpace = "dm_message"
	SpaceDMMember      IDSpace = "dm_member"
	SpaceRole          IDSpace = "role"
)

// DeriveID maps (space, legacyID) onto a 15 character [a-z0-9] id — the exact
// format the target schema's id field validates (see pbIDAlphabet).
//
// The result is stable across processes, machines and Go versions because it
// depends only on SHA-256 and the constants above. Taking digest bytes modulo
// len(alphabet) is slightly biased (256 is not a multiple of 36); that is
// irrelevant here, since the digest is a deterministic seed, not entropy.
func DeriveID(space IDSpace, legacyID string) string {
	sum := sha256.Sum256([]byte(string(space) + keySeparator + legacyID))
	out := make([]byte, pbIDLength)
	for i := range out {
		out[i] = pbIDAlphabet[sum[i]%byte(len(pbIDAlphabet))]
	}
	return string(out)
}

func mapKey(space IDSpace, legacyID string) string {
	return string(space) + keySeparator + legacyID
}

// MappingEntry is one row of the per-record mapping table.
type MappingEntry struct {
	Space    IDSpace `json:"space"`
	LegacyID string  `json:"legacyId"`
	TargetID string  `json:"targetId"`
}

// MappingTable is the canonical, persisted form of Mappings. Entries are kept
// sorted by (space, legacyId) so two runs over the same export write
// byte-identical files and the diff of two rehearsals is meaningful.
type MappingTable struct {
	Version   int            `json:"version"`
	ProjectID string         `json:"projectId,omitempty"`
	Entries   []MappingEntry `json:"entries"`
}

// Mappings is the bidirectional in-memory view used while building records.
type Mappings struct {
	forward map[string]string       // space+sep+legacyId -> targetId
	owner   map[string]MappingEntry // targetId -> producing entry
	entries map[string]MappingEntry // space+sep+legacyId -> entry
}

// NewMappings returns an empty mapping table.
func NewMappings() *Mappings {
	return &Mappings{
		forward: make(map[string]string),
		owner:   make(map[string]MappingEntry),
		entries: make(map[string]MappingEntry),
	}
}

// Add registers legacyID under space and returns its target id. Adding the
// same pair twice is a no-op (that is what makes re-runs safe); two *different*
// pairs that derive the same id are a hash collision and abort the import,
// because silently picking one would lose a record.
func (m *Mappings) Add(space IDSpace, legacyID string) (string, error) {
	if legacyID == "" {
		return "", fmt.Errorf("mapping %s: empty legacy id", space)
	}
	key := mapKey(space, legacyID)
	if existing, ok := m.forward[key]; ok {
		return existing, nil
	}
	target := DeriveID(space, legacyID)
	if prev, clash := m.owner[target]; clash {
		return "", fmt.Errorf(
			"derived id %q collides between %s/%s and %s/%s: import must stop before writing",
			target, prev.Space, prev.LegacyID, space, legacyID)
	}
	entry := MappingEntry{Space: space, LegacyID: legacyID, TargetID: target}
	m.forward[key] = target
	m.owner[target] = entry
	m.entries[key] = entry
	return target, nil
}

// Target returns the target id previously registered for (space, legacyID).
func (m *Mappings) Target(space IDSpace, legacyID string) (string, bool) {
	if legacyID == "" {
		return "", false
	}
	target, ok := m.forward[mapKey(space, legacyID)]
	return target, ok
}

// Len reports how many records are mapped.
func (m *Mappings) Len() int { return len(m.entries) }

// Entries returns the table rows in canonical order.
func (m *Mappings) Entries() []MappingEntry {
	out := make([]MappingEntry, 0, len(m.entries))
	for _, e := range m.entries {
		out = append(out, e)
	}
	sortMappingEntries(out)
	return out
}

func sortMappingEntries(entries []MappingEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Space != entries[j].Space {
			return entries[i].Space < entries[j].Space
		}
		return entries[i].LegacyID < entries[j].LegacyID
	})
}

// BuildMappings registers every durable record in the plan. Iteration is
// sorted so that a derived collision is always reported for the same pair
// instead of depending on Go map order.
func BuildMappings(plan *ImportPlan, projectID string) (*Mappings, error) {
	m := NewMappings()

	// Users is the only bucket whose keys can hold a composite path: user
	// subcollection rows (characters) are parked there by the classifier and
	// are folded into the parent user at write time, not mapped as records.
	// Every other bucket keys records by its natural Firestore path, slashes
	// included (dm messages are "conv/messages/msg").
	register := func(space IDSpace, bucket map[string]map[string]any, skipComposite bool) error {
		for _, id := range sortedKeys(bucket) {
			if skipComposite && containsSlash(id) {
				continue
			}
			if _, err := m.Add(space, id); err != nil {
				return err
			}
		}
		return nil
	}

	for _, step := range []struct {
		space         IDSpace
		bucket        map[string]map[string]any
		skipComposite bool
	}{
		{SpaceUser, plan.Users, true},
		{SpaceCategoryGroup, plan.CategoryGroups, false},
		{SpaceCategory, plan.Categories, false},
		{SpaceTopic, plan.Topics, false},
		{SpacePost, plan.Posts, false},
		// Drafts become posts with is_draft=true; their legacy id is the
		// composite "uid/drafts/topic_id", so they never collide with a real
		// post id in the same space.
		{SpacePost, plan.Drafts, false},
		{SpaceSubscription, plan.Subscriptions, false},
		{SpaceReputationLog, plan.ReputationLogs, false},
		{SpaceAuditLog, plan.AuditLogs, false},
		{SpaceNotification, plan.Notifications, false},
		{SpaceDM, plan.DMs, false},
		{SpaceDMMessage, plan.DMMessages, false},
		{SpaceRole, plan.Roles, false},
	} {
		if err := register(step.space, step.bucket, step.skipComposite); err != nil {
			return nil, err
		}
	}

	// dm_members rows do not exist in the source: they are derived from
	// dms.participants. Register them under their own space so their ids are
	// stable too.
	for _, convID := range sortedKeys(plan.DMs) {
		for _, uid := range stringSliceField(plan.DMs[convID], "participants") {
			if _, err := m.Add(SpaceDMMember, convID+"/"+uid); err != nil {
				return nil, err
			}
		}
	}

	return m, nil
}

// Table snapshots the mappings for persistence.
func (m *Mappings) Table(projectID string) *MappingTable {
	return &MappingTable{
		Version:   MappingTableVersion,
		ProjectID: projectID,
		Entries:   m.Entries(),
	}
}

// SaveTable writes the mapping table, refusing to overwrite an existing file —
// the same exclusive-creation discipline the Node.js staging pipeline uses, so
// a checkpoint from an earlier rehearsal can never be clobbered.
func (t *MappingTable) SaveTable(path string) error {
	if t.Version == 0 {
		t.Version = MappingTableVersion
	}
	sortMappingEntries(t.Entries)
	payload, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return fmt.Errorf("encode mapping table: %w", err)
	}
	payload = append(payload, '\n')

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create mapping table: %w", err)
	}
	if _, err := file.Write(payload); err != nil {
		file.Close()
		return fmt.Errorf("write mapping table: %w", err)
	}
	return file.Close()
}

// LoadMappingTable reads a checkpoint and rebuilds the lookup maps, rejecting a
// file that would introduce a duplicate target id or that disagrees with the
// current derivation rules.
func LoadMappingTable(path string) (*Mappings, error) {
	table, err := LoadTable(path)
	if err != nil {
		return nil, err
	}
	if table.Version != MappingTableVersion {
		return nil, fmt.Errorf("unsupported mapping table version: %d", table.Version)
	}
	m := NewMappings()
	for _, e := range table.Entries {
		if _, err := m.Add(e.Space, e.LegacyID); err != nil {
			return nil, err
		}
		if got := m.forward[mapKey(e.Space, e.LegacyID)]; got != e.TargetID {
			return nil, fmt.Errorf(
				"mapping table %s/%s is stale: recorded %q, recomputed %q",
				e.Space, e.LegacyID, e.TargetID, got)
		}
	}
	return m, nil
}

// LoadTable returns the persisted rows of a mapping table file.
func LoadTable(path string) (*MappingTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read mapping table: %w", err)
	}
	var table MappingTable
	if err := json.Unmarshal(data, &table); err != nil {
		return nil, fmt.Errorf("parse mapping table: %w", err)
	}
	return &table, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func containsSlash(id string) bool {
	for i := 0; i < len(id); i++ {
		if id[i] == '/' {
			return true
		}
	}
	return false
}

// stringSliceField reads a legacy array-of-strings field, e.g. participants.
func stringSliceField(m map[string]any, key string) []string {
	list, ok := m[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}
