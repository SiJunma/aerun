package pocketbase

// User counter recompute (post-import pass, map §5 "derived data is
// recomputed, never copied").
//
// The legacy snapshot carries cached post_count/topics_count/reputation values
// and the rehearsal already reports where they disagree with the real rows
// (importer.Reconcile). Those cached numbers are never written to the target:
// this pass derives every counter from the rows that actually exist, which is
// the only value that cannot go stale.
//
// It is also the repair tool. A counter that is only ever moved by a command
// starts at zero, so a database populated by the import (or by direct PB edits)
// has correct columns and wrong numbers until this runs. It is idempotent: it
// recomputes from the rows every time, so running it twice is
// indistinguishable from running it once, and a value that is already correct
// is reported as unchanged rather than rewritten.
//
// The post/topic predicates are the ones the schema documents: non-deleted
// rows, drafts excluded. They are stated as SQL here rather than reusing the
// command layer's incremental arithmetic on purpose — an independent
// derivation is what makes this a real recompute instead of a second place
// that can drift the same way.

import (
	"fmt"
	"sort"

	"github.com/pocketbase/pocketbase/core"
)

// UserCounterRecomputeReport states what a recompute run changed.
type UserCounterRecomputeReport struct {
	// Updated and Unchanged hold user record ids (not legacy uids): this pass
	// works on the target rows and never reads the staging ledger, so the id is
	// the only identity both sides share.
	Updated   []string
	Unchanged []string
	// Values maps a user id to the counters the pass derived for it, so a run
	// is auditable: "why does this member have 4 posts" is answerable from the
	// report without querying the database. It is populated in dry runs too.
	Values map[string]UserCounters
}

// UserCounters is one user's derived activity counters.
type UserCounters struct {
	Posts  int
	Topics int
	Rep    int
}

// Changed reports whether the recompute modified anything.
func (r UserCounterRecomputeReport) Changed() bool {
	return len(r.Updated) > 0
}

// UserCounterRecomputeOptions configures one pass.
type UserCounterRecomputeOptions struct {
	// DryRun derives every counter and reports the result without writing, so
	// the operator can see the exact outcome against a snapshot first. The
	// derivation is identical to a real run — only the Save is skipped — so
	// "would_update=N" is a promise the real run keeps.
	DryRun bool
}

// RecomputeUserCounters rebuilds users.posts_count, users.topics_count and
// users.reputation from the posts, topics and reputation_votes rows.
//
// reputation is recomputed too even though the command layer already maintains
// it: the vote commands only run from the cutover onwards, so an imported
// database has no votes to have moved it, and the legacy reputation logs are
// the authority for the pre-cutover period.
//
// The whole pass runs in one transaction: a failure halfway through would leave
// half the board with real counts and half with zeros, which is worse than not
// having run at all because it looks authoritative.
func RecomputeUserCounters(app core.App, opts UserCounterRecomputeOptions) (UserCounterRecomputeReport, error) {
	report := UserCounterRecomputeReport{Values: map[string]UserCounters{}}

	postsCount, err := countByAuthor(app, postsCollectionName, countablePostRows)
	if err != nil {
		return UserCounterRecomputeReport{}, fmt.Errorf("count posts: %w", err)
	}
	topicsCount, err := countByAuthor(app, topicsCollectionName, countableTopicRows)
	if err != nil {
		return UserCounterRecomputeReport{}, fmt.Errorf("count topics: %w", err)
	}
	reputation, err := sumVotes(app)
	if err != nil {
		return UserCounterRecomputeReport{}, fmt.Errorf("sum reputation: %w", err)
	}

	usersCol, err := app.FindCollectionByNameOrId(usersCollectionName)
	if err != nil {
		return UserCounterRecomputeReport{}, fmt.Errorf("users collection unavailable: %w", err)
	}
	// A collection that predates 1767100000 has no counter columns. Adding them
	// is the migration's job, so the pass reports nothing rather than writing a
	// column that does not exist.
	if usersCol.Fields.GetByName("posts_count") == nil ||
		usersCol.Fields.GetByName("topics_count") == nil ||
		usersCol.Fields.GetByName("reputation") == nil {
		return report, fmt.Errorf(
			"users collection has no counter columns; run the migrations first")
	}

	users, err := app.FindAllRecords(usersCol)
	if err != nil {
		return UserCounterRecomputeReport{}, fmt.Errorf("read users: %w", err)
	}
	for _, rec := range users {
		report.Values[rec.Id] = UserCounters{
			Posts:  postsCount[rec.Id],
			Topics: topicsCount[rec.Id],
			Rep:    reputation[rec.Id],
		}
	}

	if opts.DryRun {
		for _, rec := range users {
			if userCountersCurrent(rec, report.Values[rec.Id]) {
				report.Unchanged = append(report.Unchanged, rec.Id)
				continue
			}
			report.Updated = append(report.Updated, rec.Id)
		}
		sort.Strings(report.Updated)
		sort.Strings(report.Unchanged)
		return report, nil
	}

	err = app.RunInTransaction(func(txApp core.App) error {
		for _, rec := range users {
			want := report.Values[rec.Id]
			if userCountersCurrent(rec, want) {
				report.Unchanged = append(report.Unchanged, rec.Id)
				continue
			}

			rec.Set("posts_count", want.Posts)
			rec.Set("topics_count", want.Topics)
			rec.Set("reputation", want.Rep)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update counters for %s: %w", rec.Id, err)
			}
			report.Updated = append(report.Updated, rec.Id)
		}
		return nil
	})
	if err != nil {
		return UserCounterRecomputeReport{}, err
	}

	sort.Strings(report.Updated)
	sort.Strings(report.Unchanged)
	return report, nil
}

