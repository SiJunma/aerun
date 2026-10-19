package pocketbase

import (
	"fmt"
	"net/http"

	"github.com/pocketbase/dbx"
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

// notDeletedUsersExpr is the SQL twin of isUserDeleted: it matches every
// account that is NOT soft-deleted.
//
// It exists because the two markers of a soft delete can arrive separately
// (see isUserDeleted), and a filter that only looked at `is_deleted` would
// keep showing — and keep reserving the nickname of — an account that a
// binary marked with `status = "deleted"` alone. The predicate and its SQL
// twin must agree, or "deleted" means two different things depending on
// which code path asks.
//
// The IS NULL arms are for rows written before the column existed: a row that
// predates `is_deleted` has no value there at all, and SQLite would drop the
// comparison rather than treat it as false.
func notDeletedUsersExpr() dbx.Expression {
	return dbx.NewExp(
		"(is_deleted = {:no} OR is_deleted IS NULL) AND (status IS NULL OR status != {:deleted})",
		dbx.Params{"no": false, "deleted": string(auth.StatusDeleted)},
	)
}

// requireLiveAccount refuses a MUTATING request from a soft-deleted account.
//
// WHY A CENTRAL GATE. A deleted account is out of circulation, but the check
// used to live in a fixed list of handlers (requireNotBanned), and a list is
// a promise the next handler breaks: createPostHandler, createTopicHandler,
// the draft commands, updateMyProfileHandler, updateSettingsHandler,
// uploadMyAvatarHandler, requireCharacterAuthor and the DM message editors
// never consulted the status, and categoryWriteAllowed grants access from the
// category's own role list — so it answers even when the narrowed permission
// set is empty. A deleted account could therefore keep creating content,
// editing its profile, changing its settings and managing its masks.
//
// The rule is enforced HERE, on the group, so it covers every mutating route
// including the ones added later. Reads stay open: the deleted account's
// profile, posts and history must keep rendering for everybody else.
//
// The token itself is also invalidated at delete time (see the admin delete
// command), so this gate is the second line: it refuses a request whose
// token was minted before the delete and has not expired yet.
func requireLiveAccount(e *core.RequestEvent) error {
	switch e.Request.Method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return e.Next()
	}
	acc := AccessFrom(e)
	if acc.Status == auth.StatusDeleted {
		return accountDeletedError("this account has been deleted; it cannot perform this action")
	}
	return e.Next()
}

// verifyDeletedUserSchema asserts at boot that users.is_deleted exists.
//
// It follows verifyPresenceSchema: apis.Serve applies every migration before
// OnServe runs, so a missing column means the binary and the data directory
// disagree, and the nickname-availability filter (which names the column)
// would answer 500 for every registration form instead of failing loudly
// here. Reads key off status == "deleted" too (see isUserDeleted), so this
// is purely the fail-fast half — the data path already degrades.
//
// The message names BOTH directions, because the operator hitting it cannot
// tell them apart from the symptom alone:
//   - a binary from before migration 1770000009 against a migrated data
//     directory (the column exists, the binary does not know about it);
//   - a data directory whose deletions were performed by an OLD binary, so
//     the rows carry the status marker but the column was never added —
//     the migration adds it on the next start, and the check is what turns
//     "the process refuses to start" into "here is what to do about it".
func verifyDeletedUserSchema(app core.App) error {
	users, err := app.FindCachedCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return fmt.Errorf("users collection unavailable: %w", err)
	}
	if users.Fields.GetByName(userIsDeletedField) == nil {
		return fmt.Errorf(
			"users.%s is missing: this binary and the data directory are out of sync "+
				"(migrations run automatically on start -- if you are seeing this, either "+
				"the process is running a build from before migration 1770000009, or the "+
				"data directory predates the soft delete and its deleted accounts carry only "+
				"the status marker. In the second case the migration adds the column on the "+
				"next start; in the first, deploy a current build. Until then every "+
				"nickname-availability check would fail)",
			userIsDeletedField)
	}
	return nil
}
