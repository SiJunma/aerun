package migrations

// 1768700000_topics_per_page_setting.go adds `topics_per_page` to the forum
// settings singleton, next to `posts_per_page`.
//
// WHY A NEW SETTING AND NOT A REUSED ONE. The two govern different rows. A
// topic row carries a category, an author and several timestamps, so the same
// count is visibly more page than a list of posts. Reusing one number would have
// to be wrong for one of them, and the ceiling proves it: a member who wants 100
// posts per page does not want 100 topic rows.
//
// THE ROW IS REPAIRED, NOT ONLY THE SCHEMA. A NumberField with a Min reads an
// absent value as 0, and 0 is below the floor — so a database whose settings row
// predates this migration would come back with a page size of 1 topic instead of
// the default. Setting the value in the same migration that adds the column is
// what stops a forum from silently showing one topic per page.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func init() {
	m.Register(applyTopicsPerPageSetting, revertTopicsPerPageSetting)
}

func applyTopicsPerPageSetting(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}

	if col.Fields.GetByName("topics_per_page") == nil {
		col.Fields.Add(&core.NumberField{
			Name:     "topics_per_page",
			Min:      float64Ptr(float64(auth.MinTopicsPerPage)),
			Max:      float64Ptr(float64(auth.HardMaxTopicsPerPage)),
			Required: true,
		})
		if err := app.Save(col); err != nil {
			return err
		}
	}

	// Seed the value on the existing row.
	//
	// A NumberField with a Min reads an absent value as 0, and 0 is below the
	// floor — so a database whose settings row predates this migration would come
	// back with a page size of 1 topic instead of the default. Writing the value
	// in the same migration that adds the column is what stops a forum from
	// silently showing one topic per page.
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		// Nothing to repair — an absent row already reads as the default.
		return nil
	}
	record.Set("topics_per_page", auth.DefaultTopicsPerPage)
	if err := app.Save(record); err != nil {
		return fmt.Errorf("seed topics_per_page: %w", err)
	}
	return nil
}

func revertTopicsPerPageSetting(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}
	if col.Fields.GetByName("topics_per_page") == nil {
		return nil
	}
	col.Fields.RemoveByName("topics_per_page")
	return app.Save(col)
}
