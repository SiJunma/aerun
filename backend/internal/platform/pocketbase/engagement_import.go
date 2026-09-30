package pocketbase

// Engagement import (Sprint 7 writer, level L7): reputation votes and topic
// subscriptions.
//
// Both collections are immutable ledgers in the runtime — a vote is cast once and
// a subscription is a single (topic, user) pair — so this writer is an upsert
// keyed by the derived id with no projection to maintain and nothing to
// recompute afterwards. That is exactly why reputation itself is NOT written
// here: `users.reputation` and `posts.reputation` are derived from these rows by
// RecomputeUserCounters / the reputation pass, and importing a cached total would
// be importing a number that contradicts the data beside it.
//
// Two constraints are enforced here rather than trusted:
//
//   - **A duplicate (voter, post) or (voter, target) pair is refused before the
//     transaction opens.** The target carries UNIQUE indexes for both cases, and
//     they select on `post_id != ''` vs `post_id = ''`, so a profile vote that
//     accidentally got a post id would land under the wrong one. Checking here
//     names the two documents instead of surfacing a SQLite constraint error in
//     the middle of a 400-row batch.
//   - **Every account/topic reference must resolve.** voter_id and target_id are
//     Required and hold 15-char derived ids; a vote whose voter never imported
//     cannot be written, and dropping it silently would change everyone's
//     reputation without a trace.

import (
	"fmt"
	"sort"

	"github.com/pocketbase/pocketbase/core"
)

// The collection names come from reputation.go / subscriptions.go, which own
// the runtime side of these two collections.

// ReputationVoteUpsert is the desired state of one reputation_votes row.
type ReputationVoteUpsert struct {
	TargetID string
	// VoterID and TargetUserID are required by the target schema.
	VoterID      string
	TargetUserID string
	// PostID empty selects the (voter, target) unique index.
	PostID  string
	TopicID string
	Value   int
	Comment string
	// CreatedAt overwrites the autodate column through SetRaw.
	CreatedAt string
}

// SubscriptionUpsert is the desired state of one topic_subscriptions row.
type SubscriptionUpsert struct {
	TargetID  string
	TopicID   string
	UserID    string
	CreatedAt string
}

// EngagementImportReport states what the import changed.
type EngagementImportReport struct {
	VotesCreated         []string
	VotesUpdated         []string
	SubscriptionsCreated []string
	SubscriptionsUpdated []string
	ExtraVoteIDs         []string
	ExtraSubscriptionIDs []string
}

// Changed reports whether the import modified anything.
func (r EngagementImportReport) Changed() bool {
	return len(r.VotesCreated) > 0 || len(r.VotesUpdated) > 0 ||
		len(r.SubscriptionsCreated) > 0 || len(r.SubscriptionsUpdated) > 0
}

