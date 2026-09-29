package importer

// Legacy characters -> target characters rows (Sprint 7 writer, level L4 of
// the dependency map in POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §5).
//
// A character is a row, not a settings blob. The analysis stage folded the nine
// legacy `users/{uid}/characters/{cid}` documents into users.settings as a
// stopgap; migration 1766600000 retracted that because topics and posts
// reference characters by id, and this writer is what makes those references
// resolvable. It runs after the users import, since owner_id points at a
// users row.
//
// The rules that shape the translation:
//
//  1. **The composite legacy path is the identity.** A character id is unique
//     only inside its owner's subcollection, so the key is "uid/characters/cid"
//     and the target id is DeriveID(SpaceCharacter, key). Deriving from the
//     path (not from the name) means a re-run against a fresher dump produces
//     the SAME ids, which is what keeps a second migration run idempotent and
//     keeps already-imported posts pointing at the right character.
//  2. **The owner must exist.** owner_id is written as the owner's derived
//     target id; a character whose owner was dropped is reported and skipped
//     rather than written with a dangling owner.
//  3. **The avatar URL is imported as-is** and repaired afterwards by
//     import-avatars -scope characters, exactly like the user avatars: the
//     legacy URL stays until the storage half turns it into a real file plus a
//     host-agnostic /api/files path.
//  4. **Historical dates are preserved.** characters.created_at / updated_at
//     are plain datetime fields (1766600000), not autodate, so a legacy date
//     survives the import. A zero value leaves PocketBase's "now" rather than
//     writing a zero date.

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// CharacterRow is the target state of one characters row.
type CharacterRow struct {
	// LegacyKey is the composite "uid/characters/cid" path: the upsert key and
	// the DeriveID input.
	LegacyKey string
	// OwnerUID and CharacterCID are the two halves of LegacyKey, kept so the
	// report can name a row the way the legacy dump did.
	OwnerUID     string
	CharacterCID string
	// TargetID is DeriveID(SpaceCharacter, LegacyKey).
	TargetID string
	// OwnerID is the owner's derived target id (DeriveID(SpaceUser, OwnerUID)).
	OwnerID string
	// Name is the display name; the uniqueness constraint is per owner, so two
	// owners may both have a character called the same thing.
	Name       string
	StatusLine string
	Signature  string
	AvatarURL  string
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Findings   map[string]string
}

// note records a finding for this row.
func (r *CharacterRow) note(code, detail string) {
	if r.Findings == nil {
		r.Findings = make(map[string]string, 2)
	}
	r.Findings[code] = detail
}

// CharacterPlan is the full result of planning the characters import.
type CharacterPlan struct {
	// Rows are the characters to write, sorted by legacy key.
	Rows []CharacterRow
	// Findings explains every non-trivial decision, aggregated per code.
	Findings map[string]*Finding
	// SkippedKeys are legacy characters that cannot become a row (no owner, or
	// no name). They are reported, never invented.
	SkippedKeys []string
}

// BuildCharacterPlan translates every legacy character document into a target
// row.
//
// ownerExists reports whether an account was imported for a legacy uid. It is
// passed in rather than looked up so this package stays free of the platform
// and the same plan can be rehearsed against a database that does not exist
// yet (which is what -dry-run does).
func BuildCharacterPlan(plan *ImportPlan, ownerExists func(uid string) bool) *CharacterPlan {
	cp := &CharacterPlan{Findings: make(map[string]*Finding)}

	for _, key := range sortedKeys(plan.Characters) {
		fields := plan.Characters[key]

		uid, cid, ok := splitCharacterKey(key)
		if !ok {
			cp.SkippedKeys = append(cp.SkippedKeys, key)
			cp.note("character_key_malformed", key)
			continue
		}
		if !ownerExists(uid) {
			// A character whose owner was dropped has no owner_id to point at.
			// Writing it would create a dangling row the collection cannot
			// validate, so it is reported and left out.
			cp.SkippedKeys = append(cp.SkippedKeys, key)
			cp.note("character_owner_missing", key)
			continue
		}

		name := strings.TrimSpace(stringField(fields, "name"))
		if name == "" {
			// characters.name is Required, so a nameless character cannot be
			// written at all. Reported rather than defaulted to the cid.
			cp.SkippedKeys = append(cp.SkippedKeys, key)
			cp.note("character_name_missing", key)
			continue
		}

		row := CharacterRow{
			LegacyKey:    key,
			OwnerUID:     uid,
			CharacterCID: cid,
			TargetID:     DeriveID(SpaceCharacter, key),
			OwnerID:      DeriveID(SpaceUser, uid),
			Name:         name,
			StatusLine:   stringField(fields, "status_line"),
			Signature:    stringField(fields, "signature"),
			AvatarURL:    stringField(fields, "avatar_url"),
			CreatedAt:    timeField(fields, "created_at"),
			UpdatedAt:    timeField(fields, "updated_at"),
			Findings:     make(map[string]string, 2),
		}
		if isFirebaseStorageURL(row.AvatarURL) {
			// Named so a reviewer can see the avatar is still a legacy bucket
			// reference waiting for the storage half.
			row.note("character_avatar_pending_storage_import", row.AvatarURL)
		}
		cp.Rows = append(cp.Rows, row)
	}

	sort.Strings(cp.SkippedKeys)
	cp.summarize()
	return cp
}

// note records a plan-level finding.
func (cp *CharacterPlan) note(code, detail string) {
	if existing, ok := cp.Findings[code]; ok {
		existing.Count++
		return
	}
	cp.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
}

// splitCharacterKey splits "uid/characters/cid" into its halves. A character
// uid or cid never contains "/", so a key with the wrong shape is malformed
// rather than merely unexpected.
func splitCharacterKey(key string) (uid, cid string, ok bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[1] != "characters" || parts[0] == "" || parts[2] == "" {
		return "", "", false
	}
	return parts[0], parts[2], true
}

// summarize folds the per-row findings into the plan-level report, so one
// report line explains every affected row.
func (cp *CharacterPlan) summarize() {
	for _, row := range cp.Rows {
		for code, detail := range row.Findings {
			if existing, ok := cp.Findings[code]; ok {
				existing.Count++
				continue
			}
			cp.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
		}
	}
}

// SortedRowLines renders the planned characters as stable one-line summaries,
// sorted so two runs produce byte-identical output.
func (cp *CharacterPlan) SortedRowLines() []string {
	lines := make([]string, 0, len(cp.Rows))
	for _, row := range cp.Rows {
		lines = append(lines, fmt.Sprintf(
			"character %s -> %s owner=%s name=%q avatar=%t",
			row.LegacyKey, row.TargetID, row.OwnerID, row.Name, row.AvatarURL != ""))
	}
	sort.Strings(lines)
	return lines
}

// Selected is the number of characters this run would write.
func (cp *CharacterPlan) Selected() int { return len(cp.Rows) }

// SortedFindingLines renders the plan findings as stable "code: count" lines for
// the CLI report, sorted so two runs produce byte-identical output.
func (cp *CharacterPlan) SortedFindingLines() []string {
	lines := make([]string, 0, len(cp.Findings))
	for code, finding := range cp.Findings {
		lines = append(lines, fmt.Sprintf("%s: %d", code, finding.Count))
	}
	sort.Strings(lines)
	return lines
}
