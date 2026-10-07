package migrations

// 1769100000 clears the required flag on max_chars_per_post.
//
// WHY. The field shipped with Required true in 1768800000. PocketBase treats a
// zero as a MISSING value for a required NumberField, so after 1769000000
// lowered Min to 0 the "0 = unlimited" choice the admin panel promises became
// unsavable: the settings handler passed its own bounds check, then
// record.Save failed field validation and the PATCH returned 500 "Failed to
// save forum settings". Required is meaningless on a column that always has a
// seeded value and whose zero is a deliberate choice, so it goes.
//
// Fresh databases get Required false directly from 1768800000 (edited in
// step); this migration clears the flag on databases whose schema was already
// applied. The revert restores the original flag.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyClearMaxCharsRequired, revertClearMaxCharsRequired)
}

func applyClearMaxCharsRequired(app core.App) error {
	return setMaxCharsRequired(app, false)
}

func revertClearMaxCharsRequired(app core.App) error {
	return setMaxCharsRequired(app, true)
}

func setMaxCharsRequired(app core.App, required bool) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		// An absent collection has nothing to adjust; the fresh-install path
		// creates the field with the right flag directly.
		return nil
	}
	field := col.Fields.GetByName("max_chars_per_post")
	if field == nil {
		return nil
	}
	number, ok := field.(*core.NumberField)
	if !ok {
		return fmt.Errorf("max_chars_per_post is %T, expected *core.NumberField", field)
	}
	if number.Required == required {
		return nil
	}
	number.Required = required
	if err := app.Save(col); err != nil {
		return fmt.Errorf("set max_chars_per_post required=%v: %w", required, err)
	}
	return nil
}