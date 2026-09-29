package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1767000000_user_avatar_file.go gives `users` a real avatar file field.
//
// 1766000000 removed the PocketBase scaffold `avatar` FileField together with
// the scaffold `name` column: at that point no file lived on the record and
// `avatar_url` (a plain URL string copied from the legacy document) was the
// only avatar reference. That was correct for the schema, but it made the
// legacy storage links permanent: every avatar the forum has ever shown is a
// `firebasestorage.googleapis.com` URL, and the legacy bucket is scheduled for
// deletion in Sprint 9 (plan §"Storage"). The cutover therefore has to move
// the bytes into PocketBase, which needs a column that can hold them — hence
// this field, and hence `avatar_url` becomes a *derived* reference to the file
// this record owns (see importer/avatar_import.go).
//
// The two columns coexist on purpose:
//
//   - `avatar` is the file itself. PocketBase stores it under
//     `<data_dir>/storage/<collectionId>/<recordId>/` and serves it from
//     `/api/files/...` under the collection ViewRule
//     (apis/file.go — CanAccessRecord), so an active account's avatar stays
//     world-readable exactly like the legacy hotlink did, and a pending/banned
//     account's stops being publicly fetchable (the public list rule hides
//     those accounts anyway, so the two stay consistent).
//   - `avatar_url` stays a short string so the *denormalized* copies
//     (`author_avatar`, `last_post_author_avatar`, the presence DTO) can carry
//     the same reference without holding a record. It stores the host-agnostic
//     `/api/files/<collectionId>/<recordId>/<file>` path; the frontend resolves
//     it against VITE_POCKETBASE_URL, so the same rows survive a domain change.
//
// The mime list mirrors what the forum actually renders and what the frontend
// uploader accepts (AvatarUploader.jsx: PNG/JPEG/WebP/GIF). 5 MB matches
// PocketBase's own FileField default and leaves room above the 2 MB client cap.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return addUserAvatarField(app)
	}, func(app core.App) error {
		return removeUserAvatarField(app)
	})
}

// avatarFileMaxSize is the per-file cap; 5 MB (PocketBase's FileField default)
// is well above the avatars in the legacy export (the largest is 115 KB).
const avatarFileMaxSize int64 = 5 << 20

// avatarMimeTypes are the formats both the legacy export and the uploader
// produce; anything else is rejected at write time rather than served as a
// broken image.
var avatarMimeTypes = []string{"image/jpeg", "image/png", "image/webp", "image/gif"}

func addUserAvatarField(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	ensureField(users, &core.FileField{
		Name:      "avatar",
		MaxSelect: 1,
		MaxSize:   avatarFileMaxSize,
		MimeTypes: avatarMimeTypes,
	})
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users avatar field: %w", err)
	}
	return nil
}

// removeUserAvatarField restores the pre-1767000000 shape for the down path.
// The uploaded files themselves are NOT deleted: downgrading a schema must not
// destroy user data, and the bytes stay referenced by avatar_url.
func removeUserAvatarField(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	users.Fields.RemoveByName("avatar")
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users avatar field: %w", err)
	}
	return nil
}
