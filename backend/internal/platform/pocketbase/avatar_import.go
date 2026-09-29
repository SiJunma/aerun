package pocketbase

// Avatar import (Sprint 7 storage half of the cutover).
//
// user_import.go copies the legacy avatar *URL* into `users.avatar_url` and
// says so in the field comment: "Storage is a separate import step". This is
// that step. It moves the bytes out of the legacy Firebase bucket into
// PocketBase and rewrites the URL to a host-agnostic reference to the file the
// record now owns.
//
// Why the bytes and not a re-hosting proxy: the legacy bucket is scheduled for
// deletion in Sprint 9 (plan, "Storage"), and every avatar the forum shows
// today is a hotlink into it. A surviving firebasestorage link is a 404 waiting
// for the bucket teardown.
//
// Deliberate decisions:
//
//   - Only legacy Firebase objects are touched. An avatar_url pointing
//     anywhere else is reported and left alone: a DiceBear avatar is rendered
//     from a seed rather than stored, and the Instagram CDN link is somebody
//     else's host — copying either is unrequested.
//   - The source is the verified export (backend/migration-data/storage) and
//     every file is checked against the md5 in storage-manifest.json, i.e.
//     against the bytes the Sprint 0 snapshot audited. -download re-fetches the
//     live object for the rare avatar that changed after the snapshot; the md5
//     check then reports the difference instead of hiding it.
//   - No arbitrary URL is ever fetched: only objects on the legacy storage host
//     qualify, so the tool has no server-side request forgery surface (the
//     concern PB itself guards in apis/record_auth_with_oauth2.go when it
//     downloads an OAuth2 avatar).
//   - It is an idempotent upsert: a row that already has the file *and* a
//     rewritten URL is reported as unchanged, while a half-finished row (file
//     stored, URL not yet rewritten) is retried instead of skipped.
//   - avatar_url is written host-agnostically (/api/files/...), so the rows
//     survive a domain change; the frontend resolves it against
//     VITE_POCKETBASE_URL, which is the PocketBase-native way to address a
//     file (pb.files.getURL builds exactly this path).
//
// The report carries nicknames and reasons, never email addresses — the rule
// the ops tooling follows (tools/ops/README.md), so the log is safe to paste
// into the plan journal.

import (
	"crypto/md5"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/filesystem"
)

const (
	// charactersCollectionName is the server-only collection created by
	// migration 1766600000. It is referenced from the avatar importer, which
	// needs a name for it rather than a bare string.
	charactersCollectionName = "characters"
	// avatarFieldName is the FileField added by migration 1767000000.
	avatarFieldName = "avatar"
	// avatarURLFieldName is the legacy URL column this import rewrites.
	avatarURLFieldName = "avatar_url"
	// avatarFilePrefix is the base name of the uploaded file; PocketBase
	// prefixes it with a random id on save, so stored names stay unique.
	avatarFilePrefix = "avatar"
	// legacyStorageHost is the only host this tool ever downloads from.
	legacyStorageHost = "firebasestorage.googleapis.com"
	// avatarDownloadTimeout bounds a single -download fetch.
	avatarDownloadTimeout = 30 * time.Second
	// avatarMaxDownloadBytes is a defensive ceiling; the FileField itself caps
	// a stored file at 5 MB.
	avatarMaxDownloadBytes = 5 << 20
)

// AvatarImportOptions configures one import run.
type AvatarImportOptions struct {
	// StorageDir is the root of the verified legacy export
	// (backend/migration-data). Avatars are read from
	// <StorageDir>/storage/users/<legacy uid>/avatar and the integrity check
	// reads <StorageDir>/storage-manifest.json. Required unless Download is
	// set, because the export is the offline source of truth.
	StorageDir string
	// Download re-fetches each avatar from the live legacy Firebase object
	// instead of reading the export. Off by default: the export is audited,
	// offline and reproducible.
	Download bool
	// DryRun resolves and verifies every avatar but writes nothing, so the
	// operator can see the exact outcome against a snapshot first.
	DryRun bool
}

