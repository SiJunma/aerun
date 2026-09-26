package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766600000_characters_and_designs.go closes two gaps the 2026-09 rehearsal
// reported (see POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §4):
//
//   - `characters` — the legacy `users/{uid}/characters/{cid}` documents were
//     folded into users.settings by the analysis stage only as a stopgap.
//     They cannot stay there: topics and posts reference them by id
//     (`author_character_id`) and each holds an avatar in Storage, so they
//     need their own addressable collection.
//   - `designs` — the custom forum design document (css/js/theme) that the
//     rehearsal skipped because no target collection existed.
//
// Historical timestamps are plain datetime fields, never autodate: an import
// must preserve the legacy dates (plan requirement "preserve historical
// dates"), and autodate values cannot be rewritten.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := createCharacters(app); err != nil {
			return fmt.Errorf("characters: %w", err)
		}
		return createDesigns(app)
	}, func(app core.App) error {
		for _, name := range []string{"characters", "designs"} {
			col, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				return err
			}
			if err := app.Delete(col); err != nil {
				return err
			}
		}
		return nil
	})
}

func createCharacters(app core.App) error {
	col := core.NewBaseCollection("characters")
	col.Fields.Add(
		// owner_id is text, not a relation: like roles.base_role_id, a
		// character must be importable even when its owner row is missing
		// from a partial export. The command layer validates ownership.
		&core.TextField{Name: "owner_id", Required: true, Max: 128},
		&core.TextField{Name: "name", Required: true, Max: 128},
		&core.TextField{Name: "status_line", Max: 256},
		&core.TextField{Name: "signature", Max: 2048},
		&core.TextField{Name: "avatar_url", Max: 512},
		&core.DateField{Name: "created_at"},
		&core.DateField{Name: "updated_at"},
	)
	// Server-only: writes go through the command layer, reads through
	// explicit queries in the domain services.
	col.ListRule = nil
	col.ViewRule = nil
	col.CreateRule = nil
	col.UpdateRule = nil
	col.DeleteRule = nil
	// A legacy account could own several characters with the same name;
	// uniqueness is per owner.
	col.AddIndex("idx_characters_owner", false, "owner_id, name", "owner_id != ''")
	return app.Save(col)
}

func createDesigns(app core.App) error {
	col := core.NewBaseCollection("designs")
	col.Fields.Add(
		&core.TextField{Name: "name", Required: true, Max: 128},
		&core.TextField{Name: "description", Max: 1024},
		&core.TextField{Name: "css", Max: 0},
		&core.TextField{Name: "js", Max: 0},
		&core.TextField{Name: "forum_title", Max: 512},
		&core.TextField{Name: "logo_url", Max: 512},
		&core.BoolField{Name: "is_active"},
		&core.BoolField{Name: "show_in_list"},
		&core.JSONField{Name: "welcome_message", MaxSize: 262144},
		&core.DateField{Name: "created_at"},
		&core.DateField{Name: "updated_at"},
	)
	col.ListRule = nil
	col.ViewRule = nil
	col.CreateRule = nil
	col.UpdateRule = nil
	col.DeleteRule = nil
	// Only one design may be active at a time.
	col.AddIndex("idx_designs_active", true, "is_active", "is_active = true")
	return app.Save(col)
}
