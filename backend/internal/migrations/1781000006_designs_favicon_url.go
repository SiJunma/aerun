package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000006_designs_favicon_url.go replaces designs.logo_url with
// designs.favicon_url. The forum header no longer renders a custom logo image,
// and custom designs configure the browser tab favicon instead.
func init() {
	m.Register(applyDesignsFaviconURL, revertDesignsFaviconURL)
}

func applyDesignsFaviconURL(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		return err
	}

	changed := false
	if col.Fields.GetByName("favicon_url") == nil {
		col.Fields.Add(&core.TextField{Name: "favicon_url", Max: 512})
		changed = true
	}
	if existing := col.Fields.GetByName("logo_url"); existing != nil {
		col.Fields.RemoveById(existing.GetId())
		changed = true
	}

	if changed {
		if err := app.Save(col); err != nil {
			return fmt.Errorf("replace designs.logo_url with favicon_url: %w", err)
		}
	}
	return nil
}

func revertDesignsFaviconURL(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil || col == nil {
		return nil
	}

	changed := false
	if col.Fields.GetByName("logo_url") == nil {
		col.Fields.Add(&core.TextField{Name: "logo_url", Max: 512})
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