// AvatarSkip is one avatar the import deliberately did not touch.
type AvatarSkip struct {
	Nickname string
	Reason   string
}

// AvatarImportReport states what the run changed, so a rehearsal can prove the
// result before it is applied to the real database.
type AvatarImportReport struct {
	// Linked holds the nicknames whose avatar file was uploaded and whose
	// avatar_url now points at PocketBase.
	Linked []string
	// Unchanged holds rows an earlier run already imported.
	Unchanged []string
	// Skipped holds rows whose avatar_url is not a legacy Firebase object,
	// with the reason it was left alone.
	Skipped []AvatarSkip
	// VerifiedMD5 counts files proven byte-identical to the audited export.
	VerifiedMD5 int
	// MismatchMD5 lists nicknames whose bytes differ from the export
	// manifest; -download is the expected way to produce them, and they are
	// reported rather than treated as failures.
	MismatchMD5 []string
}

// Changed reports whether the run modified anything.
func (r *AvatarImportReport) Changed() bool { return len(r.Linked) > 0 }

// storageEntry is the per-object subset of storage-manifest.json the import
// verifies against: the md5 (base64) recorded at export time.
type storageEntry struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MD5Hash  string `json:"md5Hash"`
	Verified bool   `json:"md5Verified"`
}

// storageManifest is the manifest document.
type storageManifest struct {
	Files []storageEntry `json:"files"`
}

// ImportUserAvatars moves every legacy Firebase avatar of the `users`
// collection into the record's own avatar file and rewrites avatar_url to the
// local PocketBase path.
//
// The first hard error is returned; per-row problems become skips, so one
// unreachable object never strands the rest of the batch.
func ImportUserAvatars(app core.App, opts AvatarImportOptions) (*AvatarImportReport, error) {
	if strings.TrimSpace(opts.StorageDir) == "" && !opts.Download {
		return nil, errors.New("avatar import: a storage directory is required unless Download is set")
	}

	collection, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return nil, fmt.Errorf("avatar import: %w", err)
	}
	// A collection that predates 1767000000 has no avatar field, and writing
	// one would fail validation. Saying so is clearer than a save error.
	if collection.Fields.GetByName(avatarFieldName) == nil {
		return nil, fmt.Errorf(
			"avatar import: users.%s is missing; run the migrations first", avatarFieldName)
	}

	manifest, err := loadStorageManifest(opts.StorageDir)
	if err != nil {
		return nil, err
	}

	records, err := app.FindAllRecords(usersCollectionName, nil)
	if err != nil {
		return nil, fmt.Errorf("avatar import: list users: %w", err)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].GetString("nickname") < records[j].GetString("nickname")
	})

	report := &AvatarImportReport{}
	for _, record := range records {
		nickname := record.GetString("nickname")
		legacyURL := record.GetString(avatarURLFieldName)

		objectPath, isLegacyObject := legacyStorageObject(legacyURL)

		// The already-migrated check comes first, on purpose: after a run
		// avatar_url is a local /api/files path, which legacyStorageObject
		// would (correctly, for a third-party URL) classify as "not a legacy
		// object" and report as skipped.
		if record.GetString(avatarFieldName) != "" && strings.HasPrefix(legacyURL, "/api/files/") {
			report.Unchanged = append(report.Unchanged, nickname)
			continue
		}

		if !isLegacyObject {
			report.Skipped = append(report.Skipped, AvatarSkip{
				Nickname: nickname,
				Reason:   externalAvatarReason(legacyURL),
			})
			continue
		}

		if record.GetString("legacy_firebase_uid") == "" {
			report.Skipped = append(report.Skipped, AvatarSkip{
				Nickname: nickname,
				Reason:   "no legacy_firebase_uid, so the exported object cannot be located",
			})
			continue
		}

		entry, tracked := manifest[objectPath]
		data, err := readAvatarBytes(opts, objectPath, legacyURL)
		if err != nil {
			report.Skipped = append(report.Skipped, AvatarSkip{Nickname: nickname, Reason: err.Error()})
			continue
		}

		if tracked && entry.MD5Hash != "" {
			sum := md5.Sum(data)
			if got := base64.StdEncoding.EncodeToString(sum[:]); got != entry.MD5Hash {
				report.MismatchMD5 = append(report.MismatchMD5, nickname)
			} else {
				report.VerifiedMD5++
			}
		}

		if opts.DryRun {
			// The stored file name is assigned by PocketBase during the save,
			// so a dry run can only report that the row would be rewritten.
			report.Linked = append(report.Linked, nickname)
			continue
		}

		if err := storeImportedAvatar(app, record, data, nickname); err != nil {
			return nil, err
		}
		report.Linked = append(report.Linked, nickname)
	}
	return report, nil
}

