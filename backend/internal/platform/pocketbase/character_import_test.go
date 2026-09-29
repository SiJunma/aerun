package pocketbase

// Tests for the characters writer (character_import.go). The properties that
// matter for a repeatable migration are all about re-runs: a second run against
// the same dump must change nothing, and a run against a FRESHER dump — which
// is what release day does — must update the same rows rather than duplicating
// them. A duplicated character id would silently re-parent the forum's history
// once posts start referencing it.

import (
	"strings"
	"testing"
	"time"
)

func TestImportCharacters_CreatesThenIsIdempotent(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")

	upserts := []CharacterUpsert{{
		TargetID:   "charrow00000000",
		OwnerID:    owner.Id,
		Name:       "Rough",
		StatusLine: "PD",
		Signature:  "a signature",
		AvatarURL:  legacyCharacterAvatarURL("users/fb-owner/characters/char1_avatar"),
	}}

	first, err := ImportCharacters(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Created) != 1 || len(first.Updated) != 0 {
		t.Fatalf("first run created=%v updated=%v, want one create", first.Created, first.Updated)
	}

	second, err := ImportCharacters(app, upserts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("second run changed %d characters; the writer is not idempotent", len(second.Updated))
	}
	if len(second.Unchanged) != 1 {
		t.Errorf("second run unchanged = %v, want the character reported unchanged", second.Unchanged)
	}
}

// TestImportCharacters_UpdatesInPlace pins that a fresher dump updates the SAME
// row id rather than creating a second one.
func TestImportCharacters_UpdatesInPlace(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")

	base := CharacterUpsert{TargetID: "charrow00000000", OwnerID: owner.Id, Name: "Rough"}
	if _, err := ImportCharacters(app, []CharacterUpsert{base}); err != nil {
		t.Fatal(err)
	}

	changed := base
	changed.Name = "Rough v2"
	changed.StatusLine = "busy"
	report, err := ImportCharacters(app, []CharacterUpsert{changed})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Updated) != 1 || len(report.Created) != 0 {
		t.Fatalf("updated=%v created=%v, want one update and no create", report.Updated, report.Created)
	}

	all, err := app.FindAllRecords(charactersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("collection holds %d characters; a re-run must not duplicate", len(all))
	}
	if all[0].GetString("name") != "Rough v2" || all[0].GetString("status_line") != "busy" {
		t.Errorf("row not updated: name=%q status_line=%q",
			all[0].GetString("name"), all[0].GetString("status_line"))
	}
}

// TestImportCharacters_RejectsMissingOwner proves a character can never be
// written with a dangling owner, even if the plan and the database disagree.
func TestImportCharacters_RejectsMissingOwner(t *testing.T) {
	app := migratedApp(t)

	_, err := ImportCharacters(app, []CharacterUpsert{{
		TargetID: "charrow00000000",
		OwnerID:  "nosuchowner0001",
		Name:     "Orphan",
	}})
	if err == nil {
		t.Fatal("a character whose owner is missing must be refused")
	}
	all, err := app.FindAllRecords(charactersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Errorf("a refused batch wrote %d characters; the transaction must roll back", len(all))
	}
}

