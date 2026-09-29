package pocketbase

// Tests for the character-avatar writer (ImportCharacterAvatars in
// avatar_import.go). They reuse the export-root and PNG/JPEG fixtures from
// avatar_import_test.go so the two imports are provably running the same
// mechanism, and they pin the properties the character cutover depends on:
//
//  1. A character avatar becomes a FILE the character record owns, referenced
//     by a short host-agnostic path (never base64).
//  2. Two characters may legitimately share ONE legacy object (the legacy
//     layout stores the owner's default character avatar at
//     users/<uid>/characters/avatar). The import must copy it to each row
//     rather than assume one object per character.
//  3. A dry run writes nothing and a re-run is a no-op.
//  4. A character whose owner_id does not resolve is reported, not silently
//     mislabelled.

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

// legacyCharacterAvatarURL builds the legacy URL for a character avatar object
// addressed by the FULL object path. The legacy layout uses several shapes:
// users/<uid>/characters/avatar, users/<uid>/characters/<cid>_avatar and
// users/<uid>/characters/new_avatar.
func legacyCharacterAvatarURL(objectPath string) string {
	encoded := strings.Join(strings.Split(objectPath, "/"), "%2F")
	return "https://firebasestorage.googleapis.com/v0/b/aerun-forum.firebasestorage.app/o/" +
		encoded + "?alt=media&token=9d7a911e-f50f-43fa-bada-2ffd5b9c6124"
}

// characterExportRoot writes a miniature export whose objects are addressed by
// full object path (not just a uid), because character avatars are not stored
// under users/<uid>/avatar.
func characterExportRoot(t *testing.T, objects map[string][]byte) string {
	t.Helper()
	root := t.TempDir()
	type manifestEntry struct {
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		MD5Hash  string `json:"md5Hash"`
		Verified bool   `json:"md5Verified"`
	}
	files := make([]manifestEntry, 0, len(objects))
	for objectPath, data := range objects {
		full := filepath.Join(root, "storage", filepath.FromSlash(objectPath))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			t.Fatal(err)
		}
		sum := md5.Sum(data)
		files = append(files, manifestEntry{
			Name:     objectPath,
			Size:     int64(len(data)),
			MD5Hash:  base64.StdEncoding.EncodeToString(sum[:]),
			Verified: true,
		})
	}
	raw, err := json.Marshal(map[string]any{"files": files})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "storage-manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// seedCharacter inserts a characters row owned by ownerID.