// verifyAgainstManifest proves the bytes match the audited export, counting a
// verified file and recording a mismatch. It is shared by both avatar imports
// so the integrity rule cannot drift between collections.
//
// A mismatch is reported, never fatal: -download is the expected way to produce
// one, and a reviewer needs to see it rather than have the run abort.
func verifyAgainstManifest(
	manifest map[string]storageEntry,
	objectPath string,
	data []byte,
	verified *int,
	label string,
	mismatches *[]string,
) error {
	entry, tracked := manifest[objectPath]
	if !tracked || entry.MD5Hash == "" {
		return nil
	}
	sum := md5.Sum(data)
	if got := base64.StdEncoding.EncodeToString(sum[:]); got != entry.MD5Hash {
		*mismatches = append(*mismatches, label)
		return nil
	}
	*verified++
	return nil
}

// storeImportedAvatar writes the bytes onto a record's avatar field and
// rewrites avatar_url to the host-agnostic path.
//
// Two saves are required: PocketBase assigns the stored file name (a random id
// plus the base name) during the save, so avatar_url can only be built once the
// name is known. The single-select FileField deletes the previous file on
// overwrite, so a re-run converges instead of accumulating.
func storeImportedAvatar(app core.App, record *core.Record, data []byte, label string) error {
	file, err := filesystem.NewFileFromBytes(data, avatarFileName(data))
	if err != nil {
		return fmt.Errorf("avatar import: %s: build file: %w", label, err)
	}
	record.Set(avatarFieldName, file)
	if err := app.Save(record); err != nil {
		return fmt.Errorf("avatar import: %s: store file: %w", label, err)
	}

	record.Set(avatarURLFieldName, AvatarFilePath(record.Collection().Id, record.Id, record.GetString(avatarFieldName)))
	if err := app.Save(record); err != nil {
		return fmt.Errorf("avatar import: %s: rewrite url: %w", label, err)
	}
	return nil
}

// AvatarFilePath is the host-agnostic path of a file owned by a record. The
// frontend resolves it against VITE_POCKETBASE_URL; pb.files.getURL builds the
// very same path, so both routes address one file.
func AvatarFilePath(collectionID, recordID, filename string) string {
	return "/api/files/" + collectionID + "/" + recordID + "/" + filename
}

// legacyStorageObject reports whether raw is a legacy Firebase Storage object
// URL and returns the object path inside the bucket (for example
// "users/<uid>/avatar"). Only the legacy host qualifies, which is what keeps
// the download path free of arbitrary remote fetches.
func legacyStorageObject(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host != legacyStorageHost {
		return "", false
	}
	const marker = "/o/"
	idx := strings.Index(parsed.Path, marker)
	if idx < 0 {
		return "", false
	}
	object, err := url.PathUnescape(parsed.Path[idx+len(marker):])
	if err != nil || object == "" {
		return "", false
	}
	return object, true
}

