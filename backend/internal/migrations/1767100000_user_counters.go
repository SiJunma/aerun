package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

// 1767100000_user_counters.go gives `users` its denormalized activity counters.
//
// Sprint 2 added `users.reputation` (1766300000) and the command layer keeps it
// current from live votes, but `users` never got a post or topic counter, while
// `topics` has carried `posts_count` since 1766100000. That left the members
// table sorting on `post_count` and `reputation` against two different
// vocabularies: the frontend reads the legacy Firestore names, while the
// database only had the reputation one — and had it at zero for every account,
// because a counter that is only ever moved by a command that has not run yet
// starts at nothing. The legacy values were deliberately not imported (map §5:
// derived data is recomputed, never copied), so the columns have to exist and a
// pass has to fill them from the actual rows.
//
// Definitions are pinned to the rows, not to events, so every counter can be
// rebuilt from scratch and cannot silently drift:
//
//   - `posts_count`  — posts rows with author_id = user and deleted = false.
//     This is the SAME predicate `topics.posts_count` uses (a topic counts its
//     non-deleted posts), so a post is counted once on its topic and once on
//     its author, and a soft-deleted topic does NOT subtract from its author's
//     total: the posts still exist. Drafts are excluded (is_draft = true) — an
//     unsent draft is not a post, matching the importer's counter rules.
//   - `topics_count` — topics rows with author_id = user and deleted = false.
//
// Both default to 0, are never written by a browser (the collection rules stay
// locked), and are maintained inside the same transaction as the post/topic
// mutation. RecomputeUserCounters (internal/platform/pocketbase) rebuilds them
// from the rows for the post-import pass.
//
// Future sprints append new timestamped migrations; never edit an applied
// migration, always add a new one.
func init() {
	m.Register(func(app core.App) error {
		return addUserCounterFields(app)
	}, func(app core.App) error {
		return removeUserCounterFields(app)
	})
}

func addUserCounterFields(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	ensureField(users, &core.NumberField{Name: "posts_count", OnlyInt: true})
	ensureField(users, &core.NumberField{Name: "topics_count", OnlyInt: true})
	// 1766300000 already added reputation; re-asserted so a database restored
	// from an older snapshot still ends up with the full counter set.
	ensureField(users, &core.NumberField{Name: "reputation", OnlyInt: true})
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users counter fields: %w", err)
	}
	return nil
}

// removeUserCounterFields restores the pre-1767100000 shape for the down path.
// The stored numbers are NOT cleared: downgrading a schema must not destroy
// data, and the next upgrade recomputes them from the rows anyway.
func removeUserCounterFields(app core.App) error {
	users, err := mutateCollectionForSchema(app, usersCollectionName)
	if err != nil {
		return err
	}
	users.Fields.RemoveByName("posts_count")
	users.Fields.RemoveByName("topics_count")
	if err := app.Save(users); err != nil {
		return fmt.Errorf("users counter fields: %w", err)
	}
	return nil
}
