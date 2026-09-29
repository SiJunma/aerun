package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// userLastSeenField is the durable "when was this account last here" column.
// It is the one value the members table's LAST SEEN column can always fall
// back to, so the frontend contract depends on it never being empty.
const userLastSeenField = "last_seen"

// 1767300000_user_last_seen.go restores `users.last_seen`, the one piece of the
// legacy presence contract that the PocketBase port dropped.
//
// The legacy Firestore document carried it, fed by a Cloud Function from the
// RTDB status node:
//
//	"last_seen":    "number (serverTimestamp ms)"
//	"last_activity": "number (serverTimestamp ms, persistent visit timestamp)"
//	// functions/index.js: last_activity "is the persistent visit timestamp --
//	// it is NOT reset on logout or idle, so this always reflects the user's
//	// real last action."
//
// That distinction was the whole point: `last_seen` (online now) and
// `last_activity` (last visit) were two different clocks, and the persistent one
// survived going offline. This backend kept only the first clock — the
// in-process member map in presence.go, which is discarded 75 seconds after the
// last heartbeat and vanishes on restart — and dropped the second one entirely.
// So the members table had nothing to render for any user who was not currently
// connected, and the column degraded to "..." permanently rather than
// transiently. The frontend comment above getUserLastSeen documented the
// absence as a deliberate choice; it was actually a missing column.
//
// Why not reuse the `updated` autodate, which PocketBase does have:
// `updated` is a record *edit* time. It moves on every import run and every
// settings write, so for an imported account it reads as the date of the import
// and for an active one as the date of the last profile save. Neither is when
// the person was last on the forum. A column that answers a different question
// is worse than no column, which is why the honest answer is a real column.
//
// The column is server-owned (collection rules stay locked — the browser cannot
// write it, plan invariant 2) and is written by exactly two paths: the
// authenticated heartbeat (presence.go) and account creation. No browser value
// is ever trusted for it.
//
// The backfill deliberately starts at `created`, not at `updated`. Registration
// is real activity that provably happened, so it is a true lower bound and it
// satisfies the "never empty" contract for every existing row the moment this
// migration runs, with no dependency on the importer. The real legacy activity
// timestamps are better than this and are recovered separately: import-users
// carries the snapshot's `users.last_seen`, and it only ever moves the column
// FORWARD, so replaying a dump cannot rewind an account that has been active
// since. (That monotonic rule is the same shape as avatarURLToWrite's "once
// migrated, the local file wins" guard, and for the same reason: a fresh dump
// re-run is a routine release-day operation, and it must not look like change.)
//
// No `updated` bump: the backfill is a raw UPDATE, which bypasses the autodate
// interceptor entirely, so account edit times do not move even once. That is
// incidental rather than designed — it falls out of needing to avoid record
// validation — but it is worth stating, because `updated` is the one column the
// members table must never read as a visit time, and a migration that shifted it
// for every account would be a poor advertisement for the new one.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return addUserLastSeen(app)
	}, func(app core.App) error {
		return removeUserLastSeen(app)
	})
}

func addUserLastSeen(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	ensureField(users, &core.DateField{Name: userLastSeenField})
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", userLastSeenField, err)
	}
	return backfillUserLastSeen(app)
}

// backfillUserLastSeen seeds the column for every account that predates it.
//
// It is a single UPDATE rather than a loop of record saves, and that choice is
// load-bearing for two reasons.
//
// First, a record save runs full field validation. The populated PocketBase
// fixture — and any real database that predates the Aerun identity contract —
// holds accounts with no nickname, role or status, so `app.Save` on one of
// those fails with "nickname: cannot be blank" and the whole migration aborts.
// A migration must be applicable to exactly the databases that need it, so it
// cannot go through the API-level validation path.
//
// Second, it is a column copy, so copying the stored text is both exact and
// format-independent: PocketBase serialises a date field through
// types.DateTime.Value(), which is the same DefaultDateLayout string for every
// date column in the schema, and renders the zero time as an empty string.
// Copying `created` verbatim therefore lands in `last_seen` in precisely the
// representation the field expects, with no parse/format round trip to get
// wrong — and the `= ”` in the guard below is that same empty-string zero.
//
// The guard is the never-clobber rule: a row that already holds a value keeps
// it, so re-entering this after a restore cannot undo a timestamp a heartbeat
// has since advanced.
func backfillUserLastSeen(app core.App) error {
	_, err := app.DB().NewQuery(
		"UPDATE `users` SET `last_seen` = `created` WHERE `last_seen` IS NULL OR `last_seen` = ''",
	).Execute()
	if err != nil {
		return fmt.Errorf("backfill %s: %w", userLastSeenField, err)
	}
	return nil
}

// removeUserLastSeen restores the pre-1767300000 shape for the down path. The
// stored timestamps are NOT cleared: downgrading a schema must not destroy data,
// and the next upgrade re-derives the column from `created` anyway.
func removeUserLastSeen(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	users.Fields.RemoveByName(userLastSeenField)
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users %s field: %w", userLastSeenField, err)
	}
	return nil
}