// externalAvatarReason explains why a non-Firebase avatar_url is left alone, so
// a skip is never silent.
func externalAvatarReason(raw string) string {
	switch {
	case raw == "":
		return "no avatar set"
	case strings.Contains(raw, "api.dicebear.com"):
		return "dicebear avatar is generated from a seed, not a stored file"
	case strings.HasPrefix(raw, "http://"), strings.HasPrefix(raw, "https://"):
		return "external host, not the legacy bucket; copying third-party content is out of scope"
	case strings.HasPrefix(raw, "data:"):
		return "inline data URL, not a file"
	default:
		return "not a legacy Firebase object"
	}
}

// readAvatarBytes returns the avatar bytes either from the verified export or,
// when Download is set, from the live legacy object.
func readAvatarBytes(opts AvatarImportOptions, objectPath, legacyURL string) ([]byte, error) {
	if !opts.Download {
		path := filepath.Join(opts.StorageDir, "storage", filepath.FromSlash(objectPath))
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("no exported file for %s: %w", objectPath, err)
		}
		return data, nil
	}

	client := &http.Client{Timeout: avatarDownloadTimeout}
	resp, err := client.Get(legacyURL)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", objectPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: unexpected status %d", objectPath, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, avatarMaxDownloadBytes))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", objectPath, err)
	}
	return data, nil
}

// avatarFileName derives the stored file name. The legacy object carries no
// extension ("users/<uid>/avatar") and PocketBase derives the served
// Content-Type from it, so the format is sniffed from the bytes.
func avatarFileName(data []byte) string {
	return avatarFilePrefix + avatarExtension(data)
}

func avatarExtension(data []byte) string {
	switch {
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return ".jpg"
	case len(data) >= 8 && string(data[1:4]) == "PNG":
		return ".png"
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return ".webp"
	case len(data) >= 6 && (string(data[0:6]) == "GIF87a" || string(data[0:6]) == "GIF89a"):
		return ".gif"
	default:
		return ".bin"
	}
}

// CharacterAvatarImportReport states what the character-avatar run changed.
// It is a separate type from AvatarImportReport because the rows are
// identified by character name, not by the owner's nickname: three different
// owners can each have a character called the same thing, so the owner is
// reported alongside the name to keep a report line unambiguous.
type CharacterAvatarImportReport struct {
	// Linked holds "owner nickname / character name" labels whose avatar file
	// was stored and whose avatar_url now points at PocketBase.
	Linked []string
	// Unchanged holds labels an earlier run already imported.
	Unchanged []string
	// Skipped holds labels whose avatar_url is not a legacy Firebase object,
	// with the reason it was left alone.
	Skipped []AvatarSkip
	// VerifiedMD5 counts files proven byte-identical to the audited export.
	VerifiedMD5 int
	// MismatchMD5 lists labels whose bytes differ from the export manifest.
	MismatchMD5 []string
	// NoOwner lists character rows whose owner_id does not resolve to a users
	// row, so the label could not be resolved. They are not an error: the
	// importer can legitimately run before (or without) the account list.
	NoOwner []string
}

// Changed reports whether the run modified anything.
func (r *CharacterAvatarImportReport) Changed() bool { return len(r.Linked) > 0 }

