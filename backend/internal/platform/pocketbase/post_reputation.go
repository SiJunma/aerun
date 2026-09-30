package pocketbase

// Post reputation recompute (post-import pass).
//
// `posts.reputation` is derived data — the sum of every vote cast on that post —
// and the importer deliberately does not copy the legacy cached number into it.
// The comment on PostRow.Reputation has said so since it was written, but the
// planner was still reading `intField(fields, "reputation")`, so the comment and
// the code disagreed and the cached value shipped. This pass is what makes the
// comment true.
//
// It also repairs any database whose posts.reputation drifted, and it runs in one
// transaction: half the board with real scores and half with zeros is worse than
// not having run at all, because it looks authoritative.
//
// Only votes with a non-empty post_id are counted. Profile votes (post_id = '')
// move users.reputation and have no post to attach to; counting them here would
// invent a post score for a post that does not exist. The partial unique index
// from 1766300000 makes one vote per (voter, post), so a re-vote replaces rather
// than accumulates and the total cannot be inflated.

import (
	"fmt"
	"sort"

	"github.com/pocketbase/pocketbase/core"
)

// PostReputationRecomputeReport states what a recompute run changed.
type PostReputationRecomputeReport struct {
	// Updated and Unchanged hold POST record ids.
	Updated   []string
	Unchanged []string
	// Values maps a post id to the score the pass derived, so a run is
	// auditable without querying the database. Populated in dry runs too.
	Values map[string]int
	// WithoutField counts posts skipped because their collection predates the
	// migration that added posts.reputation.
	WithoutField int
}

// Changed reports whether the recompute modified anything.
func (r PostReputationRecomputeReport) Changed() bool {
	return len(r.Updated) > 0
}

// PostReputationRecomputeOptions configures one pass.
type PostReputationRecomputeOptions struct {
	// DryRun derives every score and reports the result without writing. The
	// derivation is identical to a real run, so "would_update=N" is a promise the
	// real run keeps.
	DryRun bool
}

// RecomputePostReputation rebuilds posts.reputation from reputation_votes.
func RecomputePostReputation(app core.App, opts PostReputationRecomputeOptions) (PostReputationRecomputeReport, error) {
	report := PostReputationRecomputeReport{Values: map[string]int{}}

	postsCol, err := app.FindCollectionByNameOrId(postsCollectionName)
	if err != nil {
		return report, fmt.Errorf("posts collection unavailable: %w", err)
	}
	if postsCol.Fields.GetByName("reputation") == nil {
		// Pre-1766300000 collection: adding the column is the migration's job,
		// so the pass reports nothing rather than writing a column that is not
		// there.
		return report, fmt.Errorf(
			"posts collection has no reputation column; run the migrations first")
	}

	scores, err := sumVotesByPost(app)
	if err != nil {
		return report, fmt.Errorf("sum post votes: %w", err)
	}

	posts, err := app.FindAllRecords(postsCol)
	if err != nil {
		return report, fmt.Errorf("read posts: %w", err)
	}
	for _, rec := range posts {
		// A post with no votes is a zero, not a leftover. Assigning it the zero
		// is the whole point: that is how a stale cached score gets cleared.
		report.Values[rec.Id] = scores[rec.Id]
	}

	if opts.DryRun {
		for _, rec := range posts {
			if rec.GetInt("reputation") == report.Values[rec.Id] {
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
		for _, rec := range posts {
			want := report.Values[rec.Id]
			if rec.GetInt("reputation") == want {
				report.Unchanged = append(report.Unchanged, rec.Id)
				continue
			}
			rec.Set("reputation", want)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update reputation for post %s: %w", rec.Id, err)
			}
			report.Updated = append(report.Updated, rec.Id)
		}
		return nil
	})
	if err != nil {
		return PostReputationRecomputeReport{}, err
	}
	sort.Strings(report.Updated)
	sort.Strings(report.Unchanged)
	return report, nil
}

// sumVotesByPost sums reputation_votes per post_id, skipping the profile votes
// (post_id = ”) that have no post to attach to.
func sumVotesByPost(app core.App) (map[string]int, error) {
	type postTotal struct {
		PostID string `db:"post_id"`
		Total  int    `db:"total"`
	}
	var rows []postTotal
	if err := app.DB().NewQuery(
		"SELECT post_id, SUM(value) AS total FROM reputation_votes WHERE post_id != '' GROUP BY post_id",
	).All(&rows); err != nil {
		return nil, err
	}

	out := make(map[string]int, len(rows))
	for _, row := range rows {
		if row.PostID == "" {
			continue
		}
		out[row.PostID] = row.Total
	}
	return out, nil
}
