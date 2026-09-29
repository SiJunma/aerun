package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1767500000_category_groups_and_group_id.go gives the category board the
// storage its management commands need.
//
// Two gaps, both found by TASK-2 (the admin Categories tab is dead today
// because its writes go to a locked browser API):
//
//   - `category_groups` has no collection at all. `GET /api/aerun/category-groups`
//     already degrades honestly when the table is missing (it answers 200 with
//     `available: false`), which is why the absence stayed invisible: the UI
//     rendered an empty list instead of an error. TASK-2 adds real CRUD, which
//     needs a real table.
//   - `categories` has no `group_id`, although the legacy document has one
//     (PROJECT_CONTEXT.md §schema) and the admin UI groups categories by it.
//
// The legacy `{en, ru}` title maps are NOT reproduced: the adapted UI and the
// importer collapse them to a single string (TASK-2 §contract), so `title` is
// plain text here. Keeping a JSON map that only one writer ever filled would
// mean two spellings of one label forever.
//
// Historical dates stay plain datetime fields (same rule as 1766600000): the
// importer must be able to preserve them.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		if err := createCategoryGroups(app); err != nil {
			return fmt.Errorf("category_groups: %w", err)
		}
		return addCategoryGroupID(app)
	}, func(app core.App) error {
		col, err := app.FindCollectionByNameOrId("category_groups")
		if err != nil {
			return err
		}
		if err := app.Delete(col); err != nil {
			return err
		}
		return removeCategoryGroupID(app)
	})
}

func createCategoryGroups(app core.App) error {
	col := core.NewBaseCollection("category_groups")
	col.Fields.Add(
		&core.TextField{Name: "title", Required: true, Max: 128},
		&core.NumberField{Name: "sort_order", OnlyInt: true},
		&core.DateField{Name: "created_at"},
		&core.DateField{Name: "updated_at"},
	)
	lockBrowserRules(col)
	col.AddIndex("idx_category_groups_order", false, "sort_order", "")
	return app.Save(col)
}

func addCategoryGroupID(app core.App) error {
	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	// Text, not a relation: a category must stay importable (and readable) even
	// when its group row is absent from a partial export — the same reasoning as
	// roles.base_role_id in 1766500000. The command layer validates the id.
	ensureField(categories, &core.TextField{Name: "group_id", Max: 15})
	categories.AddIndex("idx_categories_group", false, "group_id", "group_id != ''")
	return app.Save(categories)
}

func removeCategoryGroupID(app core.App) error {
	categories, err := mutateCollectionForSchema(app, "categories")
	if err != nil {
		return err
	}
	categories.Fields.RemoveByName("group_id")
	categories.RemoveIndex("idx_categories_group")
	return app.Save(categories)
}
