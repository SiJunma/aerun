package pocketbase

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/forum"
)

const (
	reputationVotesCollectionName = "reputation_votes"
	maxReputationBodyBytes        = 32 * 1024
)

type voteForm struct {
	Value   int    `json:"value"`
	Comment string `json:"comment"`
}

func repVotePayload(record *core.Record) map[string]any {
	return map[string]any{
		"id":        record.Id,
		"voter_id":  record.GetString("voter_id"),
		"target_id": record.GetString("target_id"),
		"post_id":   record.GetString("post_id"),
		"topic_id":  record.GetString("topic_id"),
		"value":     record.GetInt("value"),
		"comment":   record.GetString("comment"),
		"created":   record.GetDateTime("created").String(),
		"updated":   record.GetDateTime("updated").String(),
	}
}

// isStaff checks if the access context belongs to root, admin or moderator.
func isStaff(acc AccessContext) bool {
	return acc.Role == auth.RoleRoot || acc.Role == auth.RoleAdmin || acc.Role == auth.RoleModerator
}

// getUserSettingBool extracts a boolean setting from the user's settings JSON field.
func getUserSettingBool(user *core.Record, key string, defaultVal bool) bool {
	raw := user.Get("settings")
	if raw == nil {
		return defaultVal
	}
	var settings map[string]any
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &settings); err != nil {
			return defaultVal
		}
	case map[string]any:
		settings = v
	default:
		data, err := json.Marshal(v)
		if err == nil {
			_ = json.Unmarshal(data, &settings)
		}
	}
	val, ok := settings[key]
	if !ok || val == nil {
		return defaultVal
	}
	if b, ok := val.(bool); ok {
		return b
	}
	return defaultVal
}

// reputationChangeWanted reports whether the target member wants in-app
// reputation notices. The frontend treats a missing key as enabled
// (ProfilePage maps `…in_app !== false`), so the server does the same:
// only an explicit false suppresses the notification.
func reputationChangeWanted(targetUser *core.Record) bool {
	if targetUser == nil {
		return false
	}
	settings, err := decodeSettings(targetUser)
	if err != nil {
		return true
	}
	notifications, ok := settings["notifications"].(map[string]any)
	if !ok {
		return true
	}
	entry, ok := notifications["reputation_change"].(map[string]any)
	if !ok {
		return true
	}
	if inApp, ok := entry["in_app"].(bool); ok {
		return inApp
	}
	return true
}

// notifyReputationChange records a reputation_change notice for the member
// whose score just moved. It never aborts the vote: a notice that cannot be
// written is logged and the command still succeeds — the same reasoning that
// keeps a failed post notification from costing the author their reply.
func notifyReputationChange(txApp core.App, recipientID, voterID string, val, delta int, comment string, postID, topicID, topicTitle, voterNickname string) {
	if recipientID == "" || recipientID == voterID {
		return
	}
	title := "Your reputation changed"
	if delta > 0 {
		title = "Your reputation increased"
	} else if delta < 0 {
		title = "Your reputation decreased"
	}
	if _, err := createNotification(txApp, recipientID, voterID, "reputation_change", title,
		map[string]any{
			"voter_id":       voterID,
			"voter_nickname": voterNickname,
			"target_id":      recipientID,
			"value":          val,
			"delta":          delta,
			"post_id":        postID,
			"topic_id":       topicID,
			"topic_title":    topicTitle,
			"comment":        comment,
		},
	); err != nil {
		txApp.Logger().Warn("reputation change notification failed; the vote itself succeeded",
			"error", err, "recipientId", recipientID, "voterId", voterID)
	}
}

