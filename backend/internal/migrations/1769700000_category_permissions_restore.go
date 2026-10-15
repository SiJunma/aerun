package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1769700000 restores the `categories.permissions` JSON field that was dropped
// by 1767400000. It stores per-category permission overrides for
// create_topic, post_reply, use_masks and use_dice (view_forum continues to
// be governed by `categories.allowed_roles`). This lets the admin board's
// category modal round-trip all five permission toggles instead of silently
// dropping the four non-view ones.
func init() {
	m.Register(func(app core.App) error {
		return addCategoryPermissionsJSONField(app)
	}, func(app core.App) error {
		return removeCategoryPermissionsJSONField(app)
	})
}

func addCategoryPermissionsJSONField(app core.App) error {
	categories, err := app.FindCollectionByNameOrId("categories")
	if err != nil {
		return err
	}
	if categories.Fields.GetByName("permissions") == nil {
		categories.Fields.Add(&core.JSONField{Name: "permissions", MaxSize: 65536})
		if err := app.Save(categories); err != nil {
			return fmt.Errorf("categories permissions field: %w", err)
		}
	}
	return nil
}

func removeCategoryPermissionsJSONField(app core.App) error {
	categories, err := app.FindCollectionByNameOrId("categories")
	if err == nil && categories != nil {
		categories.Fields.RemoveByName("permissions")
		if err := app.Save(categories); err != nil {
			return fmt.Errorf("remove categories permissions field: %w", err)
		}
	}
	return nil
}