// userCountersCurrent reports whether a record already holds the derived
// values, which is what makes the pass idempotent: a correct row is left
// alone and reported as unchanged instead of being rewritten on every run.
func userCountersCurrent(rec *core.Record, want UserCounters) bool {
	return rec.GetInt("posts_count") == want.Posts &&
		rec.GetInt("topics_count") == want.Topics &&
		rec.GetInt("reputation") == want.Rep
}

// adjustUserPostCount moves a user's denormalized post counter by delta inside
// the caller's transaction.
//
// It refuses to go below zero and clamps there instead of writing a negative
// number: a counter that reads -1 is a bug report waiting to happen, whereas a
// counter stuck at 0 is merely imprecise and is repaired by
// RecomputeUserCounters. The clamp is the second line of defence — the first is
// that every caller moves the counter in the same transaction as the row that
// justifies the move, so the two cannot disagree after a crash.
//
// A user id that does not resolve is NOT an error. Posts and topics are
// imported with author ids mapped through the identity table, and a post whose
// author was dropped has no users row to write to. Failing the whole
// transaction there would make one orphan post block a topic from being
// created.
func adjustUserPostCount(txApp core.App, userID string, delta int) error {
	return adjustUserCount(txApp, userID, "posts_count", delta)
}

// adjustUserTopicCount is adjustUserPostCount for topics_count.
func adjustUserTopicCount(txApp core.App, userID string, delta int) error {
	return adjustUserCount(txApp, userID, "topics_count", delta)
}

func adjustUserCount(txApp core.App, userID, field string, delta int) error {
	if userID == "" || delta == 0 {
		return nil
	}
	usersCol, err := txApp.FindCachedCollectionByNameOrId(usersCollectionName)
	if err != nil || usersCol == nil || usersCol.Fields.GetByName(field) == nil {
		// Pre-1767100000 collection; the recompute pass is the fix.
		return nil
	}
	user, err := txApp.FindRecordById(usersCol, userID)
	if err != nil || user == nil {
		// See the doc comment: an unresolvable author is not fatal.
		return nil
	}
	next := user.GetInt(field) + delta
	if next < 0 {
		next = 0
	}
	user.Set(field, next)
	if err := txApp.Save(user); err != nil {
		return internalError("failed to update user "+field, err)
	}
	return nil
}

// countablePostRows and countableTopicRows are the two predicates the counters
// are defined by. They are separate statements, not one shared query with a
// NULL-tolerant extra condition: `topics` has no `is_draft` column at all, and
// SQLite raises "no such column" on an unknown identifier rather than treating
// it as NULL, so a single statement covering both tables would fail outright
// the moment it was pointed at topics.
//
// A post is countable when it is not soft-deleted and not a draft: an unsent
// draft is authored content the forum never showed, so counting it would make a
// member's number disagree with what the forum displays. A topic is countable
// when it is not soft-deleted. Both tables carry a `deleted` column written as
// false by the command layer, so `= false` is exact.
const (
	countablePostRows  = "deleted = false AND is_draft = false"
	countableTopicRows = "deleted = false"
)

// countByAuthor counts the countable rows of a collection per author_id.
//
// The table name and the predicate are interpolated because SQLite cannot bind
// either. Both call sites pass a package constant, never request data, so there
// is no injection surface here.
func countByAuthor(app core.App, collection, predicate string) (map[string]int, error) {
	type authorCount struct {
		AuthorID string `db:"author_id"`
		Cnt      int    `db:"cnt"`
	}
	var rows []authorCount
	if err := app.DB().NewQuery(fmt.Sprintf(
		"SELECT author_id, COUNT(*) AS cnt FROM %s WHERE %s GROUP BY author_id",
		collection, predicate,
	)).All(&rows); err != nil {
		return nil, err
	}

	out := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.AuthorID == "" {
			continue
		}
		out[row.AuthorID] = row.Cnt
	}
	return out, nil
}

// sumVotes sums reputation_votes per target_id.
//
// EVERY vote counts — profile votes and post votes alike. This was previously
// restricted to profile votes (`post_id = ”`) on the reasoning that a post vote
// "already moved the author as a side effect", so counting it again would double
// it. That reasoning was wrong in a way that mattered: the side effect it named
// is exactly the thing being recomputed. A post vote moves BOTH posts.reputation
// and users.reputation in one command (reputation.go, the create and replace
// paths both do `targetUser.Set("reputation", ... + val)`), so leaving post votes
// out rebuilds a base that the command layer does not agree with — the first live
// post vote after cutover would move a member by a delta computed from a
// different total than every other vote they ever received.
//
// Checked against the 2026-09 export rather than argued: the legacy cached
// `reputation` matches the all-votes sum for 10 of 11 users, and the
// profile-only sum for 4. The single all-votes mismatch is off by one point,
// which is the legacy cache drift this whole pass exists to discard.
//
// The two partial unique indexes from 1766300000 still make the sum safe: one
// vote per (voter, post) and one per (voter, profile), so re-voting replaces
// rather than accumulates and the total cannot be inflated.
func sumVotes(app core.App) (map[string]int, error) {
	type targetTotal struct {
		TargetID string `db:"target_id"`
		Total    int    `db:"total"`
	}
	var rows []targetTotal
	if err := app.DB().NewQuery(
		"SELECT target_id, SUM(value) AS total FROM reputation_votes GROUP BY target_id",
	).All(&rows); err != nil {
		return nil, err
	}

	out := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.TargetID == "" {
			continue
		}
		out[row.TargetID] = row.Total
	}
	return out, nil
}
