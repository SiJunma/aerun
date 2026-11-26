package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000009_designs_base_theme.go adds designs.base_theme: the built-in
// theme (light, dark or neutral) a custom design is layered on top of. The
// design's CSS/JS never replaces the base — the base decides the palette
// (data-theme) under the custom layer, including in ?preview_design= previews,
// no matter which theme the viewer uses themselves.
func init() {
	m.Register(applyDesignsBaseTheme, revertDesignsBaseTheme)
}

func applyDesignsBaseTheme(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil {
		return err
	}

	if col.Fields.GetByName("base_theme") != nil {
		return nil
	}
	col.Fields.Add(&core.TextField{Name: "base_theme", Max: 32})
	if err := app.Save(col); err != nil {
		return fmt.Errorf("add designs.base_theme: %w", err)
	}
	return nil
}

func revertDesignsBaseTheme(app core.App) error {
	col, err := app.FindCollectionByNameOrId("designs")
	if err != nil || col == nil {
		return nil
	}

	if existing := col.Fields.GetByName("base_theme"); existing != nil {
		col.Fields.RemoveById(existing.GetId())
		return app.Save(col)
	}
	return nil
}
