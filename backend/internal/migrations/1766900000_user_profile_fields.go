package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1766900000_user_profile_fields.go resolves the open TODO of
// POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md §4 ("profile fields — either explicit
// fields or inside settings JSON") in favour of explicit columns.
//
// Why columns and not settings JSON:
//
//   - The legacy Firestore document stored them flat on the user document and
//     the adapted frontend still reads them flat
//     (src/pages/ProfilePage.jsx: `source.bio`, `source.location`,
//     `source.status_line`, …) — there is no adapter that could read them out
//     of a nested blob, so a JSON-only home would make every imported profile
//     render empty.
//   - These are fixed, known fields, not free-form preferences. The open-ended
//     part of the legacy document — theme, language, signature, notification
//     switches, sound, reputation visibility — stays in `users.settings`
//     verbatim, because that is exactly where the frontend reads it
//     (`settings.theme`, `settings.signature`, `settings.notifications.…`).
//
// `admin_message` is deliberately absent: it is a message *to the moderator*
// (src/i18n/dictionary.js: "This message will only be seen by the moderator"),
// and the only users read rule publishes every active profile. It therefore
// cannot live in a publicly readable column, and the importer reports it as a
// finding instead of leaking it (see importer/users.go).
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return addUserProfileFields(app)
	}, func(app core.App) error {
		return removeUserProfileFields(app)
	})
}

// userProfileFields are the legacy profile columns. Max sizes follow the
// legacy document's practical bounds: bio is the longest free text, the rest
// are single-line values.
func userProfileFields() []core.Field {
	return []core.Field{
		&core.TextField{Name: "bio", Max: 2048},
		&core.TextField{Name: "location", Max: 128},
		&core.TextField{Name: "birthday", Max: 64},
		&core.TextField{Name: "occupation", Max: 128},
		&core.TextField{Name: "interests", Max: 512},
		&core.TextField{Name: "contacts", Max: 512},
		&core.TextField{Name: "status_line", Max: 256},
		&core.TextField{Name: "last_selected_character_id", Max: 64},
	}
}

// addUserProfileFields adopts every field that is not present yet, so the
// migration is safe on a database that already carries one of them.
//
// The collection is loaded as a detached copy (mutateCollectionForSchema):
// PocketBase derives the "old" schema of a collection save from the *cached*
// instance, so mutating the cached copy in place would leave the new columns
// out of the record table (see 1766500000).
func addUserProfileFields(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	for _, field := range userProfileFields() {
		ensureField(users, field)
	}
	return app.Save(users)
}

// removeUserProfileFields restores the pre-1766900000 shape for the down path.
func removeUserProfileFields(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	for _, field := range userProfileFields() {
		users.Fields.RemoveByName(field.GetName())
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users profile fields: %w", err)
	}
	return nil
}