// votePostHandler casts or updates a vote on a post.
func votePostHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	postID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxReputationBodyBytes)
	if err != nil {
		return err
	}

	var form voteForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	acc := AccessFrom(e)

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		post, err := txApp.FindRecordById(postsCollectionName, postID)
		if err != nil || post == nil {
			return 0, nil, notFoundError("post not found")
		}

		// Enforce category visibility
		allowed, topic, err := canViewTopic(txApp, acc, post.GetString("topic_id"))
		if err != nil || !allowed || topic == nil {
			return 0, nil, forbiddenError("you do not have permission to vote in this category")
		}

		// Target is the post's author for account content, or the visitor's stable
		// guest principal for guest content. A guest post has no account to pay
		// reputation to — posts.reputation is updated at post level only
		// (adjustUserReputation is skipped for guests in the delete path).
		//
		// author_id != "" marks an account post (including legacy rows whose
		// author_kind variant column has not been backfilled yet); author_id == ""
		// marks a guest post.
		targetUserID := post.GetString("author_id")
		if post.GetString("author_id") == "" {
			targetUserID = guestPrincipalIDFromRequest(e)
		}
		val, comment, err := forum.ValidateReputationVote(e.Auth.Id, targetUserID, form.Value, form.Comment)
		if err != nil {
			return 0, nil, validationError(err.Error())
		}

		// Only account targets have a users row; guest targets are resolved to
		// their principal and have no account reputation to pay out.
		var targetUser *core.Record
		if post.GetString("author_id") != "" {
			targetUser, err = txApp.FindRecordById(usersCollectionName, targetUserID)
			if err != nil || targetUser == nil {
				return 0, nil, notFoundError("target user not found")
			}
		}

		// Look up existing vote on this post by this voter
		existingVote, err := txApp.FindFirstRecordByFilter(
			reputationVotesCollectionName,
			"voter_id = {:voter} && post_id = {:post}",
			dbx.Params{"voter": e.Auth.Id, "post": postID},
		)

		var voteRecord *core.Record
		// scoreDelta is how far this call moves the author's score: the new
		// value for a fresh vote, the difference for an edit, zero for a
		// same-value resubmit. Only a non-zero move is notice-worthy.
		scoreDelta := 0
		if err == nil && existingVote != nil {
			// Controlled replacement
			oldVal := existingVote.GetInt("value")
			delta := val - oldVal
			scoreDelta = delta
			if delta != 0 {
				post.Set("reputation", post.GetInt("reputation")+delta)
				if targetUser != nil {
					targetUser.Set("reputation", targetUser.GetInt("reputation")+delta)
				}
			}
			existingVote.Set("value", val)
			existingVote.Set("comment", comment)
			if err := txApp.Save(existingVote); err != nil {
				return 0, nil, internalError("failed to update vote", err)
			}
			voteRecord = existingVote
		} else {
			col, err := txApp.FindCollectionByNameOrId(reputationVotesCollectionName)
			if err != nil {
				return 0, nil, internalError("reputation_votes collection unavailable", err)
			}
			newVote := core.NewRecord(col)
			newVote.Set("voter_id", e.Auth.Id)
			newVote.Set("target_id", targetUserID)
			newVote.Set("post_id", post.Id)
			newVote.Set("topic_id", post.GetString("topic_id"))
			newVote.Set("value", val)
			newVote.Set("comment", comment)

			if err := txApp.Save(newVote); err != nil {
				return 0, nil, internalError("failed to create vote", err)
			}
			post.Set("reputation", post.GetInt("reputation")+val)
			if targetUser != nil {
				targetUser.Set("reputation", targetUser.GetInt("reputation")+val)
			}
			scoreDelta = val
			voteRecord = newVote
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to update post reputation", err)
		}
		if targetUser != nil {
			if err := txApp.Save(targetUser); err != nil {
				return 0, nil, internalError("failed to update user reputation", err)
			}
		}

		// The score moved through a post: the post author (when there is an
		// account behind the post) gets a notice. Same-value resubmits move
		// nothing, so they stay silent; guest posts have no member to tell.
		if scoreDelta != 0 && targetUser != nil && reputationChangeWanted(targetUser) {
			voterNickname := ""
			if voter, err := txApp.FindRecordById(usersCollectionName, e.Auth.Id); err == nil && voter != nil {
				voterNickname = voter.GetString("nickname")
			}
			topicTitle := post.GetString("topic_id")
			if topic != nil {
				topicTitle = topic.GetString("title")
			}
			notifyReputationChange(txApp, targetUser.Id, e.Auth.Id, voteRecord.GetInt("value"),
				scoreDelta, voteRecord.GetString("comment"), post.Id, post.GetString("topic_id"),
				topicTitle, voterNickname)
		}

		return http.StatusOK, map[string]any{
			"vote":            repVotePayload(voteRecord),
			"post_reputation": post.GetInt("reputation"),
			"target_reputation": func() int {
				if targetUser == nil {
					return 0
				}
				return targetUser.GetInt("reputation")
			}(),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// deletePostVoteHandler allows the voter to remove their own vote on a post.
func deletePostVoteHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	postID := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		existingVote, err := txApp.FindFirstRecordByFilter(
			reputationVotesCollectionName,
			"voter_id = {:voter} && post_id = {:post}",
			dbx.Params{"voter": e.Auth.Id, "post": postID},
		)
		if err != nil || existingVote == nil {
			return http.StatusOK, map[string]any{
				"deleted":    true,
				"request_id": requestIDFrom(e),
			}, nil
		}

		val := existingVote.GetInt("value")

		if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
			post.Set("reputation", post.GetInt("reputation")-val)
			_ = txApp.Save(post)
		}

		if targetUser, err := txApp.FindRecordById(usersCollectionName, existingVote.GetString("target_id")); err == nil && targetUser != nil {
			targetUser.Set("reputation", targetUser.GetInt("reputation")-val)
			_ = txApp.Save(targetUser)
		}

		if err := txApp.Delete(existingVote); err != nil {
			return 0, nil, internalError("failed to delete vote", err)
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// voteUserHandler casts or updates a profile vote for a user.
func voteUserHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	targetUserID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxReputationBodyBytes)
	if err != nil {
		return err
	}

	var form voteForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	val, comment, err := forum.ValidateReputationVote(e.Auth.Id, targetUserID, form.Value, form.Comment)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		targetUser, err := txApp.FindRecordById(usersCollectionName, targetUserID)
		if err != nil || targetUser == nil {
			return 0, nil, notFoundError("target user not found")
		}

		// Reputation is a judgement about an account, and a suspended account's
		// reputation must stop moving: voting for it would still shift the score
		// moderators read when deciding whether to lift the suspension.
		// createDMHandler already refuses a suspended counterpart, so this makes
		// the two agree — a ban takes the account out of circulation as an OBJECT
		// of member actions, not only as an actor.
		//
		// The target's post visibility is not consulted here: the author of a post
		// stays readable through their profile (1768100000), so hiding the vote
		// while showing the post would be incoherent.
		if targetUser.GetString("status") == string(auth.StatusBanned) {
			return 0, nil, forbiddenError("cannot vote for a banned user")
		}

		existingVote, err := txApp.FindFirstRecordByFilter(
			reputationVotesCollectionName,
			"voter_id = {:voter} && target_id = {:target} && post_id = ''",
			dbx.Params{"voter": e.Auth.Id, "target": targetUserID},
		)

		var voteRecord *core.Record
		// profileDelta is how far this call moves the member's score: the new
		// value for a fresh vote, the difference for an edit, zero for a
		// same-value resubmit. Only a non-zero move is notice-worthy.
		profileDelta := 0
		if err == nil && existingVote != nil {
			oldVal := existingVote.GetInt("value")
			delta := val - oldVal
			profileDelta = delta
			if delta != 0 {
				targetUser.Set("reputation", targetUser.GetInt("reputation")+delta)
			}
			existingVote.Set("value", val)
			existingVote.Set("comment", comment)
			if err := txApp.Save(existingVote); err != nil {
				return 0, nil, internalError("failed to update profile vote", err)
			}
			voteRecord = existingVote
		} else {
			col, err := txApp.FindCollectionByNameOrId(reputationVotesCollectionName)
			if err != nil {
				return 0, nil, internalError("reputation_votes collection unavailable", err)
			}
			newVote := core.NewRecord(col)
			newVote.Set("voter_id", e.Auth.Id)
			newVote.Set("target_id", targetUserID)
			newVote.Set("post_id", "")
			newVote.Set("topic_id", "")
			newVote.Set("value", val)
			newVote.Set("comment", comment)

			if err := txApp.Save(newVote); err != nil {
				return 0, nil, internalError("failed to create profile vote", err)
			}
			targetUser.Set("reputation", targetUser.GetInt("reputation")+val)
			profileDelta = val
			voteRecord = newVote
		}

		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to update user reputation", err)
		}

		// The profile score moved: tell the member, unless they switched the
		// notice off. Same-value resubmits move nothing, so they stay silent.
		if profileDelta != 0 && reputationChangeWanted(targetUser) {
			voterNickname := ""
			if voter, err := txApp.FindRecordById(usersCollectionName, e.Auth.Id); err == nil && voter != nil {
				voterNickname = voter.GetString("nickname")
			}
			notifyReputationChange(txApp, targetUser.Id, e.Auth.Id, voteRecord.GetInt("value"),
				profileDelta, voteRecord.GetString("comment"), "", "", "", voterNickname)
		}

		return http.StatusOK, map[string]any{
			"vote": repVotePayload(voteRecord),
			"target_reputation": func() int {
				if targetUser == nil {
					return 0
				}
				return targetUser.GetInt("reputation")
			}(),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// deleteUserVoteHandler allows the voter to remove their profile vote.
func deleteUserVoteHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	targetUserID := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		existingVote, err := txApp.FindFirstRecordByFilter(
			reputationVotesCollectionName,
			"voter_id = {:voter} && target_id = {:target} && post_id = ''",
			dbx.Params{"voter": e.Auth.Id, "target": targetUserID},
		)
		if err != nil || existingVote == nil {
			return http.StatusOK, map[string]any{
				"deleted":    true,
				"request_id": requestIDFrom(e),
			}, nil
		}

		val := existingVote.GetInt("value")

		if targetUser, err := txApp.FindRecordById(usersCollectionName, targetUserID); err == nil && targetUser != nil {
			targetUser.Set("reputation", targetUser.GetInt("reputation")-val)
			_ = txApp.Save(targetUser)
		}

		if err := txApp.Delete(existingVote); err != nil {
			return 0, nil, internalError("failed to delete profile vote", err)
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// repEditForm is the body of a reputation edit: the comment text and/or a new
// value. Both are optional, but at least one must be present — an edit that
// changes nothing is a wasted write and an audit entry with no meaning.
type repEditForm struct {
	Value   *int   `json:"value"`
	Comment string `json:"comment"`
}

// editReputationHandler changes an existing reputation entry.
//
// This command did not exist before the permission split. It is here because
// "a player may edit their own reputation comment" is only meaningful if there
// is somewhere to type the edit, and an entry that could be created and
// retracted but never corrected was a dead end.
//
// VALUE CHANGES RE-BALANCE BOTH TOTALS. Changing "+5" to "-1" has to move the
// target's reputation and the post's by the DELTA, not by the new value, or the
// second edit of the same entry would subtract six points. The delta is
// computed before the record is written so a rejected edit changes nothing.
func editReputationHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	voteID := e.Request.PathValue("id")

	var form repEditForm
	raw, err := readBodyLimited(e, maxReputationBodyBytes)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	if form.Value == nil && strings.TrimSpace(form.Comment) == "" {
		return validationError("nothing to change")
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		vote, err := txApp.FindRecordById(reputationVotesCollectionName, voteID)
		if err != nil || vote == nil {
			return 0, nil, notFoundError("reputation vote not found")
		}

		// Same ownership rule as the delete, and for the same reason: the `_self_`
		// key exists precisely so a member can correct their own words, and must
		// not become a way to rewrite somebody else's.
		acc := AccessFrom(e)
		if vote.GetString("voter_id") != e.Auth.Id {
			if !auth.Has(acc.Permissions, auth.PermEditOthersReputation) {
				return 0, nil, forbiddenError("you may only edit your own reputation entries")
			}
		} else if !auth.Has(acc.Permissions, auth.PermEditSelfReputation) &&
			!auth.Has(acc.Permissions, auth.PermEditOthersReputation) {
			return 0, nil, forbiddenError("you may only edit your own reputation entries")
		}

		oldVal := vote.GetInt("value")
		targetID := vote.GetString("target_id")
		postID := vote.GetString("post_id")

		// The SAME validator the create path uses, deliberately. A second hand
		// written range check here is how an edit path ends up accepting a value
		// the create path rejects; there is one contract and one place it lives.
		newComment := vote.GetString("comment")
		if form.Value != nil {
			if _, _, err := forum.ValidateReputationVote(
				vote.GetString("voter_id"), targetID, *form.Value, vote.GetString("comment")); err != nil {
				return 0, nil, validationError(err.Error())
			}
		}
		if strings.TrimSpace(form.Comment) != "" {
			if _, _, err := forum.ValidateReputationVote(
				vote.GetString("voter_id"), targetID, oldVal, form.Comment); err != nil {
				return 0, nil, validationError(err.Error())
			}
			newComment = form.Comment
		}

		if form.Value != nil && *form.Value != oldVal {
			delta := *form.Value - oldVal
			if targetUser, err := txApp.FindRecordById(usersCollectionName, targetID); err == nil && targetUser != nil {
				targetUser.Set("reputation", targetUser.GetInt("reputation")+delta)
				if err := txApp.Save(targetUser); err != nil {
					return 0, nil, internalError("failed to rebalance profile reputation", err)
				}
			}
			if postID != "" {
				if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
					post.Set("reputation", post.GetInt("reputation")+delta)
					if err := txApp.Save(post); err != nil {
						return 0, nil, internalError("failed to rebalance post reputation", err)
					}
				}
			}
			vote.Set("value", *form.Value)
		}

		if strings.TrimSpace(form.Comment) != "" {
			vote.Set("comment", newComment)
		}

		if err := txApp.Save(vote); err != nil {
			return 0, nil, internalError("failed to edit reputation entry", err)
		}

		// A moderator rewriting somebody else's entry is audited; a member
		// fixing their own typo is not staff action and must not fill the log
		// with self-corrections.
		if vote.GetString("voter_id") != e.Auth.Id {
			if err := recordAuditLog(txApp, "reputation_edited", e.Auth.Id, map[string]any{
				"vote_id":   voteID,
				"target_id": targetID,
				"voter_id":  vote.GetString("voter_id"),
				"post_id":   postID,
				"old_value": oldVal,
				"new_value": vote.GetInt("value"),
			}); err != nil {
				return 0, nil, err
			}
		}

		return http.StatusOK, map[string]any{
			"vote":       repVotePayload(vote),
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// deleteReputationHandler deletes a reputation vote.
//
// OWNERSHIP IS DECIDED HERE, NOT AT THE ROUTE. The route used to gate this on
// `delete_reputation` alone, which made one key mean both "retract my own +1"
// and "remove an abusive comment about a third party" — and because nothing
// inside compared the voter to the caller, the only version that could be
// expressed was the staff one. A member had no way to take back their own
// entry at all.
//
// The comparison is `vote.voter_id == caller`, checked BEFORE any write, and a
// caller acting on somebody else's entry needs the `_others_` key. An author
// cannot delete a stranger's entry no matter which keys they hold — there is no
// branch where `_others_` passes for your own row, and no branch where
// `_self_` passes for someone else's.
func deleteReputationHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	voteID := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		vote, err := txApp.FindRecordById(reputationVotesCollectionName, voteID)
		if err != nil || vote == nil {
			return 0, nil, notFoundError("reputation vote not found")
		}

		// Authorization BEFORE the compensating writes below. Discovering the
		// caller was not allowed only after the reputation totals had already
		// been decremented would leave the forum with a vote deleted from one
		// total and still present in the other.
		acc := AccessFrom(e)
		if vote.GetString("voter_id") != e.Auth.Id {
			if !auth.Has(acc.Permissions, auth.PermDeleteOthersReputation) {
				return 0, nil, forbiddenError("you may only retract your own reputation entries")
			}
		} else if !auth.Has(acc.Permissions, auth.PermDeleteSelfReputation) &&
			!auth.Has(acc.Permissions, auth.PermDeleteOthersReputation) {
			return 0, nil, forbiddenError("you may only retract your own reputation entries")
		}

		val := vote.GetInt("value")
		targetID := vote.GetString("target_id")
		voterID := vote.GetString("voter_id")
		postID := vote.GetString("post_id")

		if targetUser, err := txApp.FindRecordById(usersCollectionName, targetID); err == nil && targetUser != nil {
			targetUser.Set("reputation", targetUser.GetInt("reputation")-val)
			_ = txApp.Save(targetUser)
		}

		if postID != "" {
			if post, err := txApp.FindRecordById(postsCollectionName, postID); err == nil && post != nil {
				post.Set("reputation", post.GetInt("reputation")-val)
				_ = txApp.Save(post)
			}
		}

		// Append audit log for staff action
		if err := recordAuditLog(txApp, "reputation_deleted", e.Auth.Id, map[string]any{
			"vote_id":   voteID,
			"target_id": targetID,
			"voter_id":  voterID,
			"post_id":   postID,
			"value":     val,
		}); err != nil {
			return 0, nil, err
		}

		if err := txApp.Delete(vote); err != nil {
			return 0, nil, internalError("failed to delete reputation entry", err)
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"vote_id":    voteID,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// getPostVotersHandler returns the voters for a post respecting category visibility and user privacy.
func getPostVotersHandler(e *core.RequestEvent) error {
	postID := e.Request.PathValue("id")
	post, err := e.App.FindRecordById(postsCollectionName, postID)
	if err != nil || post == nil {
		return notFoundError("post not found")
	}

	acc := AccessFrom(e)
	allowed, topic, err := canViewTopic(e.App, acc, post.GetString("topic_id"))
	if err != nil || !allowed || topic == nil {
		return forbiddenError("You do not have permission to view voters for this post.")
	}

	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), 50), 50)

	var records []*core.Record
	err = e.App.RecordQuery(reputationVotesCollectionName).
		AndWhere(dbx.HashExp{"post_id": postID}).
		OrderBy("created DESC", "id DESC").
		Limit(int64(limit)).
		All(&records)
	if err != nil {
		return internalError("failed to query voters", err)
	}

	isCallerStaff := isStaff(acc)
	requesterID := ""
	if e.Auth != nil {
		requesterID = e.Auth.Id
	}

	items := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		voterID := rec.GetString("voter_id")
		voterUser, _ := e.App.FindRecordById(usersCollectionName, voterID)

		showHistory := true
		voterNickname := "User"
		var avatarURL any

		if voterUser != nil {
			showHistory = getUserSettingBool(voterUser, "rep_show_history", true)
			voterNickname = voterUser.GetString("nickname")
			avatarURL = voterUser.GetString("avatar_url")
		}

		isPrivate := !showHistory && voterID != requesterID && !isCallerStaff

		item := map[string]any{
			"log_id":     rec.Id,
			"value":      rec.GetInt("value"),
			"comment":    rec.GetString("comment"),
			"created_at": rec.GetDateTime("created").String(),
		}

		if isPrivate {
			item["voter_id"] = nil
			item["voter_nickname"] = "Anonymous"
			item["avatar_url"] = nil
		} else {
			item["voter_id"] = voterID
			item["voter_nickname"] = voterNickname
			item["avatar_url"] = avatarURL
		}

		items = append(items, item)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"voters":     items,
		"total":      len(items),
		"request_id": requestIDFrom(e),
	})
}

