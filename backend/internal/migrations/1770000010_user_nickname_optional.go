// 1770000010_user_nickname_optional.go relaxes `users.nickname_normalized`
// from REQUIRED to optional.
//
// WHY. Migration 1770000009 (the soft delete) releases the nickname key of a
// deleted account by writing an empty string into `nickname_normalized` —
// the partial UNIQUE index (the one whose predicate excludes the empty key)
// only constrains non-empty keys, so an empty key frees the nickname for
// reuse. The write had to be a raw UPDATE because the column was REQUIRED,
// and a record save with an empty value is refused by validation
// ("cannot be blank").
//
// That left the row in a state where NO further write is possible. Proven:
//
//	soft-delete → Save(changed posts_count) →
//	  "nickname_normalized: cannot be blank."
//
// Every later counter move on that account dies: `adjustUserReputation`,
// `adjustUserPostCount` and `adjustUserTopicCount` all end in
// `txApp.Save(user)`. So a moderator deleting one of the deleted member's
// posts afterwards would get a 500, and `RecomputeUserCounters` could never
// repair the account. A soft-deleted account has to stay a WRITABLE row — it
// still holds the baked profile the forum renders, and the residue rules keep
// moving its counters.
//
// The empty value is already a legitimate state of this column: the identity
// migration (1766000000) creates the partial UNIQUE index precisely because
// "rows that predate the Aerun identity contract ... have no normalised
// nickname yet" and "the very first empty string would already collide with
// the next one" — the index, not the validation rule, is what enforces
// uniqueness. Relaxing the validation makes the schema agree with the index
// it was written for.
//
// This mirrors what 1767900000 did for `dm_messages.text`: a field whose
// content legitimately disappears is declared optional rather than kept
// required and worked around with raw SQL.
//
// The UNIQUE enforcement is unaffected: the index still constrains every live
// account's non-empty key, and the registration and rename commands still
// refuse a nickname that normalises to an empty key
// (auth.ValidateNickname).
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(addUserNicknameOptional, removeUserNicknameOptional)
}

func addUserNicknameOptional(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	field, ok := users.Fields.GetByName("nickname_normalized").(*core.TextField)
	if !ok {
		// A database whose column is missing or of another type is not this
		// migration's business: 1766000000 owns the column's shape.
		return nil
	}
	field.Required = false
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", "nickname_normalized", err)
	}
	return nil
}

// removeUserNicknameOptional restores the REQUIRED flag on rollback. The
// per-row values are NOT rewritten: a soft-deleted row keeps its empty key,
// and re-requiring the column only means such a row can no longer be saved
// through the record API — which is the state the schema had before the
// soft delete existed.
func removeUserNicknameOptional(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	if field, ok := users.Fields.GetByName("nickname_normalized").(*core.TextField); ok {
		field.Required = true
	}
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", "nickname_normalized", err)
	}
	return nil
}
