package migrations

// 1767700000_drop_deleted_flag.go removes the `deleted` flag from `posts` and
// `topics`, making deletion HARD.
//
// The flag came from 1766100000 as a soft-delete tombstone: a deleted post kept
// its row and its `sequence` slot and only lost its text, so the UI rendered
// "this post was deleted" in place. That was a product assumption rather than a
// requirement, and it is being reversed:
//
//   - It never matched the Firestore era this branch migrates from. There,
//     deletion cascaded and was irreversible — which is what the 2026-09-30
//     incident cost.
//   - It does not match the reference engine (MyBB), where a deleted post is
//     simply gone: not listed, not numbered, not counted.
//   - It is actively harmful here. `listPostsHandler` filters drafts only, so a
//     tombstone occupied a real slot in the feed while `posts_count` counted
//     `deleted = false`. The counter and the feed disagreed by construction, and
//     the counter IS the pagination window (TopicPage derives totalPages from
//     it) — the "posts appear on two pages" drift the incident doc lists as
//     uninvestigated.
//
// The column is dropped rather than left at a constant `false`. A column that is
// always false is indistinguishable from a real feature to the next reader, and
// this project has already paid for one such illusion: the declaration block in
// src/api/dm-cache.js read as deliberate because a `/* global */` comment sat
// above it. See .agents/AGENTS.md.
//
// ROWS FIRST, THEN THE COLUMN. A row flagged `deleted` must actually go, or
// dropping the column would resurrect it as a normal, fully visible post — the
// exact opposite of the delete that was requested. So this purges first:
//   - deleted POSTS: content is already empty, so the row is pure residue.
//   - deleted TOPICS: their posts still exist and are readable, so both the
//     topic and every post under it must go, or the thread reappears orphaned.
// On the 2026-09-18 snapshot there are none of either (0 of 3123 posts, 0 of 34
// topics), so this is a no-op in practice — but it is written to be correct
// against any database, including a restored snapshot.
//
// Counters are NOT repaired here: a column that counted rows this migration
// deletes is wrong on the same database, and `RecomputeUserCounters` is the tool
// that rebuilds it. Run it after this migration — the command layer now
// decrements on the hard delete itself, so the two then agree.
//
// A new migration rather than an edit to 1766100000 because an applied
// migration must never be rewritten: the plan says so, and editing the create
// would not re-run on an existing database anyway.

import (
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		return dropDeletedFlags(app)
	}, func(app core.App) error {
		// Rollback restores the columns as constant false. Rows the forward pass
		// deleted cannot be resurrected — their content is gone by design — so
		// this is lossy on purpose rather than silently fabricating rows.
		return restoreDeletedFlags(app)
	})
}

// dropDeletedFlags purges every row the flag marks, then removes the columns.
func dropDeletedFlags(app core.App) error {
	deletedPosts, err := findFlagged(app, postsCollectionTable)
	if err != nil {
		return fmt.Errorf("posts marked deleted: %w", err)
	}
	deletedTopics, err := findFlagged(app, topicsCollectionTable)
	if err != nil {
		return fmt.Errorf("topics marked deleted: %w", err)
	}

	// Posts under a deleted topic go with it. Collected BEFORE anything is
	// removed, so no read in this loop can miss a row because its parent is
	// already gone — the ordering defect that left the original incident's
	// per-author decrement without an owner.
	var orphans []string
	for _, topicID := range deletedTopics {
		if err := collectChildren(app, postsCollectionTable, "topic_id", topicID, &orphans); err != nil {
			return fmt.Errorf("posts of deleted topic %s: %w", topicID, err)
		}
	}

	for _, id := range orphans {
		if err := deleteRow(app, postsCollectionTable, id); err != nil {
			return fmt.Errorf("delete orphan post %s: %w", id, err)
		}
	}
	for _, id := range deletedPosts {
		if err := deleteRow(app, postsCollectionTable, id); err != nil {
			return fmt.Errorf("delete post %s: %w", id, err)
		}
	}
	for _, id := range deletedTopics {
		if err := deleteRow(app, topicsCollectionTable, id); err != nil {
			return fmt.Errorf("delete topic %s: %w", id, err)
		}
	}

	for _, table := range []string{postsCollectionTable, topicsCollectionTable} {
		col, err := mutateCollectionForSchema(app, table)
		if err != nil {
			return fmt.Errorf("%s collection: %w", table, err)
		}
		col.Fields.RemoveByName("deleted")
		if err := app.Save(col); err != nil {
			return fmt.Errorf("drop %s.deleted: %w", table, err)
		}
	}
	return nil
}