// listMyVotesHandler answers GET /api/aerun/me/votes.
//
// This endpoint exists because the browser used to read `reputation_votes`
// DIRECTLY through the PocketBase SDK (`pb.collection('reputation_votes')`).
// That collection is server-only — migration 1766300000 gives it nil browser
// rules — so every call returned `403 Only superusers can perform this action`.
// The failures were swallowed by a `catch { return {} }` and surfaced as three
// things a member could actually see:
//
//   - a console full of 403s and aborted ClientResponseErrors on every topic open,
//   - every upvote arrow rendered as un-voted, so the member's own votes looked
//     like they had been lost, and
//   - a re-vote, which the server treats as an UPDATE of the existing vote,
//     silently rewriting the vote the member thought they were merely re-reading.
//
// It returns ONLY the caller's own votes. A vote is a private act until its
// voter chooses to expose it (getPostVotersHandler serves that list and honours
// rep_show_history), so this route must never grow a way to read other people's
// ballots: there is deliberately no voter_id parameter to widen it with.
//
// `topic_id` is optional. With it the answer is the caller's votes in that one
// topic, which is what the topic page needs to paint its arrows; without it the
// answer is every vote the caller has cast.
func listMyVotesHandler(e *core.RequestEvent) error {
	if e.Auth == nil || e.Auth.Collection().Name != usersCollectionName {
		return router.NewUnauthorizedError("authentication is required for this action", nil)
	}
	if AccessFrom(e).Status == auth.StatusBanned {
		return forbiddenError("banned accounts cannot read votes")
	}

	query := e.App.RecordQuery(reputationVotesCollectionName).
		AndWhere(dbx.HashExp{"voter_id": e.Auth.Id})
	if topicID := strings.TrimSpace(e.Request.URL.Query().Get("topic_id")); topicID != "" {
		query = query.AndWhere(dbx.HashExp{"topic_id": topicID})
	}

	var records []*core.Record
	// The cap guards against a pathological account; it is not a pagination
	// contract. The client consumes the whole list to paint its own arrows, so a
	// truncated answer would silently show old votes as un-voted.
	if err := query.OrderBy("created DESC", "id DESC").Limit(1000).All(&records); err != nil {
		return internalError("failed to read your votes", err)
	}

	items := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		items = append(items, map[string]any{
			"id":        rec.Id,
			"post_id":   rec.GetString("post_id"),
			"topic_id":  rec.GetString("topic_id"),
			"target_id": rec.GetString("target_id"),
			"value":     rec.GetInt("value"),
			"comment":   rec.GetString("comment"),
		})
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"request_id": requestIDFrom(e),
	})
}

