package pocketbase

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// purgeUserContent hard-deletes every topic and post authored by userID plus
// the profile-level reputation votes in both directions, inside the caller's
// transaction. It is the delete_posts=true half of the admin user delete
// (see adminDeleteUserHandler).
//
// Topics go through the SAME residue path as the topic delete command
// (purgeTopicResidue + adjustUserTopicCount + deleteTopicPosts): reputation
// earned inside the topic is paid back, subscriptions die with the topic,
// per-author post counters move, and the vote rows leave with the posts.
//
// Remaining posts (replies in other members' topics, including drafts) are
// removed row by row with the same residue accounting the post delete
// command performs. Finally the profile-level votes — votes the member cast
// (voter_id) and votes on the member's profile (target_id with no post) —
// are deleted and their value paid back.
func purgeUserContent(txApp core.App, userID string, adminPerformerID string) error {
	topics, err := txApp.FindAllRecords(
		topicsCollectionName,
		dbx.HashExp{"author_id": userID},
	)
	if err != nil {
		return internalError("failed to list topics for user deletion", err)
	}
	for _, topic := range topics {
		if err := purgeTopicResidue(txApp, topic); err != nil {
			return err
		}
		if err := adjustUserTopicCount(txApp, topic.GetString("author_id"), -1); err != nil {
			return err
		}
		if err := deleteTopicPosts(txApp, topic); err != nil {
			return err
		}
		if err := txApp.Delete(topic); err != nil {
			return internalError("failed to delete topic for user deletion", err)
		}
	}

	posts, err := txApp.FindAllRecords(
		postsCollectionName,
		dbx.HashExp{"author_id": userID},
	)
	if err != nil {
		return internalError("failed to list posts for user deletion", err)
	}
	for _, post := range posts {
		if err := purgeSinglePostForUserDeletion(txApp, post, adminPerformerID); err != nil {
			return err
		}
	}

	if err := purgeUserProfileVotes(txApp, userID); err != nil {
		return err
	}

	// Purge push subscriptions for the deleted user.
	if err := purgePushSubscriptions(txApp, userID); err != nil {
		return err
	}
	return nil
}

// purgePushSubscriptions removes all push subscriptions belonging to userID.
// Called from purgeUserContent when an account is deleted.
func purgePushSubscriptions(txApp core.App, userID string) error {
	records, err := txApp.FindAllRecords(
		pushSubscriptionsCollectionName,
		dbx.HashExp{"user_id": userID},
	)
	if err != nil {
		return internalError("failed to list push subscriptions for user deletion", err)
	}
	for _, rec := range records {
		if err := txApp.Delete(rec); err != nil {
			return internalError("failed to delete push subscription for user deletion", err)
		}
	}
	return nil
}
