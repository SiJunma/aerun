// 1770000005_reputation_votes_guest_target.go makes reputation_votes.target_id
// nullable and widens it so a vote on guest content can target the guest's
// stable principal instead of a (nonexistent) account.
//
// Stage 0 ruled that votes are allowed on guest content: post-level
// reputation (posts.reputation) is updated for every vote, but account-level
// reputation payout (adjustUserReputation) is a no-op for guests. The vote
// row itself previously required a non-empty target_id referencing a users
// row, which made voting on a guest post impossible — there is no account to
// target. With the guest principal (1770000003) a guest post can now point
// its votes at the visitor's principal instead.
//
// Idempotent by construction; the down path restores Required=true and Max=15
// (which would reject guest votes, so only revert when no guest votes exist).
package migrations

import (
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

const reputationVotesTable = "reputation_votes"

func init() {
	m.Register(makeReputationVoteTargetNullable, restoreReputationVoteTargetRequired)
}

func makeReputationVoteTargetNullable(app core.App) error {
	col, err := app.FindCollectionByNameOrId(reputationVotesTable)
	if err != nil || col == nil {
		return fmt.Errorf("find %s collection: %w", reputationVotesTable, err)
	}
	field := col.Fields.GetByName("target_id")
	if field == nil {
		return nil // nothing to do
	}
	text, ok := field.(*core.TextField)
	if !ok {
		return fmt.Errorf("reputation_votes.target_id is not a text field")
	}
	text.Required = false
	text.Max = 64
	if err := app.Save(col); err != nil {
		return fmt.Errorf("make reputation_votes.target_id nullable: %w", err)
	}
	return nil
}

func restoreReputationVoteTargetRequired(app core.App) error {
	col, err := app.FindCollectionByNameOrId(reputationVotesTable)
	if err != nil || col == nil {
		return fmt.Errorf("find %s collection: %w", reputationVotesTable, err)
	}
	field := col.Fields.GetByName("target_id")
	if field == nil {
		return nil
	}
	text, ok := field.(*core.TextField)
	if !ok {
		return fmt.Errorf("reputation_votes.target_id is not a text field")
	}
	text.Required = true
	text.Max = 15
	if err := app.Save(col); err != nil {
		return fmt.Errorf("restore reputation_votes.target_id required: %w", err)
	}
	return nil
}