func seedCharacter(t *testing.T, app core.App, ownerID, name, avatarURL string) *core.Record {
	t.Helper()
	col, err := app.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(col)
	record.Set("owner_id", ownerID)
	record.Set("name", name)
	record.Set("avatar_url", avatarURL)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func TestImportCharacterAvatars_MovesLegacyObjectIntoRecordFile(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")
	objectPath := "users/fb-owner/characters/char1_avatar"
	seedCharacter(t, app, owner.Id, "Rough", legacyCharacterAvatarURL(objectPath))
	root := characterExportRoot(t, map[string][]byte{objectPath: pngBytes})

	report, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 1 || report.Linked[0] != "Owner / Rough" {
		t.Fatalf("linked = %v, want the owner-qualified label", report.Linked)
	}
	if report.VerifiedMD5 != 1 {
		t.Fatalf("verified md5 = %d, want 1", report.VerifiedMD5)
	}
	if len(report.Skipped) != 0 || len(report.NoOwner) != 0 {
		t.Fatalf("unexpected findings: skipped=%v no_owner=%v", report.Skipped, report.NoOwner)
	}

	chars, err := app.FindAllRecords(charactersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if got := chars[0].GetString(avatarFieldName); got == "" {
		t.Error("characters.avatar must hold a stored file after an import")
	}
	url := chars[0].GetString(avatarURLFieldName)
	if !strings.HasPrefix(url, "/api/files/") {
		t.Errorf("avatar_url = %q, want a host-agnostic /api/files path", url)
	}
	if len(url) > 512 {
		t.Errorf("avatar_url is %d characters; the column caps at 512", len(url))
	}
}

// TestImportCharacterAvatars_SharesOneObjectAcrossCharacters pins the legacy
// layout quirk: several characters point at the owner's single
// characters/avatar object, and each must end up with its own file rather than
// the first row winning and the rest pointing at nothing.
func TestImportCharacterAvatars_SharesOneObjectAcrossCharacters(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")
	objectPath := "users/fb-owner/characters/avatar"
	shared := legacyCharacterAvatarURL(objectPath)
	seedCharacter(t, app, owner.Id, "Kyle Haze", shared)
	seedCharacter(t, app, owner.Id, "Asterix", shared)
	root := characterExportRoot(t, map[string][]byte{objectPath: jpegBytes})

	report, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 2 {
		t.Fatalf("linked = %v, want both characters", report.Linked)
	}

	chars, err := app.FindAllRecords(charactersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, char := range chars {
		file := char.GetString(avatarFieldName)
		if file == "" {
			t.Errorf("character %q got no file", char.GetString("name"))
			continue
		}
		if seen[file] {
			t.Errorf("two characters share the stored file %q; each must own its own", file)
		}
		seen[file] = true
		if url := char.GetString(avatarURLFieldName); !strings.Contains(url, char.Id) {
			t.Errorf("avatar_url %q does not address the character record %q", url, char.Id)
		}
	}
}

func TestImportCharacterAvatars_DryRunThenIdempotent(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")
	objectPath := "users/fb-owner/characters/char1_avatar"
	seedCharacter(t, app, owner.Id, "Rough", legacyCharacterAvatarURL(objectPath))
	root := characterExportRoot(t, map[string][]byte{objectPath: pngBytes})

	dry, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(dry.Linked) != 1 {
		t.Fatalf("dry run linked = %v, want the character reported as pending", dry.Linked)
	}
	chars, _ := app.FindAllRecords(charactersCollectionName)
	if chars[0].GetString(avatarFieldName) != "" {
		t.Error("a dry run must not store a file")
	}

	real, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(real.Linked) != 1 {
		t.Fatalf("real run linked = %v, want 1", real.Linked)
	}

	again, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if again.Changed() {
		t.Errorf("second run changed %d characters; the import is not idempotent", len(again.Linked))
	}
	if len(again.Unchanged) != 1 {
		t.Errorf("second run unchanged = %v, want the character reported unchanged", again.Unchanged)
	}
}

// TestImportCharacterAvatars_ReportsUnresolvedOwner pins that a character whose
// owner_id matches no account is counted rather than reported under a blank
// label — a report line a reviewer can act on.
func TestImportCharacterAvatars_ReportsUnresolvedOwner(t *testing.T) {
	app := migratedApp(t)
	objectPath := "users/fb-gone/characters/char1_avatar"
	seedCharacter(t, app, "nobodyhere000001", "Orphan", legacyCharacterAvatarURL(objectPath))
	root := characterExportRoot(t, map[string][]byte{objectPath: pngBytes})

	report, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.NoOwner) != 1 || report.NoOwner[0] != "Orphan" {
		t.Fatalf("no_owner = %v, want the orphan character named", report.NoOwner)
	}
	// The file is still importable: the avatar belongs to the character, not to
	// the owner lookup, so a missing owner must not block the write.
	if len(report.Linked) != 1 {
		t.Errorf("linked = %v, want the orphan's avatar still imported", report.Linked)
	}
}

// TestImportCharacterAvatars_SkipsExternalAndEmpty pins that a DiceBear or
// third-party avatar is left alone with a reason rather than being copied.
func TestImportCharacterAvatars_SkipsExternalAndEmpty(t *testing.T) {
	app := migratedApp(t)
	owner := seedAvatarUser(t, app, "fb-owner", "Owner", "")
	seedCharacter(t, app, owner.Id, "Dice", "https://api.dicebear.com/9.x/initials/svg?seed=Dice")
	seedCharacter(t, app, owner.Id, "None", "")

	report, err := ImportCharacterAvatars(app, AvatarImportOptions{StorageDir: characterExportRoot(t, nil)})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 0 {
		t.Errorf("linked = %v, want nothing imported", report.Linked)
	}
	if len(report.Skipped) != 2 {
		t.Fatalf("skipped = %v, want both characters reported with a reason", report.Skipped)
	}
	for _, skip := range report.Skipped {
		if skip.Reason == "" {
			t.Errorf("skip %q has no reason", skip.Nickname)
		}
	}
}
