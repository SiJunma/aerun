package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1780100001 adds the admin-owned PWA / Web Push settings to forum_settings.
//
// The first Web Push commit (1780100000) hardcoded the manifest in
// public/manifest.webmanifest: name, description, colours and icon paths.
// That contradicts the forum's own rule — everything an admin can change
// lives in the admin panel, not in a file. So the manifest is now served
// dynamically (GET /api/aerun/manifest.webmanifest): the name, the short
// name and the description come from these columns, the icons are admin
// uploads on the settings row (stored exactly like the favicon: a
// single-select FileField plus a host-agnostic URL text field), and the
// colours and the language are NOT stored at all — they follow the
// viewer's live theme and locale through the ?theme= and ?lang= query
// parameters (see pwa_manifest.go).
//
// push_enabled already arrived with 1780100000; it gets its admin toggle
// on the same surface, no column needed here.
func init() {
	m.Register(func(app core.App) error {
		settingsCollection, err := app.FindCollectionByNameOrId("forum_settings")
		if err != nil {
			return err
		}

		settingsCollection.Fields = append(settingsCollection.Fields,
			&core.TextField{Name: "pwa_name", Max: 128},
			&core.TextField{Name: "pwa_short_name", Max: 64},
			&core.TextField{Name: "pwa_description", Max: 512},
			&core.TextField{Name: "pwa_icon_192_url", Max: 1024},
			&core.TextField{Name: "pwa_icon_512_url", Max: 1024},
			&core.TextField{Name: "pwa_icon_maskable_url", Max: 1024},
			&core.TextField{Name: "pwa_icon_apple_touch_url", Max: 1024},
			&core.TextField{Name: "pwa_icon_badge_url", Max: 1024},
			&core.FileField{Name: "pwa_icon_192", MaxSelect: 1, MaxSize: 5 << 20, MimeTypes: []string{
				"image/png", "image/jpeg", "image/webp",
			}},
			&core.FileField{Name: "pwa_icon_512", MaxSelect: 1, MaxSize: 5 << 20, MimeTypes: []string{
				"image/png", "image/jpeg", "image/webp",
			}},
			&core.FileField{Name: "pwa_icon_maskable", MaxSelect: 1, MaxSize: 5 << 20, MimeTypes: []string{
				"image/png", "image/jpeg", "image/webp",
			}},
			&core.FileField{Name: "pwa_icon_apple_touch", MaxSelect: 1, MaxSize: 5 << 20, MimeTypes: []string{
				"image/png", "image/jpeg", "image/webp",
			}},
			&core.FileField{Name: "pwa_icon_badge", MaxSelect: 1, MaxSize: 5 << 20, MimeTypes: []string{
				"image/png", "image/jpeg", "image/webp",
			}},
		)

		return app.Save(settingsCollection)
	}, func(app core.App) error {
		settingsCollection, err := app.FindCollectionByNameOrId("forum_settings")
		if err != nil {
			return err
		}

		for _, name := range []string{
			"pwa_name", "pwa_short_name", "pwa_description",
			"pwa_icon_192_url", "pwa_icon_512_url", "pwa_icon_maskable_url",
			"pwa_icon_apple_touch_url", "pwa_icon_badge_url",
			"pwa_icon_192", "pwa_icon_512", "pwa_icon_maskable",
			"pwa_icon_apple_touch", "pwa_icon_badge",
		} {
			settingsCollection.Fields.RemoveByName(name)
		}

		return app.Save(settingsCollection)
	})
}
