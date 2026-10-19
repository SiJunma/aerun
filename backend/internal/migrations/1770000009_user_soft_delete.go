// 1770000009_user_soft_delete.go adds the soft-delete flag for forum accounts.
//
// A deleted account keeps its users row: nickname, avatar and counters stay
// baked in so the profile page and the author's posts keep rendering with the
// name the account had while alive. The row is taken out of circulation by
// three coordinated writes the admin delete command makes in one transaction:
//   - is_deleted = true (this flag),
//   - status = "deleted" (auth.StatusDeleted — not in AllStatuses, so the
//     permission narrowing denies everything and the row can never act again),
//   - nickname_normalized = "" (the partial UNIQUE index only constrains
//     non-empty keys, so a fresh registration may reuse the nickname).
//
// No backfill: every pre-migration row is a live account, and GetBool reports
// false for the missing column on an unmigrated fixture — the same zero value
// the column carries. The runtime ALSO keys off status == "deleted" (see
// isUserDeleted in the pocketbase package), so a row soft-deleted by a binary
// that has the status but not yet this column still reads as deleted.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// userIsDeletedField is the soft-delete flag on the users collection.
const userIsDeletedField = "is_deleted"

func init() {
	m.Register(func(app core.App) error {
		return addUserIsDeleted(app)
	}, func(app core.App) error {
		return removeUserIsDeleted(app)
	})
}

func addUserIsDeleted(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	if users.Fields.GetByName(userIsDeletedField) == nil {
		users.Fields.Add(&core.BoolField{Name: userIsDeletedField})
	}
	// The status select must be able to HOLD "deleted": users.status was born
	// a SelectField (1766000000) and record validation checks the stored value
	// against this list on EVERY save — a row soft-deleted by the admin
	// command would otherwise fail every later write to it (counter moves,
	// presence, notification settings) with "invalid options".
	//
	// Rewritten from auth.AllStatusValues() rather than appended to: a fresh
	// install already sets the list from the same function, and an old
	// database carries the pre-soft-delete three — converging both on the
	// function keeps identity_test's equality assertion the single source.
	// The value stays NON-ASSIGNABLE: admin status forms validate with
	// Status.IsValid(), which does not include it.
	if sel, ok := users.Fields.GetByName("status").(*core.SelectField); ok {
		sel.Values = auth.AllStatusValues()
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", userIsDeletedField, err)
	}
	return nil
}

// removeUserIsDeleted restores the pre-migration shape for the down path. The
// per-row flag values are NOT cleared: downgrading a schema must not destroy
// data, and the status == "deleted" marker keeps every soft-deleted row out of
// circulation even without the column. The widened status select values are
// kept for the same reason — a row already holding "deleted" must stay
// saveable (the stored value would otherwise fail validation on every later
// write), and the pre-down assignable set is enforced by Status.IsValid(),
// not by the select list.
func removeUserIsDeleted(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	users.Fields.RemoveByName(userIsDeletedField)
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", userIsDeletedField, err)
	}
	return nil
}
