package pocketbase

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"

	"github.com/SiJunma/aerun/backend/internal/auth"
)

// userIsDeletedField mirrors the migrations package spelling by repo
// convention (cf. topicsCollectionName vs topicsCollectionTable): each
// package owns its own copy of the column name.
const userIsDeletedField = "is_deleted"

// isUserDeleted reports whether a users row is a soft-deleted account.
//
// It keys off BOTH markers the admin delete command writes, because either
// one can arrive without the other:
//   - status == "deleted" is written by every binary that knows
//     auth.StatusDeleted, even against a data directory whose users
//     collection predates the is_deleted column;
//   - is_deleted is the explicit flag the new column carries.
//
// A nil record is not deleted: callers that already treat a missing row as
// "not found" keep that branch, and this predicate never turns it into
// "deleted".
func isUserDeleted(record *core.Record) bool {
	if record == nil {
		return false
	}
	if record.GetString("status") == string(auth.StatusDeleted) {
		return true
	}
	return record.GetBool(userIsDeletedField)
}

// verifyDeletedUserSchema asserts at boot that users.is_deleted exists.
//
// It follows verifyPresenceSchema: apis.Serve applies every migration before
// OnServe runs, so a missing column means the binary and the data directory
// disagree, and the nickname-availability filter (which names the column)
// would answer 500 for every registration form instead of failing loudly
// here. Reads key off status == "deleted" too (see isUserDeleted), so this
// is purely the fail-fast half — the data path already degrades.
func verifyDeletedUserSchema(app core.App) error {
	users, err := app.FindCachedCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return fmt.Errorf("users collection unavailable: %w", err)
	}
	if users.Fields.GetByName(userIsDeletedField) == nil {
		return fmt.Errorf(
			"users.%s is missing: this binary and the data directory are out of sync "+
				"(migrations run automatically on start -- if you are seeing this, the "+
				"process is running a build from before migration 1770000009, and every "+
				"nickname-availability check would fail)",
			userIsDeletedField)
	}
	return nil
}
