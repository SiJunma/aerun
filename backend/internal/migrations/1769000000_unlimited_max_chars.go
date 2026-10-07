package migrations

// 1769000000 relaxes max_chars_per_post to allow 0 = unlimited.
//
// WHY. The admin panel's label has always promised "Max Characters per Post
// (0 = unlimited)" and the Firestore legacy export carried 0 as the unlimited
// value, but the field shipped with Min 1 in 1768800000 and the settings
// handler rejected anything below 1 — so the promise was unreachable: an admin
// clearing the field or typing 0 got "must be between 1 and 1000000".
//
// The repair touches only the FIELD bound. Fresh databases get Min 0 directly
// from 1768800000 (edited in step); this migration relaxes the bound on every
// database whose schema was already applied, because a migration body edit
// never re-runs on a database that recorded it. The read path
// (forum_settings.unlimitedCharsPerPost) honors a stored 0 as unlimited while
// an absent column still falls back to the default.
//
// The revert restores the original floor of 1.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(applyUnlimitedMaxChars, revertUnlimitedMaxChars)
}

func applyUnlimitedMaxChars(app core.App) error {
	return relaxMaxCharsFloor(app, 0)
}

func revertUnlimitedMaxChars(app core.App) error {
	return relaxMaxCharsFloor(app, 1)
}

func relaxMaxCharsFloor(app core.App, min float64) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		// An absent collection has nothing to relax; the fresh-install path
		// creates the field with the right bound directly.
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
	if number.Min != nil && *number.Min == min {
		return nil
	}
	number.Min = &min
	if err := app.Save(col); err != nil {
		return fmt.Errorf("relax max_chars_per_post floor: %w", err)
	}
	return nil
}