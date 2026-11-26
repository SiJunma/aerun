package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000008_favicon_file_fields.go adds the `favicon` FileField to both
// `forum_settings` and `designs` so administrators can upload a custom favicon
// file directly into PocketBase storage (just like avatars and identity
// placeholders), while keeping `favicon_url` as the host-agnostic `/api/files/...`
// or external reference.
const faviconFileMaxSize int64 = 5 << 20

var faviconMimeTypes = []string{
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/svg+xml",
}

func init() {
	m.Register(applyFaviconFileFields, revertFaviconFileFields)
}

func applyFaviconFileFields(app core.App) error {
	for _, colName := range []string{forumSettingsCollectionName, "designs"} {
		col, err := app.FindCollectionByNameOrId(colName)
		if err != nil {
			return fmt.Errorf("%s: %w", colName, err)
		}

		ensureField(col, &core.FileField{
			Name:      "favicon",
			MaxSelect: 1,
			MaxSize:   faviconFileMaxSize,
			MimeTypes: faviconMimeTypes,
		})
		if err := app.Save(col); err != nil {
			return fmt.Errorf("%s favicon file field: %w", colName, err)
		}
	}
	return nil
}

func revertFaviconFileFields(app core.App) error {
	for _, colName := range []string{forumSettingsCollectionName, "designs"} {
		col, err := app.FindCollectionByNameOrId(colName)
		if err != nil || col == nil {
			continue
		}
		if col.Fields.GetByName("favicon") == nil {
			continue
		}
		col.Fields.RemoveByName("favicon")
		if err := app.Save(col); err != nil {
			return err
		}
	}
	return nil
}
