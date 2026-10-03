package pocketbase

import (
	"encoding/json"
	"fmt"
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

		targetUserID := post.GetString("author_id")
		val, comment, err := forum.ValidateReputationVote(e.Auth.Id, targetUserID, form.Value, form.Comment)
		if err != nil {
			return 0, nil, validationError(err.Error())
		}

		targetUser, err := txApp.FindRecordById(usersCollectionName, targetUserID)
		if err != nil || targetUser == nil {
			return 0, nil, notFoundError("target user not found")
		}

		// Look up existing vote on this post by this voter
		existingVote, err := txApp.FindFirstRecordByFilter(
			reputationVotesCollectionName,
			"voter_id = {:voter} && post_id = {:post}",
			dbx.Params{"voter": e.Auth.Id, "post": postID},
		)

		var voteRecord *core.Record
		if err == nil && existingVote != nil {
			// Controlled replacement
			oldVal := existingVote.GetInt("value")
			delta := val - oldVal
			if delta != 0 {
				post.Set("reputation", post.GetInt("reputation")+delta)
				targetUser.Set("reputation", targetUser.GetInt("reputation")+delta)
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
			targetUser.Set("reputation", targetUser.GetInt("reputation")+val)
			voteRecord = newVote
		}

		if err := txApp.Save(post); err != nil {
			return 0, nil, internalError("failed to update post reputation", err)
		}
		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to update user reputation", err)
		}

		return http.StatusOK, map[string]any{
			"vote":              repVotePayload(voteRecord),
			"post_reputation":   post.GetInt("reputation"),
			"target_reputation": targetUser.GetInt("reputation"),
			"request_id":        requestIDFrom(e),
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
		if err == nil && existingVote != nil {
			oldVal := existingVote.GetInt("value")
			delta := val - oldVal
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
			voteRecord = newVote
		}

		if err := txApp.Save(targetUser); err != nil {
			return 0, nil, internalError("failed to update user reputation", err)
		}

		return http.StatusOK, map[string]any{
			"vote":              repVotePayload(voteRecord),
			"target_reputation": targetUser.GetInt("reputation"),
			"request_id":        requestIDFrom(e),
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

// deleteReputationHandler is an administrative command to delete any reputation vote.
// Reverts post and profile reputation and appends an audit log.
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
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))

	query := e.App.RecordQuery(reputationVotesCollectionName).
		AndWhere(dbx.HashExp{"target_id": targetUserID})

	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			created := parts[0]
			id := parts[1]
			query = query.AndWhere(dbx.NewExp(
				"(created < {:created}) OR (created = {:created} AND id < {:id})",
				dbx.Params{
					"created": created,
					"id":      id,
				},
			))
		}
	}

	query = query.OrderBy("created DESC", "id DESC").Limit(int64(limit + 1))

	var records []*core.Record
	if err := query.All(&records); err != nil {
		return internalError("failed to query reputation logs", err)
	}

	var nextCursor string
	if len(records) > limit {
		lastRec := records[limit-1]
		records = records[:limit]
		nextCursor = fmt.Sprintf("%s|%s", lastRec.GetDateTime("created").String(), lastRec.Id)
	}

	items := make([]map[string]any, 0, len(records))
	for _, rec := range records {
		postID := rec.GetString("post_id")
		topicID := rec.GetString("topic_id")
		voterID := rec.GetString("voter_id")

		comment := rec.GetString("comment")
		if shouldHideComments && voterID != requesterID {
			comment = ""
		}

		item := map[string]any{
			"id":         rec.Id,
			"voter_id":   voterID,
			"target_id":  targetUserID,
			"value":      rec.GetInt("value"),
			"comment":    comment,
			"created_at": rec.GetDateTime("created").String(),
			"is_allowed": true,
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
			}
		}

		items = append(items, item)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"hidden":      false,
		"items":       items,
		"next_cursor": nextCursor,
		"total":       len(items),
		"request_id":  requestIDFrom(e),
	})
}