// ImportReputationVotes makes the reputation_votes collection match upserts.
func ImportReputationVotes(app core.App, upserts []ReputationVoteUpsert) (EngagementImportReport, error) {
	report := EngagementImportReport{}
	if err := validateVoteUpserts(upserts); err != nil {
		return report, err
	}
	if len(upserts) == 0 {
		return report, nil
	}

	col, err := app.FindCollectionByNameOrId(reputationVotesCollectionName)
	if err != nil {
		return report, fmt.Errorf("reputation_votes collection unavailable: %w", err)
	}

	wanted := make(map[string]ReputationVoteUpsert, len(upserts))
	ids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	err = app.RunInTransaction(func(txApp core.App) error {
		users, err := recordIDs(txApp, usersCollectionName)
		if err != nil {
			return fmt.Errorf("read users: %w", err)
		}

		rows, err := txApp.FindAllRecords(col, nil)
		if err != nil {
			return fmt.Errorf("read reputation_votes: %w", err)
		}
		existing := make(map[string]*core.Record, len(rows))
		for _, rec := range rows {
			existing[rec.Id] = rec
		}

		for _, id := range ids {
			u := wanted[id]
			if !users[u.VoterID] {
				return fmt.Errorf("vote %s: voter %q has no users row; import the accounts first", id, u.VoterID)
			}
			if !users[u.TargetUserID] {
				return fmt.Errorf("vote %s: target %q has no users row; import the accounts first", id, u.TargetUserID)
			}

			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", id)
				applyVoteUpsert(rec, u)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create vote %s: %w", id, err)
				}
				report.VotesCreated = append(report.VotesCreated, id)
				continue
			}
			// A vote is immutable: the legacy document is the record of a past
			// event, and the target columns carry no field the runtime may have
			// changed. Equal means unchanged; anything else is reported as an
			// update so a reviewer sees the row move.
			if voteMatches(rec, u) {
				continue
			}
			applyVoteUpsert(rec, u)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update vote %s: %w", id, err)
			}
			report.VotesUpdated = append(report.VotesUpdated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraVoteIDs = append(report.ExtraVoteIDs, id)
			}
		}
		return nil
	})
	if err != nil {
		return EngagementImportReport{}, err
	}

	sort.Strings(report.VotesCreated)
	sort.Strings(report.VotesUpdated)
	sort.Strings(report.ExtraVoteIDs)
	return report, nil
}

// ImportSubscriptions makes the topic_subscriptions collection match upserts.
func ImportSubscriptions(app core.App, upserts []SubscriptionUpsert) (EngagementImportReport, error) {
	report := EngagementImportReport{}
	for _, u := range upserts {
		if u.TargetID == "" || u.TopicID == "" || u.UserID == "" {
			return report, fmt.Errorf("subscription upsert missing a required reference: %+v", u)
		}
	}
	if len(upserts) == 0 {
		return report, nil
	}

	col, err := app.FindCollectionByNameOrId(topicSubscriptionsCollectionName)
	if err != nil {
		return report, fmt.Errorf("topic_subscriptions collection unavailable: %w", err)
	}

	wanted := make(map[string]SubscriptionUpsert, len(upserts))
	ids := make([]string, 0, len(upserts))
	for _, u := range upserts {
		wanted[u.TargetID] = u
		ids = append(ids, u.TargetID)
	}
	sort.Strings(ids)

	err = app.RunInTransaction(func(txApp core.App) error {
		users, err := recordIDs(txApp, usersCollectionName)
		if err != nil {
			return fmt.Errorf("read users: %w", err)
		}
		topics, err := recordIDs(txApp, topicsCollectionName)
		if err != nil {
			return fmt.Errorf("read topics: %w", err)
		}

		rows, err := txApp.FindAllRecords(col, nil)
		if err != nil {
			return fmt.Errorf("read topic_subscriptions: %w", err)
		}
		existing := make(map[string]*core.Record, len(rows))
		for _, rec := range rows {
			existing[rec.Id] = rec
		}

		for _, id := range ids {
			u := wanted[id]
			if !topics[u.TopicID] {
				return fmt.Errorf("subscription %s: topic %q has no row; import the topics first", id, u.TopicID)
			}
			if !users[u.UserID] {
				return fmt.Errorf("subscription %s: user %q has no users row; import the accounts first", id, u.UserID)
			}

			rec, ok := existing[id]
			if !ok {
				rec = core.NewRecord(col)
				rec.Set("id", id)
				rec.Set("topic_id", u.TopicID)
				rec.Set("user_id", u.UserID)
				setAutodateIfGiven(rec, "created", u.CreatedAt)
				if err := txApp.Save(rec); err != nil {
					return fmt.Errorf("create subscription %s: %w", id, err)
				}
				report.SubscriptionsCreated = append(report.SubscriptionsCreated, id)
				continue
			}
			if rec.GetString("topic_id") == u.TopicID && rec.GetString("user_id") == u.UserID {
				continue
			}
			rec.Set("topic_id", u.TopicID)
			rec.Set("user_id", u.UserID)
			setAutodateIfGiven(rec, "created", u.CreatedAt)
			if err := txApp.Save(rec); err != nil {
				return fmt.Errorf("update subscription %s: %w", id, err)
			}
			report.SubscriptionsUpdated = append(report.SubscriptionsUpdated, id)
		}

		for id := range existing {
			if _, ok := wanted[id]; !ok {
				report.ExtraSubscriptionIDs = append(report.ExtraSubscriptionIDs, id)
			}
		}
		return nil
	})
	if err != nil {
		return EngagementImportReport{}, err
	}

	sort.Strings(report.SubscriptionsCreated)
	sort.Strings(report.SubscriptionsUpdated)
	sort.Strings(report.ExtraSubscriptionIDs)
	return report, nil
}

