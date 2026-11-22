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
// The active admin who initiated the deletion is passed as adminPerformerID.
func purgeSinglePostForUserDeletion(txApp core.App, post *core.Record, adminPerformerID string) error {
	authorID := post.GetString("author_id")

	var voteSum struct {
		Total int `db:"total"`
	}
	if err := txApp.DB().NewQuery(
		"SELECT COALESCE(SUM(value), 0) AS total FROM " + reputationVotesCollectionName +
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
	var categoryID string
	var categoryTitle string
	var topic *core.Record
	if topicID := post.GetString("topic_id"); topicID != "" {
		if t, err := txApp.FindRecordById(topicsCollectionName, topicID); err == nil && t != nil {
			topic = t
			topicTitle = t.GetString("title")
			categoryID = t.GetString("category_id")
			if categoryID != "" {
				if cat, err := txApp.FindRecordById(categoriesCollectionName, categoryID); err == nil && cat != nil {
					categoryTitle = cat.GetString("name")
				}
			}
		}
	}

	performer := adminPerformerID
	if performer == "" {
		performer = authorID
	}

	if err := recordAuditLog(txApp, "post_delete", performer, map[string]any{
		"post_id":            post.Id,
		"topic_id":           post.GetString("topic_id"),
		"topic_title":        topicTitle,
		"category_id":        categoryID,
		"category_title":     categoryTitle,
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
		"DELETE FROM " + reputationVotesCollectionName + " WHERE post_id = {:post}",
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

// purgeUserProfileVotes deletes the reputation votes touching userID — votes
// the member cast (voter_id) and votes on the member's profile (target_id
// with empty post_id) — paying each back to the profile it moved.
//
// A vote carries TWO denormalized copies of its value: the target's
// `users.reputation` AND the `posts.reputation` of the post it was cast on.
// The ordinary retract path (deleteReputationHandler) moves BOTH, and so must
// this one: leaving the post's counter behind would strand a score whose
// vote row no longer exists, and the post would disagree with itself and with
// the user it belongs to until the next recompute pass.
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
		// The post's own counter, when the vote was cast on a post that
		// SURVIVED the purge (a vote on somebody else's post). A post that
		// went with the purge has no counter left to settle.
		if postID := vote.GetString("post_id"); postID != "" {
			if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
				post.Set("reputation", post.GetInt("reputation")-vote.GetInt("value"))
				if err := txApp.Save(post); err != nil {
					return internalError("failed to settle post reputation for user deletion", err)
				}
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
