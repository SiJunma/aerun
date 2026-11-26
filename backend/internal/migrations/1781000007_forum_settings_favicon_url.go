package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000007_forum_settings_favicon_url.go replaces forum_settings.logo_url
// with forum_settings.favicon_url. Global branding now uses the text forum
// name in the navbar and an optional custom favicon URL for browser tabs.
func init() {
	m.Register(applyForumSettingsFaviconURL, revertForumSettingsFaviconURL)
}

func applyForumSettingsFaviconURL(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil {
		return err
	}

	changed := false
	if col.Fields.GetByName("favicon_url") == nil {
		col.Fields.Add(&core.TextField{Name: "favicon_url", Max: 2048})
		changed = true
	}
	if existing := col.Fields.GetByName("logo_url"); existing != nil {
		col.Fields.RemoveById(existing.GetId())
		changed = true
	}

	if changed {
		if err := app.Save(col); err != nil {
			return fmt.Errorf("replace forum_settings.logo_url with favicon_url: %w", err)
		}
	}
	return nil
}

func revertForumSettingsFaviconURL(app core.App) error {
	col, err := app.FindCollectionByNameOrId(forumSettingsCollectionName)
	if err != nil || col == nil {
		return nil
	}

	changed := false
	if col.Fields.GetByName("logo_url") == nil {
		col.Fields.Add(&core.TextField{Name: "logo_url", Max: 2048})
		changed = true
	}
	if existing := col.Fields.GetByName("favicon_url"); existing != nil {
		col.Fields.RemoveById(existing.GetId())
		changed = true
	}

	if changed {
		return app.Save(col)
	}
	return nil
}
