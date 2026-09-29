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

		file, err := filesystem.NewFileFromBytes(data, avatarFileName(data))
		if err != nil {
			return nil, fmt.Errorf("avatar import: %s: build file: %w", nickname, err)
		}
		record.Set(avatarFieldName, file)
		// The stored name (a random id plus the base name) is only known
		// after the save, which is why avatar_url is set in a second write.
		if err := app.Save(record); err != nil {
			return nil, fmt.Errorf("avatar import: %s: store file: %w", nickname, err)
		}

		record.Set(avatarURLFieldName, AvatarFilePath(collection.Id, record.Id, record.GetString(avatarFieldName)))
		if err := app.Save(record); err != nil {
			return nil, fmt.Errorf("avatar import: %s: rewrite url: %w", nickname, err)
		}
		report.Linked = append(report.Linked, nickname)
	}
	return report, nil
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