// ImportCharacterAvatars moves every legacy Firebase avatar of the
// `characters` collection into the character's own avatar file and rewrites
// avatar_url to the local PocketBase path.
//
// It is the same mechanism as ImportUserAvatars — same object-path parsing,
// same export read, same md5 verification, same dry-run and the same
// never-delete rule — applied to a different collection. The two are kept as
// separate entry points because the collections differ in a way that matters:
// `users.avatar` is served world-readable through the collection ViewRule,
// while `characters` is server-only, and the labels a human needs to review
// are character names rather than account nicknames.
//
// Every hard error is returned; per-row problems become skips, so one
// unreachable object never strands the rest of the batch.
func ImportCharacterAvatars(app core.App, opts AvatarImportOptions) (*CharacterAvatarImportReport, error) {
	if strings.TrimSpace(opts.StorageDir) == "" && !opts.Download {
		return nil, errors.New("character avatar import: a storage directory is required unless Download is set")
	}

	collection, err := app.FindCollectionByNameOrId(charactersCollectionName)
	if err != nil {
		return nil, fmt.Errorf("character avatar import: %w", err)
	}
	if collection.Fields.GetByName(avatarFieldName) == nil {
		return nil, fmt.Errorf(
			"character avatar import: characters.%s is missing; run the migrations first", avatarFieldName)
	}

	manifest, err := loadStorageManifest(opts.StorageDir)
	if err != nil {
		return nil, err
	}

	records, err := app.FindAllRecords(charactersCollectionName, nil)
	if err != nil {
		return nil, fmt.Errorf("character avatar import: list characters: %w", err)
	}
	sort.Slice(records, func(i, j int) bool {
		a, b := records[i], records[j]
		if a.GetString("name") != b.GetString("name") {
			return a.GetString("name") < b.GetString("name")
		}
		return a.GetString("owner_id") < b.GetString("owner_id")
	})

	report := &CharacterAvatarImportReport{}
	for _, record := range records {
		_, label, resolved := characterLabel(app, record)
		if !resolved {
			// An owner_id with no users row cannot be resolved to a readable
			// label. The file is still importable, but reporting the
			// unresolvable row is the honest thing rather than renaming it to
			// a blank string.
			report.NoOwner = append(report.NoOwner, record.GetString("name"))
		}

		legacyURL := record.GetString(avatarURLFieldName)
		objectPath, isLegacyObject := legacyStorageObject(legacyURL)

		// The already-migrated check comes first, for the same reason as the
		// user import: after a run avatar_url is a local /api/files path, which
		// legacyStorageObject would classify as "not a legacy object".
		if record.GetString(avatarFieldName) != "" && strings.HasPrefix(legacyURL, "/api/files/") {
			report.Unchanged = append(report.Unchanged, label)
			continue
		}

		if !isLegacyObject {
			report.Skipped = append(report.Skipped, AvatarSkip{
				Nickname: label,
				Reason:   externalAvatarReason(legacyURL),
			})
			continue
		}

		data, err := readAvatarBytes(opts, objectPath, legacyURL)
		if err != nil {
			report.Skipped = append(report.Skipped, AvatarSkip{Nickname: label, Reason: err.Error()})
			continue
		}
		if err := verifyAgainstManifest(manifest, objectPath, data, &report.VerifiedMD5, label, &report.MismatchMD5); err != nil {
			return nil, err
		}

		if opts.DryRun {
			// The stored file name is assigned by PocketBase during the save,
			// so a dry run can only report that the row would be rewritten.
			report.Linked = append(report.Linked, label)
			continue
		}

		if err := storeImportedAvatar(app, record, data, label); err != nil {
			return nil, err
		}
		report.Linked = append(report.Linked, label)
	}
	return report, nil
}

// characterLabel resolves a character row to a human-readable "owner / name"
// label. The nickname is only for the report — it is never written anywhere.
func characterLabel(app core.App, record *core.Record) (*core.Record, string, bool) {
	name := record.GetString("name")
	ownerID := record.GetString("owner_id")
	if ownerID == "" {
		return nil, name, false
	}
	owner, err := app.FindRecordById(usersCollectionName, ownerID)
	if err != nil || owner == nil {
		return nil, name, false
	}
	return owner, owner.GetString("nickname") + " / " + name, true
}

// loadStorageManifest reads the export manifest into a lookup by object name.
// A missing manifest is not fatal: the import still runs, it simply cannot
// prove the bytes (and then reports no verified md5).
func loadStorageManifest(storageDir string) (map[string]storageEntry, error) {
	index := map[string]storageEntry{}
	if strings.TrimSpace(storageDir) == "" {
		return index, nil
	}
	raw, err := os.ReadFile(filepath.Join(storageDir, "storage-manifest.json"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return index, nil
		}
		return nil, fmt.Errorf("avatar import: read manifest: %w", err)
	}
	var manifest storageManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("avatar import: parse manifest: %w", err)
	}
	for _, file := range manifest.Files {
		index[file.Name] = file
	}
	return index, nil
}