// validateVoteUpserts rejects a batch that cannot be written cleanly, BEFORE the
// transaction opens.
//
// The two unique indexes are the reason: post votes are unique on
// (voter_id, post_id) where post_id != ”, and profile votes on
// (voter_id, target_id) where post_id = ”. A duplicate inside one batch would
// otherwise abort the transaction with an error that names a SQLite constraint
// instead of the two votes that collided.
func validateVoteUpserts(upserts []ReputationVoteUpsert) error {
	ids := make(map[string]bool, len(upserts))
	byPost := make(map[string]string, len(upserts))
	byTarget := make(map[string]string, len(upserts))
	for _, u := range upserts {
		if u.TargetID == "" {
			return fmt.Errorf("vote upsert without a target id")
		}
		if ids[u.TargetID] {
			return fmt.Errorf("duplicate vote target id %q", u.TargetID)
		}
		ids[u.TargetID] = true

		if u.VoterID == "" || u.TargetUserID == "" {
			return fmt.Errorf("vote %s: voter_id and target_id are required", u.TargetID)
		}
		if u.Value != 1 && u.Value != -1 {
			return fmt.Errorf("vote %s: value must be 1 or -1, got %d", u.TargetID, u.Value)
		}

		if u.PostID != "" {
			key := u.VoterID + "/" + u.PostID
			if other, taken := byPost[key]; taken {
				return fmt.Errorf("votes %s and %s both target post %s for voter %s",
					other, u.TargetID, u.PostID, u.VoterID)
			}
			byPost[key] = u.TargetID
			continue
		}
		key := u.VoterID + "/" + u.TargetUserID
		if other, taken := byTarget[key]; taken {
			return fmt.Errorf("votes %s and %s both target profile %s for voter %s",
				other, u.TargetID, u.TargetUserID, u.VoterID)
		}
		byTarget[key] = u.TargetID
	}
	return nil
}

func applyVoteUpsert(rec *core.Record, u ReputationVoteUpsert) {
	rec.Set("voter_id", u.VoterID)
	rec.Set("target_id", u.TargetUserID)
	rec.Set("post_id", u.PostID)
	rec.Set("topic_id", u.TopicID)
	rec.Set("value", u.Value)
	rec.Set("comment", u.Comment)
	setAutodateIfGiven(rec, "created", u.CreatedAt)
}

func voteMatches(rec *core.Record, u ReputationVoteUpsert) bool {
	return rec.GetString("voter_id") == u.VoterID &&
		rec.GetString("target_id") == u.TargetUserID &&
		rec.GetString("post_id") == u.PostID &&
		rec.GetString("topic_id") == u.TopicID &&
		rec.GetInt("value") == u.Value &&
		rec.GetString("comment") == u.Comment &&
		autodateMatches(rec, "created", u.CreatedAt)
}

// recordIDs returns the set of ids present in a collection.
func recordIDs(app core.App, collection string) (map[string]bool, error) {
	rows, err := app.FindAllRecords(collection, nil)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(rows))
	for _, rec := range rows {
		out[rec.Id] = true
	}
	return out, nil
}
