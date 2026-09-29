package pocketbase

// Tests for the avatar writer (avatar_import.go). They reuse migratedApp from
// role_import_test.go so every case runs against the real target schema,
// including the FileField that migration 1767000000 adds, and they pin the
// three properties the cutover depends on: only the legacy bucket is touched,
// the bytes are verified against the export manifest, and a re-run is a no-op.

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

// pngBytes and jpegBytes are the smallest valid files of each format — the
// importer sniffs the extension from the magic bytes because the legacy object
// name ("users/<uid>/avatar") carries none.
var (
	pngBytes  = append([]byte("\x89PNG\r\n\x1a\n"), []byte(strings.Repeat("a", 64))...)
	jpegBytes = append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, []byte(strings.Repeat("b", 64))...)
)

// legacyAvatarURL builds the kind of URL the import snapshot stores: the
// object path is percent-encoded and the download token is opaque.
func legacyAvatarURL(uid string) string {
	return "https://firebasestorage.googleapis.com/v0/b/aerun-forum.firebasestorage.app/o/" +
		"users%2F" + uid + "%2Favatar?alt=media&token=9d7a911e-f50f-43fa-bada-2ffd5b9c6124"
}

// avatarExportRoot writes a miniature verified export: one object per uid plus
// the manifest recording their md5s, exactly like the Sprint 0 snapshot.
func avatarExportRoot(t *testing.T, objects map[string][]byte) string {
	t.Helper()
	root := t.TempDir()
	type manifestEntry struct {
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		MD5Hash  string `json:"md5Hash"`
		Verified bool   `json:"md5Verified"`
	}
	files := make([]manifestEntry, 0, len(objects))
	for uid, data := range objects {
		dir := filepath.Join(root, "storage", "users", uid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "avatar"), data, 0o644); err != nil {
			t.Fatal(err)
		}
		sum := md5.Sum(data)
		files = append(files, manifestEntry{
			Name:     "users/" + uid + "/avatar",
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

// seedAvatarUser inserts a users row addressed to the legacy uid, with the
// avatar URL the legacy importer would have copied.
func seedAvatarUser(t *testing.T, app core.App, uid, nickname, avatarURL string) *core.Record {
	t.Helper()
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	record := core.NewRecord(users)
	record.SetEmail(strings.ToLower(nickname) + "@example.com")
	record.SetVerified(true)
	record.Set("password", "NotATransferredHash1!")
	record.Set("nickname", nickname)
	record.Set("nickname_normalized", strings.ToLower(nickname))
	record.Set("role", "player")
	record.Set("status", "active")
	record.Set("avatar_url", avatarURL)
	record.Set("legacy_firebase_uid", uid)
	if err := app.Save(record); err != nil {
		t.Fatal(err)
	}
	return record
}

func TestImportUserAvatars_MovesLegacyBucketIntoRecordFiles(t *testing.T) {
	app := migratedApp(t)
	seedAvatarUser(t, app, "fb-owner", "Owner", legacyAvatarURL("fb-owner"))
	seedAvatarUser(t, app, "fb-guest", "Guest", legacyAvatarURL("fb-guest"))
	root := avatarExportRoot(t, map[string][]byte{"fb-owner": pngBytes, "fb-guest": jpegBytes})

	report, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 2 || report.Linked[0] != "Guest" || report.Linked[1] != "Owner" {
		t.Fatalf("linked = %v, want both accounts sorted by nickname", report.Linked)
	}
	if report.VerifiedMD5 != 2 {
		t.Fatalf("verified md5 = %d, want 2 (every file proven against the manifest)", report.VerifiedMD5)
	}
	if len(report.MismatchMD5) != 0 || len(report.Skipped) != 0 {
		t.Fatalf("unexpected findings: mismatch=%v skipped=%v", report.MismatchMD5, report.Skipped)
	}

	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := app.FindAuthRecordByEmail(usersCollectionName, "owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	stored := owner.GetString("avatar")
	if stored == "" {
		t.Fatal("the owner row must own its avatar file after the import")
	}
	if !strings.HasSuffix(stored, ".png") {
		t.Fatalf("stored name = %q, want a .png sniffed from the bytes", stored)
	}
	wantPath := AvatarFilePath(users.Id, owner.Id, stored)
	if got := owner.GetString("avatar_url"); got != wantPath {
		t.Fatalf("avatar_url = %q, want %q", got, wantPath)
	}
	if !strings.HasPrefix(wantPath, "/api/files/") {
		t.Fatalf("avatar_url must stay host-agnostic, got %q", wantPath)
	}
	// The bytes on disk are the ones from the export, and the stored file sits
	// under PocketBase's own files root
	// (<data_dir>/storage + Record.BaseFilesPath = collection dir + record id).
	onDisk, err := os.ReadFile(filepath.Join(app.DataDir(), core.LocalStorageDirName, owner.BaseFilesPath(), stored))
	if err != nil {
		t.Fatalf("uploaded file must exist under the collection files path: %v", err)
	}
	if string(onDisk) != string(pngBytes) {
		t.Fatal("stored bytes differ from the exported object")
	}
}

func TestImportUserAvatars_LeavesEverythingElseAlone(t *testing.T) {
	app := migratedApp(t)
	seedAvatarUser(t, app, "fb-dice", "Dice", "https://api.dicebear.com/9.x/shapes/svg?seed=Dice")
	seedAvatarUser(t, app, "fb-ig", "Ig", "https://sun9-41.userapi.com/s/v1/ig2/abc.jpg")
	seedAvatarUser(t, app, "fb-none", "None", "")
	seedAvatarUser(t, app, "fb-legacy", "Legacy", legacyAvatarURL("fb-legacy"))

	root := avatarExportRoot(t, map[string][]byte{"fb-legacy": pngBytes})
	report, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 1 || report.Linked[0] != "Legacy" {
		t.Fatalf("linked = %v, want only the legacy object", report.Linked)
	}
	reasons := map[string]string{}
	for _, skip := range report.Skipped {
		reasons[skip.Nickname] = skip.Reason
	}
	if len(reasons) != 3 {
		t.Fatalf("skipped = %v, want three rows left alone", report.Skipped)
	}
	if !strings.Contains(reasons["Dice"], "dicebear") {
		t.Fatalf("dicebear reason = %q", reasons["Dice"])
	}
	if !strings.Contains(reasons["Ig"], "external host") {
		t.Fatalf("instagram reason = %q", reasons["Ig"])
	}
	if !strings.Contains(reasons["None"], "no avatar") {
		t.Fatalf("empty reason = %q", reasons["None"])
	}
	// A third-party URL is reported, never fetched: the row keeps its value.
	ig, err := app.FindAuthRecordByEmail(usersCollectionName, "ig@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if ig.GetString("avatar_url") == "" || ig.GetString("avatar") != "" {
		t.Fatal("a skipped row must keep its URL and gain no file")
	}
}

func TestImportUserAvatars_ReRunIsNoOpAndHealsHalfDoneRow(t *testing.T) {
	app := migratedApp(t)
	seedAvatarUser(t, app, "fb-owner", "Owner", legacyAvatarURL("fb-owner"))
	root := avatarExportRoot(t, map[string][]byte{"fb-owner": pngBytes})

	first, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if !first.Changed() || len(first.Linked) != 1 {
		t.Fatalf("first run = %+v, want one linked row", first)
	}

	second, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if second.Changed() || len(second.Linked) != 0 || len(second.Unchanged) != 1 {
		t.Fatalf("re-run = %+v, want the row reported unchanged", second)
	}

	// A row whose URL was reverted to the legacy object while a file is
	// already attached is re-imported from the export (the export is the
	// authority) instead of being skipped as already done.
	users, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := app.FindAuthRecordByEmail(usersCollectionName, "owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	owner.Set("avatar_url", legacyAvatarURL("fb-owner"))
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	healed, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(healed.Linked) != 1 {
		t.Fatalf("healed run = %+v, want the reverted row rewritten", healed)
	}
	reloaded, err := app.FindRecordById(users, owner.Id)
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.GetString("avatar_url"); got != AvatarFilePath(users.Id, owner.Id, reloaded.GetString(avatarFieldName)) {
		t.Fatalf("avatar_url = %q, want the rewritten local path of the stored file", got)
	}
}

func TestImportUserAvatars_DryRunWritesNothing(t *testing.T) {
	app := migratedApp(t)
	seedAvatarUser(t, app, "fb-owner", "Owner", legacyAvatarURL("fb-owner"))
	root := avatarExportRoot(t, map[string][]byte{"fb-owner": pngBytes})

	report, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 1 || report.VerifiedMD5 != 1 {
		t.Fatalf("dry run = %+v, want the row planned and its bytes verified", report)
	}
	owner, err := app.FindAuthRecordByEmail(usersCollectionName, "owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if owner.GetString("avatar") != "" {
		t.Fatal("a dry run must not store a file")
	}
	if owner.GetString("avatar_url") != legacyAvatarURL("fb-owner") {
		t.Fatal("a dry run must not rewrite the url")
	}
}

func TestImportUserAvatars_ReportsMissingExportFile(t *testing.T) {
	app := migratedApp(t)
	seedAvatarUser(t, app, "fb-owner", "Owner", legacyAvatarURL("fb-owner"))
	// The manifest knows the object, but the export has no bytes for it.
	root := avatarExportRoot(t, map[string][]byte{"fb-other": pngBytes})

	report, err := ImportUserAvatars(app, AvatarImportOptions{StorageDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Linked) != 0 || len(report.Skipped) != 1 {
		t.Fatalf("report = %+v, want a skip and no write", report)
	}
	if !strings.Contains(report.Skipped[0].Reason, "no exported file") {
		t.Fatalf("skip reason = %q, want it to name the missing object", report.Skipped[0].Reason)
	}
}

func TestImportUserAvatars_RequiresStorageUnlessDownload(t *testing.T) {
	app := migratedApp(t)
	if _, err := ImportUserAvatars(app, AvatarImportOptions{}); err == nil {
		t.Fatal("an import without a storage directory and without -download must be refused")
	}
}

func TestAvatarFilePathAndLegacyObjectParsing(t *testing.T) {
	if got := AvatarFilePath("pc1", "rec1", "abc_avatar.png"); got != "/api/files/pc1/rec1/abc_avatar.png" {
		t.Fatalf("path = %q", got)
	}
	object, ok := legacyStorageObject(legacyAvatarURL("fb-owner"))
	if !ok || object != "users/fb-owner/avatar" {
		t.Fatalf("object = %q ok = %t, want users/fb-owner/avatar", object, ok)
	}
	// A host that merely looks similar must not pass: this is what keeps the
	// download path from becoming a request forgery vector.
	for _, hostile := range []string{
		"https://firebasestorage.googleapis.com.evil.example/o/users%2Fx%2Favatar",
		"https://evil.example/o/users%2Fx%2Favatar",
		"https://firebasestorage.googleapis.com/nope",
		"data:image/png;base64,AAAA",
		"",
	} {
		if _, ok := legacyStorageObject(hostile); ok {
			t.Fatalf("%q must not be treated as a legacy object", hostile)
		}
	}
}

func TestAvatarFileNameSniffsFormat(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"png", pngBytes, "avatar.png"},
		{"jpeg", jpegBytes, "avatar.jpg"},
		{"gif", []byte("GIF89a....."), "avatar.gif"},
		{"unknown", []byte("not an image at all"), "avatar.bin"},
	}
	for _, tc := range cases {
		if got := avatarFileName(tc.data); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
	// The uploaded file must be a real filesystem file PocketBase accepts.
	if _, err := filesystem.NewFileFromBytes(pngBytes, avatarFileName(pngBytes)); err != nil {
		t.Fatalf("NewFileFromBytes must accept the sniffed name: %v", err)
	}
}
