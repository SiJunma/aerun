package migrations

// 1770000013_character_mask_limit_setting.go adds `max_characters_per_user` to
// the forum settings singleton: the cap on how many masks (characters) ONE
// account may hold.
//
// WHY A SETTING AND NOT A CONSTANT. The cap lived in two places that no admin
// could see or change: the compiled `defaultCharacterLimit = 3` in
// characters.go, and the per-role `roles.max_characters_limit`, which every
// role carried at 0. The legacy app had no cap at all — the profile UI only
// checked CREATE_SELF_MASK before showing the "add" button — so 3 was a
// placeholder nobody had chosen, and it applied to every account in the
// forum. The other forum-wide caps (posts per page, topics per page, max
// posts per topic) already live in this row, and the mask cap joins them
// there: one read path, one number, adjustable by the panel.
//
// THE ROW IS REPAIRED, NOT ONLY THE SCHEMA. A NumberField with a Min reads
// an absent value as 0, and 0 is below the floor — so a database whose
// settings row predates this migration would come back with a cap of one mask
// instead of the default. Writing the value in the same migration that adds
// the column is what stops a forum from silently allowing one mask per
// account.
//
// Required stays FALSE, and so does the floor: the settings handler
// validates the range itself, and a required NumberField rejects 0 as a
// missing value — the same trap 1769100000 had to undo for
// max_chars_per_post.

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

func init() {
	m.Register(applyCharacterMaskLimitSetting, revertCharacterMaskLimitSetting)
}

func applyCharacterMaskLimitSetting(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}

	if col.Fields.GetByName("max_characters_per_user") == nil {
		col.Fields.Add(&core.NumberField{
			Name:     "max_characters_per_user",
			Min:      float64Ptr(float64(auth.MinMaxCharactersPerUser)),
			Max:      float64Ptr(float64(auth.HardMaxCharactersPerUser)),
			Required: false,
		})
		if err := app.Save(col); err != nil {
			return err
		}
	}

	// Seed the existing row so an untouched forum reads the default rather
	// than the floor. The write is skipped when the value is already there,
	// so a re-run never overwrites an admin's choice.
	record, err := app.FindRecordById("forum_settings", "forumsettings01")
	if err != nil || record == nil {
		// Nothing to repair — an absent row already reads as the default.
		return nil
	}
	if record.GetInt("max_characters_per_user") > 0 {
		return nil
	}
	record.Set("max_characters_per_user", auth.DefaultMaxCharactersPerUser)
	if err := app.Save(record); err != nil {
		return fmt.Errorf("seed max_characters_per_user: %w", err)
	}
	return nil
}

func revertCharacterMaskLimitSetting(app core.App) error {
	col, err := app.FindCollectionByNameOrId("forum_settings")
	if err != nil {
		return err
	}
	if col.Fields.GetByName("max_characters_per_user") == nil {
		return nil
	}
	col.Fields.RemoveByName("max_characters_per_user")
	return app.Save(col)
}
