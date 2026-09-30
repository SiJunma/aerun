package importer

// Legacy reputation_logs + topic_subscriptions -> target rows (Sprint 7 writers,
// level L7).
//
// Two collections, one file, because both are "who did what to what" rows that
// resolve against the same imported accounts and topics.
//
// **Votes.** The target is `reputation_votes`: an immutable cast of +1/-1 with
// UNIQUE(voter_id, post_id) for post votes and UNIQUE(voter_id, target_id) for
// profile votes. The legacy document id is already "<voter>_<post>", so the
// upsert key is the document id and no duplicate pair can exist by construction
// — verified on the 2026-09 export: 0 duplicate (voter, post) pairs across 403
// votes.
//
// **The `applied` flag is dropped, deliberately.** 290 of the 403 legacy votes
// carry `applied: true` and 113 carry no flag at all. It was checked for a
// derivable meaning and there is none: the split is not self-votes (there are
// none), not post-vs-profile votes, and not an empty-value pattern. It is
// fire-and-forget Cloud Function bookkeeping — a trigger that did not always
// run. So every vote is imported and the count is reported under
// `reputation_vote_without_applied_flag`. Dropping a third of the forum's
// recorded votes would invent data loss; honouring an unexplainable flag would
// invent intent. Reputation is recomputed from whatever votes land, so the two
// choices stay consistent with each other.
//
// **Subscriptions** carry no surprises: 5 rows, each a (topic, user) pair, and
// the target has UNIQUE(topic_id, user_id) to match.

import (
	"fmt"
	"sort"
	"strings"
)

// ReputationVoteRow is the target state of one reputation_votes row.
type ReputationVoteRow struct {
	LegacyID string
	TargetID string
	// VoterID and TargetUserID are derived user ids; both are Required, so a vote
	// whose voter or author never imported cannot be written.
	VoterID      string
	TargetUserID string
	// PostID is empty for a profile vote, which is what selects the other unique
	// index (the target's partial indexes key on post_id != '' / post_id = '').
	PostID    string
	TopicID   string
	Value     int
	Comment   string
	CreatedAt string
	// AppliedMissing records that the legacy document carried no `applied` flag,
	// so the report can account for it.
	AppliedMissing bool
}

// SubscriptionRow is the target state of one topic_subscriptions row.
type SubscriptionRow struct {
	LegacyID  string
	TargetID  string
	TopicID   string
	UserID    string
	CreatedAt string
}

// EngagementPlan is the full result of planning L7.
type EngagementPlan struct {
	VoteRows         []ReputationVoteRow
	SubscriptionRows []SubscriptionRow
	Findings         map[string]*Finding
	SkippedVoteIDs   []string
	SkippedSubIDs    []string
}

