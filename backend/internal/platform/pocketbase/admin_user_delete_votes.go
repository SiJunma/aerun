package pocketbase

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// purgeSinglePostForUserDeletion removes one surviving post of a member whose
// account is being deleted with delete_posts=true. It mirrors the residue
// half of deletePostHandler (vote payback, author counter, audit text, vote
// rows, topic projection rebuild) without its permission checks — the caller
// is the admin delete command, not the post's author.
func purgeSinglePostForUserDeletion(txApp core.App, post *core.Record) error {
	authorID := post.GetString("author_id")

	var voteSum struct {
		Total int `db:"total"`
	}
	if err := txApp.DB().NewQuery(
		"SELECT COALESCE(SUM(value), 0) AS total FROM "+reputationVotesCollectionName+
			" WHERE post_id = {:post}",
	).Bind(dbx.Params{"post": post.Id}).One(&voteSum); err != nil {
		return internalError("failed to sum reputation votes for user deletion", err)
	}
	if voteSum.Total != 0 && authorID != "" {
		if err := adjustUserReputation(txApp, authorID, -voteSum.Total); err != nil {
			return err
		}
	}
	if authorID != "" {
		if err := adjustUserPostCount(txApp, authorID, -1); err != nil {
			return err
		}
	}

	var topicTitle string
	var topic *core.Record
	if topicID := post.GetString("topic_id"); topicID != "" {
		if t, err := txApp.FindRecordById(topicsCollectionName, topicID); err == nil && t != nil {
			topic = t
			topicTitle = t.GetString("title")
		}
	}
	if err := recordAuditLog(txApp, "post_delete", authorID, map[string]any{
		"post_id":            post.Id,
		"topic_id":           post.GetString("topic_id"),
		"topic_title":        topicTitle,
		"author_id":          authorID,
		"author_kind":        post.GetString(authorKindField),
		"guest_display_name": post.GetString(guestDisplayNameField),
		"created":            post.GetDateTime("created").String(),
		"by_author":          false,
		"content":            post.GetString("content"),
		"reason":             "admin_user_delete_delete_posts",
	}); err != nil {
		return err
	}

	if _, err := txApp.DB().NewQuery(
		"DELETE FROM "+reputationVotesCollectionName+" WHERE post_id = {:post}",
	).Bind(dbx.Params{"post": post.Id}).Execute(); err != nil {
		return internalError("failed to delete votes for user deletion", err)
	}
	if err := txApp.Delete(post); err != nil {
		return internalError("failed to delete post for user deletion", err)
	}
	if topic != nil {
		if err := rebuildTopicProjection(txApp, topic); err != nil {
			return internalError("failed to rebuild topic projection after user deletion", err)
		}
	}
	return nil
}

// purgeUserProfileVotes deletes the profile-level reputation votes touching
// userID — votes the member cast (voter_id) and votes on the member's profile
// (target_id with empty post_id) — paying each back to the profile it moved.
//
// Post-level votes where the member is the target are NOT touched here: they
// were already paid back when their posts were deleted above, and paying them
// again would move the survivors' scores twice.
func purgeUserProfileVotes(txApp core.App, userID string) error {
	cast, err := txApp.FindAllRecords(
		reputationVotesCollectionName,
		dbx.HashExp{"voter_id": userID},
	)
	if err != nil {
		return internalError("failed to list cast votes for user deletion", err)
	}
	for _, vote := range cast {
		if targetID := vote.GetString("target_id"); targetID != "" {
			if err := adjustUserReputation(txApp, targetID, -vote.GetInt("value")); err != nil {
				return err
			}
		}
		if err := txApp.Delete(vote); err != nil {
			return internalError("failed to delete cast vote for user deletion", err)
		}
	}

	received, err := txApp.FindAllRecords(
		reputationVotesCollectionName,
		dbx.NewExp("target_id = {:target} AND post_id = ''",
			dbx.Params{"target": userID}),
	)
	if err != nil {
		return internalError("failed to list received votes for user deletion", err)
	}
	for _, vote := range received {
		if err := adjustUserReputation(txApp, userID, -vote.GetInt("value")); err != nil {
			return err
		}
		if err := txApp.Delete(vote); err != nil {
			return internalError("failed to delete received vote for user deletion", err)
		}
	}
	return nil
}
