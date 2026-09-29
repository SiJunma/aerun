package pocketbase

// Characters import (Sprint 7 writer, level L4).
//
// The third writer of the migration, after the role registry and the accounts.
// It lives in the platform adapter for the same reason: it is the only package
// allowed to import PocketBase, and the rules it encodes are properties of the
// target schema.
//
// Decisions, each of them visible to the caller:
//
//   - **The upsert key is the derived id.** Every write is keyed by
//     DeriveID(SpaceCharacter, "uid/characters/cid"), which the caller already
//     computed. A re-run against a fresher dump therefore converges on the same
//     rows instead of duplicating them, and a character id referenced by an
//     already-imported post keeps pointing at the right record — the property
//     the whole cutover depends on, since a duplicated identity would silently
//     re-parent the forum's history.
//   - **The owner must already exist.** owner_id is validated against the users
//     collection inside the same transaction that writes the character, so a
//     dangling owner is impossible even if the plan and the database disagree.
//   - **Historical dates are preserved** through SetRaw: created_at / updated_at
//     are plain datetime fields (1766600000), so they can be rewritten, and
//     SetRaw is the only way to leave a manually assigned date alone.
//   - **The avatar is NOT touched here.** avatar_url is imported as the legacy
//     URL and repaired afterwards by ImportCharacterAvatars, which is the same
//     two-step the account import uses. Doing the bytes here would make one
//     command own two concerns.
//   - A row present in the target but absent from the batch is reported, never
//     deleted: deletion is a separate, human-approved decision.

import (
	"fmt"
	"sort"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// CharacterUpsert is the desired state of one characters row, expressed in the
// platform package's own types (the tool imports the platform, never the
// reverse).
type CharacterUpsert struct {
	// TargetID is the derived PocketBase id — the upsert key.
	TargetID string
	// OwnerID is the owner's users row id.
	OwnerID string
	// Name is the display name (characters.name is Required).
	Name       string
	StatusLine string
	Signature  string
	// AvatarURL is the legacy URL, repaired later by ImportCharacterAvatars.
	AvatarURL string
	// CreatedAt / UpdatedAt are the historical dates; zero leaves "now".
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CharacterImportReport states what the import changed, so a rehearsal can
// prove idempotency by comparing two reports.
type CharacterImportReport struct {
	// Created, Updated and Unchanged hold target ids, sorted, so two reports
	// diff cleanly.
	Created   []string
	Updated   []string
	Unchanged []string
	// ExtraTargetIDs are imported rows present in the target but absent from
	// this batch. They are never deleted here; they are reported.
	ExtraTargetIDs []string
}

// Changed reports whether the import modified anything.
func (r CharacterImportReport) Changed() bool {
	return len(r.Created) > 0 || len(r.Updated) > 0
}

// ImportCharacters makes the characters collection match upserts exactly.
//
// The batch is validated before the transaction opens: a duplicate id or an
// empty name would otherwise fail halfway through, and a half-imported
// character list is not a state anyone can reason about.
func ImportCharacters(app core.App, upserts []CharacterUpsert) (CharacterImportReport, error) {
	report := CharacterImportReport{}
	if len(upserts) == 0 {
		return report, nil
	}
	if err := validateCharacterUpserts(upserts); err != nil {
		return report, err
	}

	col, err := app.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		return report, fmt.Errorf("characters collection unavailable: %w", err)
	}

	wanted := make(map[string]CharacterUpsert, len(upserts))
	ids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	err = app.RunInTransaction(func(txApp core.App) error {
		existing := make(map[string]*core.Record)
		rows, err := txApp.FindAllRecords(col, nil)
		if err != nil {
			return fmt.Errorf("read characters: %w", err)
		}
		for _, rec := range rows {
			existing[rec.Id] = rec
		}

		for _, id := range ids {
			u := wanted[id]

			owner, err := txApp.FindRecordById(usersCollectionName, u.OwnerID)
			if err != nil || owner == nil {
				return fmt.Errorf(
					"character %s: owner %q has no users row; import the accounts first", id, u.OwnerID)
			}

			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", id)
				applyCharacterUpsert(rec, u)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create character %s: %w", id, err)
				}
				report.Created = append(report.Created, id)
				continue
			}
			// The comparison happens on the untouched record: applying the
			// upsert would overwrite the very values being compared and every
			// run would report a change.
			if characterRecordMatches(rec, u) {
				report.Unchanged = append(report.Unchanged, id)
				continue
			}
			applyCharacterUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update character %s: %w", id, err)
			}
			report.Updated = append(report.Updated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraTargetIDs = append(report.ExtraTargetIDs, id)
			}
		}
		sort.Strings(report.ExtraTargetIDs)
		return nil
	})
	if err != nil {
		return CharacterImportReport{}, err
	}

	sort.Strings(report.Created)
	sort.Strings(report.Updated)
	sort.Strings(report.Unchanged)
	return report, nil
}

// applyCharacterUpsert writes the desired state onto a record.
func applyCharacterUpsert(rec *core.Record, u CharacterUpsert) {
	rec.Set("owner_id", u.OwnerID)
	rec.Set("name", u.Name)
	rec.Set("status_line", u.StatusLine)
	rec.Set("signature", u.Signature)
	rec.Set("avatar_url", avatarURLToWrite(rec, u.AvatarURL))
	// SetRaw, not Set: these are historical dates the import must be able to
	// write, and a typed Set is what PocketBase's date handling rewrites. The
	// same approach the account import uses for `created`.
	if !u.CreatedAt.IsZero() {
		if created, err := types.ParseDateTime(u.CreatedAt); err == nil {
			rec.SetRaw("created_at", created)
		}
	}
	if !u.UpdatedAt.IsZero() {
		if updated, err := types.ParseDateTime(u.UpdatedAt); err == nil {
			rec.SetRaw("updated_at", updated)
		}
	}
}

// characterRecordMatches reports whether rec already holds the desired state.
func characterRecordMatches(rec *core.Record, u CharacterUpsert) bool {
	return rec.GetString("owner_id") == u.OwnerID &&
		rec.GetString("name") == u.Name &&
		rec.GetString("status_line") == u.StatusLine &&
		rec.GetString("signature") == u.Signature &&
		rec.GetString("avatar_url") == avatarURLToWrite(rec, u.AvatarURL) &&
		datesMatch(rec, "created_at", u.CreatedAt) &&
		datesMatch(rec, "updated_at", u.UpdatedAt)
}

// datesMatch compares a stored date field with a wanted date, treating "unset"
// as a wildcard: a row that never had a historical date keeps PocketBase's own
// timestamp, and re-running the import must not churn it into a zero date.
func datesMatch(rec *core.Record, field string, want time.Time) bool {
	if want.IsZero() {
		return true
	}
	return rec.GetDateTime(field).Time().UTC().Equal(want.UTC())
}

// validateCharacterUpserts rejects a batch that cannot be written cleanly.
func validateCharacterUpserts(upserts []CharacterUpsert) error {
	seen := make(map[string]bool, len(upserts))
	for _, u := range upserts {
		if u.TargetID == "" {
			return fmt.Errorf("character upsert without a target id")
		}
		if seen[u.TargetID] {
			return fmt.Errorf("duplicate character target id %q", u.TargetID)
		}
		seen[u.TargetID] = true
		if u.OwnerID == "" {
			return fmt.Errorf("character %s: owner_id is required", u.TargetID)
		}
		if u.Name == "" {
			return fmt.Errorf("character %s: name is required", u.TargetID)
		}
	}
	return nil
}