// getUserReputationLogsHandler returns reputation history for a user profile,
// respecting privacy settings and category visibility.
func getUserReputationLogsHandler(e *core.RequestEvent) error {
	targetUserID := e.Request.PathValue("id")
	targetUser, err := e.App.FindRecordById(usersCollectionName, targetUserID)
	if err != nil || targetUser == nil {
		return notFoundError("user not found")
	}

	acc := AccessFrom(e)
	requesterID := ""
	if e.Auth != nil {
		requesterID = e.Auth.Id
	}
	isCallerStaff := isStaff(acc)
	isTargetUser := requesterID == targetUserID

	// Privacy check: rep_show_history
	repShowHistory := getUserSettingBool(targetUser, "rep_show_history", true)
	if !repShowHistory && !isTargetUser && !isCallerStaff {
		return e.JSON(http.StatusOK, map[string]any{
			"hidden":     true,
			"items":      []any{},
			"total":      0,
			"request_id": requestIDFrom(e),
		})
	}

	// Comment privacy check
	repShowComments := getUserSettingBool(targetUser, "rep_show_comments", true)
	shouldHideComments := (e.Auth == nil || !repShowComments) && !isTargetUser && !isCallerStaff

	limit := forum.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), forum.DefaultPageLimit), forum.DefaultPageLimit)
	page := parseIntParam(e.Request.URL.Query().Get("page"), 1)
	if page < 1 {
		page = 1
	}

	// Optional deep-link seek: ?seek=<voteId> resolves the page that actually
	// holds that one row, so a notification's ?log=<id> link lands on the page
	// containing it instead of page 1. The row's position is how many votes sort
	// BEFORE it in the created DESC, id DESC order the list uses; the target_id
	// guard keeps a foreign id from steering the pager of an unrelated profile.
	if seekID := strings.TrimSpace(e.Request.URL.Query().Get("seek")); seekID != "" {
		if seekRec, err := e.App.FindRecordById(reputationVotesCollectionName, seekID); err == nil && seekRec != nil && seekRec.GetString("target_id") == targetUserID {
			if before, err := e.App.CountRecords(reputationVotesCollectionName,
				dbx.HashExp{"target_id": targetUserID},
				dbx.NewExp("(created > {:created}) OR (created = {:created} AND id > {:id})",
					dbx.Params{
						"created": seekRec.GetDateTime("created").String(),
						"id":      seekRec.Id,
					},
				),
			); err == nil {
				page = int(before/int64(limit)) + 1
			}
		}
	}

	query := e.App.RecordQuery(reputationVotesCollectionName).
		AndWhere(dbx.HashExp{"target_id": targetUserID}).
		OrderBy("created DESC", "id DESC").
		Limit(int64(limit)).
		Offset(int64((page - 1) * limit))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to query reputation logs", err)
	}

	// The WHOLE history, under the same target_id scope as the page query, so the
	// pager and the rows it pages through can never disagree. Reading len(items)
	// here (the page in hand) is what pinned the pager to a single page before:
	// totalPages collapsed to 1 and the numbered pager never drew.
	total, err := e.App.CountRecords(reputationVotesCollectionName, dbx.HashExp{"target_id": targetUserID})
	if err != nil {
		return internalError("failed to count reputation logs", err)
	}
	perPage := int64(limit)
	totalPages := int64(0)
	if total > 0 {
		totalPages = (total + perPage - 1) / perPage
	}

	items := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		postID := rec.GetString("post_id")
		topicID := rec.GetString("topic_id")
		voterID := rec.GetString("voter_id")

		// Resolve the voter so the history row shows a real nickname instead of
		// the "User" placeholder the frontend falls back to when voter_nickname
		// is absent — the server used to ship only voter_id here, so every row
		// read "User" even for staff. This mirrors getPostVotersHandler: a voter
		// who set rep_show_history = false stays anonymous to everyone but
		// themselves and staff.
		voterUser, _ := e.App.FindRecordById(usersCollectionName, voterID)
		voterShowHistory := true
		voterNickname := "User"
		var avatarURL any
		if voterUser != nil {
			voterShowHistory = getUserSettingBool(voterUser, "rep_show_history", true)
			voterNickname = voterUser.GetString("nickname")
			avatarURL = voterUser.GetString("avatar_url")
		}
		voterIsPrivate := !voterShowHistory && voterID != requesterID && !isCallerStaff

		comment := rec.GetString("comment")
		if shouldHideComments && voterID != requesterID {
			comment = ""
		}

		item := map[string]any{
			"id":             rec.Id,
			"voter_id":       voterID,
			"target_id":      targetUserID,
			"voter_nickname": voterNickname,
			"avatar_url":     avatarURL,
			"value":          rec.GetInt("value"),
			"comment":        comment,
			"created_at":     rec.GetDateTime("created").String(),
			"is_allowed":     true,
		}

		if voterIsPrivate {
			item["voter_id"] = nil
			item["voter_nickname"] = "Anonymous"
			item["avatar_url"] = nil
		}

		if postID != "" {
			// Enforce hidden-category protection:
			// A hidden-category post/topic must NEVER leak through profile endpoints!
			allowed, topic, _ := canViewTopic(e.App, acc, topicID)
			if !allowed || topic == nil {
				item["is_allowed"] = false
				item["post_id"] = nil
				item["topic_id"] = nil
				item["topic_title"] = ""
			} else {
				item["post_id"] = postID
				item["topic_id"] = topicID
				item["topic_title"] = topic.GetString("title")
				// The post's "#N" position, which the tooltip prints next to the
				// topic title. reputation_votes carries no post_number column —
				// Firestore denormalised it onto the vote; the command layer does
				// not — so it is recomputed from the post row here: the count of
				// visible posts in the topic that sort at or before this one by
				// created ASC, id ASC, which is exactly how the topic feed numbers
				// its posts. A post the topic no longer has (hard delete) resolves
				// to 0, and the tooltip drops the number rather than inventing one.
				if post, perr := e.App.FindRecordById(postsCollectionName, postID); perr == nil && post != nil {
					if n, cerr := e.App.CountRecords(postsCollectionName,
						dbx.HashExp{"topic_id": topicID},
						dbx.NewExp("is_draft = false OR is_draft IS NULL"),
						dbx.NewExp("(created < {:created}) OR (created = {:created} AND id <= {:id})",
							dbx.Params{
								"created": post.GetDateTime("created").String(),
								"id":      postID,
							},
						),
					); cerr == nil {
						item["post_number"] = int(n)
					}
				}
			}
		}

		items = append(items, item)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"hidden":      false,
		"items":       items,
		"total":       total,
		"page":        page,
		"per_page":    limit,
		"total_pages": totalPages,
		"request_id":  requestIDFrom(e),
	})
}
