// 1770000014_user_email_optional.go relaxes `users.email` from REQUIRED to optional.
//
// WHY. Migration 1770000009 (the soft delete) releases the nickname key of a
// deleted account, and now this migration releases its email address: at delete
// time the admin delete command writes an empty string into `email`. The users
// collection carries a partial UNIQUE index on email (`WHERE email != ”`),
// so an empty email frees the address for reuse by a fresh registration.
// The write had to relax the field because `EmailField` is REQUIRED by default,
// and a record save with an empty email is refused by validation ("cannot be
// blank").
//
// The empty value is already a legitimate state of this column: PocketBase's
// own unique index excludes the empty string, so uniqueness is enforced by the
// index, not by the validation rule. Relaxing the validation makes the schema
// agree with the index it was written for, exactly as 1770000010 did for
// nickname_normalized.
//
// The UNIQUE enforcement is unaffected: the index still constrains every live
// account's non-empty email, and the registration command still refuses an
// address already held by a live account.
//
// No backfill: every pre-migration row carries its real email. Only rows the
// admin delete command touches go empty, and those rows are soft-deleted and
// out of circulation.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(addUserEmailOptional, removeUserEmailOptional)
}

func addUserEmailOptional(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	field, ok := users.Fields.GetByName("email").(*core.EmailField)
	if !ok {
		// A database whose column is missing or of another type is not this
		// migration's business: the PocketBase scaffold owns the email field.
		return nil
	}
	field.Required = false
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", "email", err)
	}
	return nil
}

// removeUserEmailOptional restores the REQUIRED flag on rollback. The per-row
// values are NOT rewritten: a soft-deleted row keeps its empty email, and
// re-requiring the column only means such a row can no longer be saved through
// the record API.
func removeUserEmailOptional(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	if field, ok := users.Fields.GetByName("email").(*core.EmailField); ok {
		field.Required = true
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", "email", err)
	}
	return nil
}