// TestImportCharacters_PreservesMigratedAvatar is the regression guard for a bug
// this import actually had: the storage pass rewrites avatar_url into a
// /api/files path, and re-running the row importer then wrote the legacy URL
// back over it — so the next avatar pass re-imported files it already had. On
// release day that turns every re-run into seven rewrites and a fresh random
// file name each time.
func TestImportCharacters_PreservesMigratedAvatar(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")

	objectPath := "users/fb-owner/characters/char1_avatar"
	base := CharacterUpsert{
		TargetID:  "charrow00000000",
		OwnerID:   owner.Id,
		Name:      "Rough",
		AvatarURL: legacyCharacterAvatarURL(objectPath),
	}
	if _, err := ImportCharacters(app, []CharacterUpsert{base}); err != nil {
		t.Fatal(err)
	}

	// The storage pass takes ownership of the field.
	avatars, err := ImportCharacterAvatars(app, AvatarImportOptions{
		StorageDir: characterExportRoot(t, map[string][]byte{objectPath: pngBytes}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(avatars.Linked) != 1 {
		t.Fatalf("avatar import linked = %v, want the avatar stored", avatars.Linked)
	}

	// A later row import must leave it alone.
	second, err := ImportCharacters(app, []CharacterUpsert{base})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() {
		t.Errorf("a re-run rewrote %d characters; the migrated avatar was reverted", len(second.Updated))
	}

	rec, err := app.FindRecordById(charactersCollectionName, base.TargetID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rec.GetString(avatarURLFieldName), migratedAvatarPrefix) {
		t.Errorf("avatar_url = %q, want the migrated /api/files path to have survived",
			rec.GetString(avatarURLFieldName))
	}
}

// TestImportCharacters_PreservesHistoricalDates pins that the legacy dates
// survive: characters.created_at is a plain datetime field, not autodate.
func TestImportCharacters_PreservesHistoricalDates(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")

	created := time.Date(2026, 5, 4, 12, 0, 0, 0, time.UTC)
	updated := time.Date(2026, 6, 1, 9, 30, 0, 0, time.UTC)
	if _, err := ImportCharacters(app, []CharacterUpsert{{
		TargetID:  "charrow00000000",
		OwnerID:   owner.Id,
		Name:      "Rough",
		CreatedAt: created,
		UpdatedAt: updated,
	}}); err != nil {
		t.Fatal(err)
	}

	rec, err := app.FindRecordById(charactersCollectionName, "charrow00000000")
	if err != nil {
		t.Fatal(err)
	}
	if got := rec.GetDateTime("created_at").Time().UTC(); !got.Equal(created) {
		t.Errorf("created_at = %s, want %s", got, created)
	}
	if got := rec.GetDateTime("updated_at").Time().UTC(); !got.Equal(updated) {
		t.Errorf("updated_at = %s, want %s", got, updated)
	}
}

// TestImportCharacters_ReportsExtraRows pins that a row absent from the batch
// is reported and never deleted.
func TestImportCharacters_ReportsExtraRows(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")
	if _, err := ImportCharacters(app, []CharacterUpsert{
		{TargetID: "charrow00000000", OwnerID: owner.Id, Name: "A"},
		{TargetID: "charrow00000001", OwnerID: owner.Id, Name: "B"},
	}); err != nil {
		t.Fatal(err)
	}

	report, err := ImportCharacters(app, []CharacterUpsert{
		{TargetID: "charrow00000000", OwnerID: owner.Id, Name: "A"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.ExtraTargetIDs) != 1 || report.ExtraTargetIDs[0] != "charrow00000001" {
		t.Fatalf("extra = %v, want the absent row reported", report.ExtraTargetIDs)
	}
	if _, err := app.FindRecordById(charactersCollectionName, "charrow00000001"); err != nil {
		t.Error("a reported extra row must still exist; the import never deletes")
	}
}

// TestImportCharacters_ValidatesBatch pins that a batch which cannot be written
// cleanly is refused before the transaction opens.
func TestImportCharacters_ValidatesBatch(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")

	cases := []struct {
		name    string
		upserts []CharacterUpsert
	}{
		{
			name: "duplicate id",
			upserts: []CharacterUpsert{
				{TargetID: "charrow00000000", OwnerID: owner.Id, Name: "A"},
				{TargetID: "charrow00000000", OwnerID: owner.Id, Name: "B"},
			},
		},
		{name: "empty name", upserts: []CharacterUpsert{{TargetID: "charrow00000000", OwnerID: owner.Id}}},
		{name: "empty owner", upserts: []CharacterUpsert{{TargetID: "charrow00000000", Name: "A"}}},
		{name: "empty id", upserts: []CharacterUpsert{{OwnerID: owner.Id, Name: "A"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ImportCharacters(app, tc.upserts); err == nil {
				t.Fatal("an unwritable batch must be refused")
			}
		})
	}
}