// BuildEngagementPlan translates reputation_logs and topic_subscriptions.
func BuildEngagementPlan(plan *ImportPlan, userExists, topicExists, postExists func(string) bool) *EngagementPlan {
	ep := &EngagementPlan{Findings: map[string]*Finding{}}

	// A profile vote is unique per (voter, target) in the target schema, and the
	// legacy data violates that: of the 8 profile votes in the 2026-09 export,
	// two pairs repeat. The index would refuse the whole batch, so the plan
	// collapses them first — keeping the EARLIEST vote and reporting the rest as
	// superseded.
	//
	// Earliest is the defensible choice because a profile vote is a standing
	// statement, not a tally: the first one is the one the user actually cast,
	// and a later duplicate is the same statement written twice (the legacy
	// client could re-submit). Ties break on the document id so two runs cannot
	// disagree about which one survived.
	profileVoteSeen := map[string]ReputationVoteRow{}

	for _, id := range sortedKeys(plan.ReputationLogs) {
		fields := plan.ReputationLogs[id]
		voter := strings.TrimSpace(stringField(fields, "voter_id"))
		target := strings.TrimSpace(stringField(fields, "target_id"))
		postRef := strings.TrimSpace(stringField(fields, "post_id"))

		if voter == "" || target == "" || !userExists(voter) || !userExists(target) {
			// Both columns are Required and hold a 15-char derived id, so a vote
			// referencing an account that never imported has nowhere to go.
			// Dropping it silently would also silently change everyone's
			// reputation, so it is reported.
			ep.SkippedVoteIDs = append(ep.SkippedVoteIDs, id)
			ep.note("reputation_vote_account_unresolved", id)
			continue
		}

		// reputation_votes.value is Required and a zero is not a vote, it is a
		// half-written row. Checked before the row is built so it never reaches
		// the writer.
		value := intField(fields, "value")
		if value == 0 {
			ep.SkippedVoteIDs = append(ep.SkippedVoteIDs, id)
			ep.note("reputation_vote_value_zero", id)
			continue
		}

		row := ReputationVoteRow{
			LegacyID:       id,
			TargetID:       DeriveID(SpaceReputationLog, id),
			VoterID:        DeriveID(SpaceUser, voter),
			TargetUserID:   DeriveID(SpaceUser, target),
			Value:          value,
			Comment:        stringField(fields, "comment"),
			CreatedAt:      TimestampToISO(timeField(fields, "created_at")),
			AppliedMissing: !legacyBoolField(fields, "applied"),
		}

		if postRef != "" {
			// The post may be a draft or a tombstone. A vote on one has no row to
			// point at, so it degrades to a profile vote on the author rather
			// than carrying a reference to nothing.
			if postExists(postRef) {
				row.PostID = DeriveID(SpacePost, postRef)
			} else {
				ep.note("reputation_vote_post_unresolved", id+"->"+postRef)
			}
			if topicRef := strings.TrimSpace(stringField(fields, "topic_id")); topicRef != "" && topicExists(topicRef) {
				row.TopicID = DeriveID(SpaceTopic, topicRef)
			}
		}
		if row.AppliedMissing {
			ep.note("reputation_vote_without_applied_flag", id)
		}

		if row.PostID == "" {
			key := row.VoterID + "/" + row.TargetUserID
			if earlier, taken := profileVoteSeen[key]; taken {
				if laterWins := rowComesFirst(row, earlier); laterWins {
					profileVoteSeen[key] = row
				}
				ep.note("reputation_vote_duplicate_profile_vote", id)
				continue
			}
			profileVoteSeen[key] = row
		}
		ep.VoteRows = append(ep.VoteRows, row)
	}
	sort.Strings(ep.SkippedVoteIDs)

	for _, id := range sortedKeys(plan.Subscriptions) {
		fields := plan.Subscriptions[id]
		topicRef := strings.TrimSpace(stringField(fields, "topic_id"))
		userRef := strings.TrimSpace(stringField(fields, "user_id"))
		if topicRef == "" || !topicExists(topicRef) {
			ep.SkippedSubIDs = append(ep.SkippedSubIDs, id)
			ep.note("subscription_topic_unresolved", id)
			continue
		}
		if userRef == "" || !userExists(userRef) {
			ep.SkippedSubIDs = append(ep.SkippedSubIDs, id)
			ep.note("subscription_user_unresolved", id)
			continue
		}
		ep.SubscriptionRows = append(ep.SubscriptionRows, SubscriptionRow{
			LegacyID:  id,
			TargetID:  DeriveID(SpaceSubscription, id),
			TopicID:   DeriveID(SpaceTopic, topicRef),
			UserID:    DeriveID(SpaceUser, userRef),
			CreatedAt: TimestampToISO(timeField(fields, "created_at")),
		})
	}
	sort.Strings(ep.SkippedSubIDs)

	return ep
}

// rowComesFirst reports whether a should win over b for the same uniqueness key:
// the earlier created_at, and the lexicographically smaller legacy id on a tie.
//
// Both halves matter. created_at alone is not a total order (two documents can
// share a timestamp), and the id alone would ignore which vote came first. The
// comparison is total, so the surviving row is the same on every run.
func rowComesFirst(a, b ReputationVoteRow) bool {
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.LegacyID < b.LegacyID
}

func (ep *EngagementPlan) note(code, detail string) {
	if existing, ok := ep.Findings[code]; ok {
		existing.Count++
		return
	}
	ep.Findings[code] = &Finding{Code: code, Count: 1, Examples: []string{detail}}
}

// Selected is the number of rows this run would write.
func (ep *EngagementPlan) Selected() int { return len(ep.VoteRows) + len(ep.SubscriptionRows) }

// SortedFindingLines renders the plan findings as stable "code: count" lines.
func (ep *EngagementPlan) SortedFindingLines() []string {
	lines := make([]string, 0, len(ep.Findings))
	for code, f := range ep.Findings {
		line := fmt.Sprintf("%s: %d", code, f.Count)
		if len(f.Examples) > 0 {
			line += fmt.Sprintf(" [%s]", strings.Join(f.Examples, " "))
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines
}

// SortedRowLines renders the planned rows as stable one-line summaries. The
// post_id is printed because it is empty for a profile vote, and that difference
// is the one that selects the unique index the row will land under.
func (ep *EngagementPlan) SortedRowLines() []string {
	lines := make([]string, 0, ep.Selected())
	for _, v := range ep.VoteRows {
		kind := "profile_vote"
		if v.PostID != "" {
			kind = "post_vote"
		}
		lines = append(lines, fmt.Sprintf(
			"vote %s -> %s %s voter=%s target=%s value=%d post=%s topic=%s",
			v.LegacyID, v.TargetID, kind, v.VoterID, v.TargetUserID, v.Value, v.PostID, v.TopicID))
	}
	for _, s := range ep.SubscriptionRows {
		lines = append(lines, fmt.Sprintf(
			"subscription %s -> %s topic=%s user=%s", s.LegacyID, s.TargetID, s.TopicID, s.UserID))
	}
	sort.Strings(lines)
	return lines
}
