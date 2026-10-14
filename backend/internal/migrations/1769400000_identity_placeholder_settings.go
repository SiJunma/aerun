package migrations

// 1769400000_identity_placeholder_settings.go gives the forum_settings singleton
// two uploadable avatar files: the placeholder shown for a REMOVED account
// ("deleted") and the one shown for a GUEST. This is the storage half of plan
// I5/D2 — the admin-uploadable custom placeholder images, with the neutral
// gray "U" the frontend draws today (see src/utils/identity.js) remaining the
// default until an image is actually uploaded.
//
// WHY forum_settings AND NOT users/characters. These images are a property of
// the forum's chrome, exactly like forum_name, the logo and the backgrounds:
// they are set once by the owner, read by every visitor, and survive restarts.
// They belong on the same singleton row the admin board already edits, reached
// through the same public snapshot (GET /api/aerun/settings).
//
// WHY A FileField PLUS A TEXT REFERENCE, the same two-column shape the user
// avatar uses (migration 1767000000):
//   - the file itself (`deleted_avatar`, `guest_avatar`) lives in PocketBase
//     storage and is served from /api/files under the collection's rules;
//   - the reference (`deleted_avatar_url`, `guest_avatar_url`) is a short,
//     host-agnostic /api/files path the public settings snapshot can carry
//     without embedding a record, so the frontend resolves it the same way it
//     resolves every other avatar.
//
// The 5 MB cap and the image mime list mirror the user avatar field: well above
// anything an admin would upload for a small circular placeholder, and rejected
// at write time rather than served as a broken image.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// identityPlaceholderFileMaxSize is the per-file cap; 5 MB matches the user
// avatar FileField and sits far above any placeholder an admin would upload.
const identityPlaceholderFileMaxSize int64 = 5 << 20

// identityPlaceholderMimeTypes are the formats the placeholder is rendered as;
// anything else is refused at write time.
var identityPlaceholderMimeTypes = []string{"image/jpeg", "image/png", "image/webp", "image/gif"}

func init() {
	m.Register(applyIdentityPlaceholderSettings, revertIdentityPlaceholderSettings)
}

// applyIdentityPlaceholderSettings adds the four columns and ensures the
// existing singleton row holds empty references, so every database — not only a
// fresh one — reads "" (meaning "no custom image, use the default") rather than
// null. A stored value an admin has already uploaded is never overwritten.
func applyIdentityPlaceholderSettings(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return fmt.Errorf("forum_settings: %w", err)
	}

	ensureField(col, &core.FileField{
		Name:      "deleted_avatar",
		MaxSelect: 1,
		MaxSize:   identityPlaceholderFileMaxSize,
		MimeTypes: identityPlaceholderMimeTypes,
	})
	ensureField(col, &core.FileField{
		Name:      "guest_avatar",
		MaxSelect: 1,
		MaxSize:   identityPlaceholderFileMaxSize,
		MimeTypes: identityPlaceholderMimeTypes,
	})
	ensureField(col, &core.TextField{Name: "deleted_avatar_url", Max: 512})
	ensureField(col, &core.TextField{Name: "guest_avatar_url", Max: 512})
	if err := app.Save(col); err != nil {
		return fmt.Errorf("forum_settings identity placeholder fields: %w", err)
	}

	// Normalise the singleton's reference columns to "" on every database, so a
	// null never reaches the read path. Only an EMPTY value is written back; a
	// path an admin already uploaded is left untouched.
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		// Nothing to seed — an absent row already reads as no custom image.
		return nil
	}
	for _, field := range []string{"deleted_avatar_url", "guest_avatar_url"} {
		if record.GetString(field) != "" {
			continue
		}
		record.Set(field, "")
	}
	if err := app.Save(record); err != nil {
		return fmt.Errorf("seed forum_settings identity placeholder references: %w", err)
	}
	return nil
}

// revertIdentityPlaceholderSettings drops the four columns on the down path.
// The uploaded files themselves are NOT deleted: downgrading a schema must not
// destroy user data, and the bytes stay referenced by the *_url columns until a
// later migration that still declares them reads them again.
func revertIdentityPlaceholderSettings(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}
	for _, name := range []string{"deleted_avatar", "guest_avatar", "deleted_avatar_url", "guest_avatar_url"} {
		if col.Fields.GetByName(name) == nil {
			continue
		}
		col.Fields.RemoveByName(name)
	}
	return app.Save(col)
}
