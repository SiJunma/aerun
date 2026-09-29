package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1767200000_character_avatar_file.go gives `characters` the same real avatar
// file field migration 1767000000 gave `users`.
//
// 1766600000 created `characters` with only `avatar_url`, a TextField capped at
// 512 characters — the same column that made the user-avatar data-URL write
// impossible. The legacy data needs the file: 7 of the 9 character documents
// point at a Firebase Storage object (2 share the owner's `characters/avatar`
// object, 3 use a per-character `{cid}_avatar` object, 2 more point at the
// owner's `characters/new_avatar`), and those objects run from 64 KB to 996 KB.
// None of that fits a 512-character text column, so `avatar_url` is a reference
// and the bytes need somewhere to live.
//
// The shape is deliberately identical to `users.avatar` (migration
// 1767000000) so one import mechanism serves both collections: same mime list,
// same 5 MB cap, same "file plus a host-agnostic /api/files path" contract.
//
// Unlike `users`, `characters` has every browser rule nil, so its avatar is not
// world-readable: it is served only through explicit server queries, which is
// the collection's existing contract rather than something this migration
// changes.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return addCharacterAvatarField(app)
	}, func(app core.App) error {
		return removeCharacterAvatarField(app)
	})
}

// characterAvatarFileMaxSize matches users.avatar: PocketBase's own FileField
// default, and comfortably above the largest legacy character object (996 KB).
const characterAvatarFileMaxSize int64 = 5 << 20

// characterAvatarMimeTypes mirrors users.avatar and what the frontend uploader
// accepts (PNG/JPEG/WebP/GIF).
var characterAvatarMimeTypes = []string{"image/jpeg", "image/png", "image/webp", "image/gif"}

func addCharacterAvatarField(app core.App) error {
	characters, err := mutateCollectionForSchema(app, "characters")
	if err != nil {
		return err
	}
	ensureField(characters, &core.FileField{
		Name:      "avatar",
		MaxSelect: 1,
		MaxSize:   characterAvatarFileMaxSize,
		MimeTypes: characterAvatarMimeTypes,
	})
	if err := app.Save(characters); err != nil {
		return fmt.Errorf("characters avatar field: %w", err)
	}
	return nil
}

// removeCharacterAvatarField restores the pre-1767200000 shape for the down
// path. The stored files are NOT deleted: downgrading a schema must not destroy
// data, and avatar_url still references them.
func removeCharacterAvatarField(app core.App) error {
	characters, err := mutateCollectionForSchema(app, "characters")
	if err != nil {
		return err
	}
	characters.Fields.RemoveByName("avatar")
	if err := app.Save(characters); err != nil {
		return fmt.Errorf("characters avatar field: %w", err)
	}
	return nil
}