func restoreDeletedFlags(app core.App) error {
	for _, table := range []string{postsCollectionTable, topicsCollectionTable} {
		col, err := mutateCollectionForSchema(app, table)
		if err != nil {
			return fmt.Errorf("%s collection: %w", table, err)
		}
		if col.Fields.GetByName("deleted") == nil {
			col.Fields.Add(&core.BoolField{Name: "deleted"})
		}
		if err := app.Save(col); err != nil {
			return fmt.Errorf("restore %s.deleted: %w", table, err)
		}
	}
	return nil
}

// findFlagged returns the ids of every row whose `deleted` flag is true.
//
// Reads the column directly rather than through a record query: the column may
// already be gone (a re-run, or a database restored from a newer snapshot), and
// a missing column must mean "nothing to purge", not a crash.
func findFlagged(app core.App, table string) ([]string, error) {
	rows := []struct {
		ID string `db:"id"`
	}{}
	if err := app.DB().NewQuery(
		fmt.Sprintf("SELECT id FROM %s WHERE deleted = true", table),
	).All(&rows); err != nil {
		if isMissingColumn(err) {
			return nil, nil
		}
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids, nil
}

// collectChildren appends every row whose `parent` column equals `parentID`.
func collectChildren(app core.App, table, parent, parentID string, out *[]string) error {
	rows := []struct {
		ID string `db:"id"`
	}{}
	// Table and column are package constants, never request data, so
	// interpolating them adds no injection surface — SQLite cannot bind an
	// identifier at all.
	if err := app.DB().NewQuery(fmt.Sprintf(
		"SELECT id FROM %s WHERE %s = {:parent}", table, parent,
	)).Bind(dbx.Params{"parent": parentID}).All(&rows); err != nil {
		return err
	}
	for _, r := range rows {
		*out = append(*out, r.ID)
	}
	return nil
}

// deleteRow removes one row by id, together with every row that references it.
//
// The referencing rows go in the same transaction because after this migration
// nothing can ever reach them again to reconcile them: the record they point at
// is gone, so the cleanup has to happen here or it leaves exactly the residue
// the 2026-09-30 incident was about — a subscription pinning a topic id nobody
// can open, votes paying a score for content that no longer exists.
func deleteRow(app core.App, table, id string) error {
	switch table {
	case postsCollectionTable:
		if err := deleteReferencing(app, reputationVotesCollectionTable, "post_id", id); err != nil {
			return err
		}
	case topicsCollectionTable:
		if err := deleteReferencing(app, reputationVotesCollectionTable, "topic_id", id); err != nil {
			return err
		}
		if err := deleteReferencing(app, topicSubscriptionsCollectionTable, "topic_id", id); err != nil {
			return err
		}
	}
	_, err := app.DB().NewQuery(
		fmt.Sprintf("DELETE FROM %s WHERE id = {:id}", table),
	).Bind(dbx.Params{"id": id}).Execute()
	return err
}

func deleteReferencing(app core.App, table, column, id string) error {
	_, err := app.DB().NewQuery(fmt.Sprintf(
		"DELETE FROM %s WHERE %s = {:id}", table, column,
	)).Bind(dbx.Params{"id": id}).Execute()
	if err != nil && !isMissingColumn(err) {
		return err
	}
	return nil
}

// isMissingColumn reports whether an error is SQLite saying the column is not
// there. Needed because this migration runs UP against a database that may
// already lack the column, and the normal "record not found" check does not
// cover a schema error.
func isMissingColumn(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "no such column") ||
		strings.Contains(msg, "has no column") ||
		strings.Contains(msg, "no field named")
}
