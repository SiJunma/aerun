package migrations

// Repair migration: branding and theme backgrounds on an imported blank row.
//
// WHY THIS EXISTS. Migration 1768800000 seeded forum_name, welcome_message and
// the design fields on the forum_settings row — but it ran BEFORE the legacy
// importer created that row. The importer inserted `forumsettings01` with empty
// values, so the seed's "row exists" branch never fired and every branding
// column stayed blank: the API returned forumName {} and bgLight "", the client
// masked the emptiness with its own hardcoded defaults (AdminPage's
// `data.bgLight || 'https://images.unsplash.com/…'`), the forum rendered no
// background image, and {APP_NAME} in every outgoing mail resolved to
// PocketBase's "Forum" fallback instead of the brand.
//
// The repair re-runs the same seed-only-if-blank contract on the existing row.
// It must stay tolerant: an admin who has already saved real values through the
// admin panel must not see them overwritten, so every write is guarded by a
// blank check exactly as in seedGlobalSettings. The revert restores the
// pre-repair state, which for this bug is the blank string.

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyBrandingBackgroundsRepair, revertBrandingBackgroundsRepair)
}

// defaultThemeBackgrounds are the URLs the admin panel has always displayed as
// its initial state (AdminPage.jsx's fallbacks), so a forum that never touched
// the admin panel renders the same background after this repair.
var defaultThemeBackgrounds = map[string]string{
	"bg_light":   "https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop",
	"bg_dark":    "https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop",
	"bg_neutral": "https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop",
}

func applyBrandingBackgroundsRepair(app core.App) error {
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		// An absent row already reads as the client-side defaults; nothing to
		// repair. The mirror of 1768800000's tolerance for a missing row.
		return nil
	}

	changed := false
	seedBlankText := func(name, def string) {
		if strings.TrimSpace(record.GetString(name)) == "" {
			record.Set(name, def)
			changed = true
		}
	}
	seedBlankBilingual := func(name string, def map[string]any) {
		if !bilingualBlank(record.GetString(name)) {
			return
		}
		record.Set(name, def)
		changed = true
	}

	seedBlankBilingual("forum_name", defaultForumName)
	seedBlankBilingual("welcome_message", defaultWelcomeMessage)
	seedBlankText("bg_light", defaultThemeBackgrounds["bg_light"])
	seedBlankText("bg_dark", defaultThemeBackgrounds["bg_dark"])
	seedBlankText("bg_neutral", defaultThemeBackgrounds["bg_neutral"])

	if !changed {
		return nil
	}
	if err := app.Save(record); err != nil {
		return fmt.Errorf("repair forum_settings branding: %w", err)
	}
	app.Logger().Info("forum_settings branding repaired",
		"bg_light", defaultThemeBackgrounds["bg_light"])
	return nil
}

// bilingualBlank reports whether a forum_name-style JSON value carries no usable
// text. An imported row holds `{}`, whose GetString is the literal "{}" — a
// non-blank string — so the plain text check used elsewhere in this file would
// skip the seed and the brand would stay broken. Only a decoded object with at
// least one non-empty string counts as present.
func bilingualBlank(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return true
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(trimmed), &decoded); err != nil {
		return false // a non-JSON value is admin content, not a blank field
	}
	for _, item := range decoded {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			return false
		}
	}
	return true
}

func revertBrandingBackgroundsRepair(app core.App) error {
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		return nil
	}
	record.Set("forum_name", map[string]any{})
	record.Set("welcome_message", map[string]any{})
	record.Set("bg_light", "")
	record.Set("bg_dark", "")
	record.Set("bg_neutral", "")
	if err := app.Save(record); err != nil {
		return fmt.Errorf("revert forum_settings branding repair: %w", err)
	}
	return nil
}
