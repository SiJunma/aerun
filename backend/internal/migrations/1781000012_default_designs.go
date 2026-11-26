package migrations

import (
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1781000012_default_designs.go creates the `default_designs` collection
// (PLAN_DESIGNS_TAB_SURFACES.md §7.1, variant A): the three built-in themes
// as undeletable design cards, in their own surface, with the same fields a
// custom design card carries — backgrounds, header/footer HTML, title,
// favicon, placeholders, CSS/JS and one overwrite_* toggle per value that
// can fall back to surface 1.
//
// There is NO is_active and NO base_theme: a default design IS the base.
// Visibility in the theme picker is show_in_list, reused from designs.
// The records are seeded here, in dark / light / neutral order, with the RU
// display names the plan fixes («Тёмная» / «Светлая» / «Нейтральная»); all
// overwrite_* toggles start off, so a fresh default card inherits surface 1.
func init() {
	m.Register(applyDefaultDesigns, revertDefaultDesigns)
}

const defaultDesignsCollectionName = "default_designs"

// defaultDesignSeed is one seeded built-in theme card.
type defaultDesignSeed struct {
	key  string
	name string
}

var defaultDesignSeeds = []defaultDesignSeed{
	{key: "dark", name: "Тёмная"},
	{key: "light", name: "Светлая"},
	{key: "neutral", name: "Нейтральная"},
}

// defaultDesignFields mirrors the custom-design surface fields, minus
// base_theme / is_active (a default design has neither) and plus `key`.
func defaultDesignFields() []core.Field {
	return []core.Field{
		&core.TextField{Name: "key", Required: true, Max: 32},
		&core.TextField{Name: "name", Required: true, Max: 128},
		&core.TextField{Name: "description", Max: 1024},
		&core.TextField{Name: "css", Max: 0},
		&core.TextField{Name: "js", Max: 0},
		&core.TextField{Name: "forum_title", Max: 512},
		&core.FileField{
			Name:      "favicon",
			MaxSelect: 1,
			MaxSize:   faviconFileMaxSize,
			MimeTypes: faviconMimeTypes,
		},
		&core.TextField{Name: "favicon_url", Max: 512},
		&core.BoolField{Name: "show_in_list"},
		&core.JSONField{Name: "header_html", MaxSize: 262144},
		&core.JSONField{Name: "custom_footer_html", MaxSize: 262144},
		&core.FileField{
			Name:      "bg_default",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.FileField{
			Name:      "bg_tablet",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.FileField{
			Name:      "bg_mobile",
			MaxSelect: 1,
			MaxSize:   designBackgroundFileMaxSize,
			MimeTypes: designBackgroundMimeTypes,
		},
		&core.TextField{Name: "bg_default_url", Max: 512},
		&core.TextField{Name: "bg_tablet_url", Max: 512},
		&core.TextField{Name: "bg_mobile_url", Max: 512},
		&core.NumberField{Name: "bg_opacity", Min: float64Ptr(0), Max: float64Ptr(1)},
		&core.FileField{
			Name:      "placeholder_deleted",
			MaxSelect: 1,
			MaxSize:   identityPlaceholderFileMaxSize,
			MimeTypes: identityPlaceholderMimeTypes,
		},
		&core.FileField{
			Name:      "placeholder_guest",
			MaxSelect: 1,
			MaxSize:   identityPlaceholderFileMaxSize,
			MimeTypes: identityPlaceholderMimeTypes,
		},
		&core.TextField{Name: "placeholder_deleted_url", Max: 512},
		&core.TextField{Name: "placeholder_guest_url", Max: 512},
		&core.BoolField{Name: "overwrite_header"},
		&core.BoolField{Name: "overwrite_footer"},
		&core.BoolField{Name: "overwrite_title"},
		&core.BoolField{Name: "overwrite_favicon"},
		&core.BoolField{Name: "overwrite_css"},
		&core.BoolField{Name: "overwrite_js"},
		&core.BoolField{Name: "overwrite_placeholder_deleted"},
		&core.BoolField{Name: "overwrite_placeholder_guest"},
		&core.DateField{Name: "created_at"},
		&core.DateField{Name: "updated_at"},
	}
}

func applyDefaultDesigns(app core.App) error {
	col, err := app.FindCollectionByNameOrId(defaultDesignsCollectionName)
	if err != nil {
		col = core.NewBaseCollection(defaultDesignsCollectionName)
		col.Fields.Add(defaultDesignFields()...)
		// Server-only, like designs: all access goes through the command layer.
		col.ListRule = nil
		col.ViewRule = nil
		col.CreateRule = nil
		col.UpdateRule = nil
		col.DeleteRule = nil
		col.AddIndex("idx_default_designs_key", true, "key", "key != ''")
		if err := app.Save(col); err != nil {
			return fmt.Errorf("create default_designs: %w", err)
		}
	}

	now := time.Now()
	for _, seed := range defaultDesignSeeds {
		existing, _ := app.FindFirstRecordByFilter(col, "key = {:key}", dbx.Params{"key": seed.key})
		if existing != nil {
			continue
		}
		rec := core.NewRecord(col)
		rec.Set("key", seed.key)
		rec.Set("name", seed.name)
		rec.Set("show_in_list", true)
		rec.Set("created_at", now)
		rec.Set("updated_at", now)
		if err := app.Save(rec); err != nil {
			return fmt.Errorf("seed default design %q: %w", seed.key, err)
		}
	}
	return nil
}

func revertDefaultDesigns(app core.App) error {
	col, err := app.FindCollectionByNameOrId(defaultDesignsCollectionName)
	if err != nil || col == nil {
		return nil
	}
	return app.Delete(col)
}
