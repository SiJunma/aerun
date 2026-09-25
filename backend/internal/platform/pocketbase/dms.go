package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/SiJunma/aerun/backend/internal/auth"
	"github.com/SiJunma/aerun/backend/internal/messaging"
)

const (
	dmConversationsCollectionName = "dm_conversations"
	dmMembersCollectionName       = "dm_members"
	dmMessagesCollectionName      = "dm_messages"
	maxDMBodyBytes                = 128 * 1024
)

type createDMForm struct {
	RecipientIDs []string `json:"recipient_ids"`
	Title        string   `json:"title"`
	Text         string   `json:"text"`
}

type sendDMMessageForm struct {
	Text string `json:"text"`
}

func dmMessagePayload(rec *core.Record) map[string]any {
	return map[string]any{
		"id":              rec.Id,
		"conversation_id": rec.GetString("conversation_id"),
		"sender_id":       rec.GetString("sender_id"),
		"sequence":        rec.GetInt("sequence"),
		"text":            rec.GetString("text"),
		"created":         rec.GetDateTime("created").String(),
	}
}

// createOrReplyDMHandler initiates a new DM conversation or sends the first message.
func createDMHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	raw, err := readBodyLimited(e, maxDMBodyBytes)
	if err != nil {
		return err
	}

	var form createDMForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	recipients, err := messaging.ValidateParticipants(e.Auth.Id, form.RecipientIDs)
	if err != nil {
		return validationError(err.Error())
	}

	cleanText, err := messaging.ValidateMessageText(form.Text)
	if err != nil {
		return validationError(err.Error())
	}

	cleanTitle, err := messaging.ValidateConversationTitle(form.Title)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		// Verify recipients exist and are active
		recipientUsers := make([]*core.Record, len(recipients))
		for i, rID := range recipients {
			u, err := txApp.FindRecordById(usersCollectionName, rID)
			if err != nil || u == nil {
				return 0, nil, notFoundError(fmt.Sprintf("recipient %s not found", rID))
			}
			if u.GetString("status") == string(auth.StatusBanned) {
				return 0, nil, forbiddenError("cannot send message to a banned user")
			}
			recipientUsers[i] = u
		}

		nowISO := types.NowDateTime().String()

		// 1. Create dm_conversations record
		convCol, err := txApp.FindCollectionByNameOrId(dmConversationsCollectionName)
		if err != nil {
			return 0, nil, internalError("dm_conversations collection unavailable", err)
		}

		conv := core.NewRecord(convCol)
		conv.Set("title", cleanTitle)
		conv.Set("last_message", cleanText)
		conv.Set("last_message_at", nowISO)
		conv.Set("messages_count", 1)

		if err := txApp.Save(conv); err != nil {
			return 0, nil, internalError("failed to create conversation", err)
		}

		// 2. Create dm_members for sender and each recipient
		memCol, err := txApp.FindCollectionByNameOrId(dmMembersCollectionName)
		if err != nil {
			return 0, nil, internalError("dm_members collection unavailable", err)
		}

		// Sender member
		senderMem := core.NewRecord(memCol)
		senderMem.Set("conversation_id", conv.Id)
		senderMem.Set("user_id", e.Auth.Id)
		senderMem.Set("last_read_sequence", 1)
		senderMem.Set("cleared_at", "")
		if err := txApp.Save(senderMem); err != nil {
			return 0, nil, internalError("failed to create sender member record", err)
		}

		// Recipient members
		for _, rID := range recipients {
			rMem := core.NewRecord(memCol)
			rMem.Set("conversation_id", conv.Id)
			rMem.Set("user_id", rID)
			rMem.Set("last_read_sequence", 0)
			rMem.Set("cleared_at", "")
			if err := txApp.Save(rMem); err != nil {
				return 0, nil, internalError("failed to create recipient member record", err)
			}
		}

		// 3. Create dm_messages record (sequence = 1)
		msgCol, err := txApp.FindCollectionByNameOrId(dmMessagesCollectionName)
		if err != nil {
			return 0, nil, internalError("dm_messages collection unavailable", err)
		}

		msg := core.NewRecord(msgCol)
		msg.Set("conversation_id", conv.Id)
		msg.Set("sender_id", e.Auth.Id)
		msg.Set("sequence", 1)
		msg.Set("text", cleanText)
		if err := txApp.Save(msg); err != nil {
			return 0, nil, internalError("failed to save message", err)
		}

		// 4. Create in-app notifications and outbox events for recipients
		senderNick := e.Auth.GetString("nickname")
		for _, rUser := range recipientUsers {
			// Persistent in-app notification
			_, _ = createNotification(txApp, rUser.Id, e.Auth.Id, "dm", "New direct message from "+senderNick, map[string]any{
				"conversation_id": conv.Id,
				"message_id":      msg.Id,
				"sequence":        1,
				"sender_nickname": senderNick,
				"preview":         cleanText,
			})

			// Outbox email event with deduplication key: dm:first-unread:{conv}:{recipient}
			dedupeKey := messaging.MakeDMUnreadDedupeKey(conv.Id, rUser.Id)
			_ = enqueueOutboxEvent(txApp, dedupeKey, "email:dm_unread", MailPayload{
				RecipientID: rUser.Id,
				ToEmail:     rUser.Email(),
				Subject:     "New direct message from " + senderNick,
				BodyText:    fmt.Sprintf("%s sent you a message:\n\n%s", senderNick, cleanText),
			})
		}

		return http.StatusOK, map[string]any{
			"conversation_id": conv.Id,
			"sequence":        1,
			"message":         dmMessagePayload(msg),
			"request_id":      requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// sendDMMessageHandler sends a reply message within an existing conversation.
func sendDMMessageHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	convID := e.Request.PathValue("id")
	raw, err := readBodyLimited(e, maxDMBodyBytes)
	if err != nil {
		return err
	}

	var form sendDMMessageForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}

	cleanText, err := messaging.ValidateMessageText(form.Text)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		// Verify caller is a member of this conversation
		member, err := txApp.FindFirstRecordByFilter(
			dmMembersCollectionName,
			"conversation_id = {:conv} && user_id = {:user}",
			dbx.Params{"conv": convID, "user": e.Auth.Id},
		)
		if err != nil || member == nil {
			return 0, nil, forbiddenError("you are not a participant in this conversation")
		}

		conv, err := txApp.FindRecordById(dmConversationsCollectionName, convID)
		if err != nil || conv == nil {
			return 0, nil, notFoundError("conversation not found")
		}

		// Monotonic sequence assignment within the conversation transaction
		nextSeq := conv.GetInt("messages_count") + 1
		nowISO := types.NowDateTime().String()

		// 1. Create dm_messages record
		msgCol, err := txApp.FindCollectionByNameOrId(dmMessagesCollectionName)
		if err != nil {
			return 0, nil, internalError("dm_messages collection unavailable", err)
		}

		msg := core.NewRecord(msgCol)
		msg.Set("conversation_id", convID)
		msg.Set("sender_id", e.Auth.Id)
		msg.Set("sequence", nextSeq)
		msg.Set("text", cleanText)

		if err := txApp.Save(msg); err != nil {
			return 0, nil, internalError("failed to save message", err)
		}

		// 2. Update conversation metadata
		conv.Set("last_message", cleanText)
		conv.Set("last_message_at", nowISO)
		conv.Set("messages_count", nextSeq)
		if err := txApp.Save(conv); err != nil {
			return 0, nil, internalError("failed to update conversation", err)
		}

		// 3. Update sender's last_read_sequence
		member.Set("last_read_sequence", nextSeq)
		if err := txApp.Save(member); err != nil {
			return 0, nil, internalError("failed to update sender read sequence", err)
		}

		// 4. Find other members to notify
		otherMembers, err := txApp.FindRecordsByFilter(
			dmMembersCollectionName,
			"conversation_id = {:conv} && user_id != {:user}",
			"created",
			100,
			0,
			dbx.Params{"conv": convID, "user": e.Auth.Id},
		)
		if err == nil {
			senderNick := e.Auth.GetString("nickname")
			for _, m := range otherMembers {
				rID := m.GetString("user_id")
				_, _ = createNotification(txApp, rID, e.Auth.Id, "dm", "New direct message from "+senderNick, map[string]any{
					"conversation_id": conv.Id,
					"message_id":      msg.Id,
					"sequence":        nextSeq,
					"sender_nickname": senderNick,
					"preview":         cleanText,
				})

				// Deduplicated email outbox event
				dedupeKey := messaging.MakeDMUnreadDedupeKey(conv.Id, rID)
				u, _ := txApp.FindRecordById(usersCollectionName, rID)
				if u != nil {
					_ = enqueueOutboxEvent(txApp, dedupeKey, "email:dm_unread", MailPayload{
						RecipientID: rID,
						ToEmail:     u.Email(),
						Subject:     "New direct message from " + senderNick,
						BodyText:    fmt.Sprintf("%s sent you a message:\n\n%s", senderNick, cleanText),
					})
				}
			}
		}

		return http.StatusOK, map[string]any{
			"message":    dmMessagePayload(msg),
			"sequence":   nextSeq,
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}

// listConversationsHandler returns keyset-paginated conversations for the caller.
func listConversationsHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	limit := messaging.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), messaging.DefaultPageLimit), messaging.DefaultPageLimit)
	cursor := strings.TrimSpace(e.Request.URL.Query().Get("cursor"))

	query := `
		SELECT 
			c.id AS id,
			c.title AS title,
			c.last_message AS last_message,
			c.last_message_at AS last_message_at,
			c.messages_count AS messages_count,
			m.last_read_sequence AS last_read_sequence,
			m.cleared_at AS cleared_at,
			c.created AS created,
			c.updated AS updated
		FROM dm_members m
		JOIN dm_conversations c ON c.id = m.conversation_id
		WHERE m.user_id = {:user}
	`
	params := dbx.Params{"user": e.Auth.Id}

	// Filter out conversations cleared by user if no new messages arrived
	query += " AND (m.cleared_at = '' OR m.cleared_at IS NULL OR c.last_message_at > m.cleared_at)"

	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			query += " AND ((c.last_message_at < {:cursor_time}) OR (c.last_message_at = {:cursor_time} AND c.id < {:cursor_id}))"
			params["cursor_time"] = parts[0]
			params["cursor_id"] = parts[1]
		}
	}

	query += fmt.Sprintf(" ORDER BY c.last_message_at DESC, c.id DESC LIMIT %d", limit+1)

	type convRow struct {
		ID               string `db:"id"`
		Title            string `db:"title"`
		LastMessage      string `db:"last_message"`
		LastMessageAt    string `db:"last_message_at"`
		MessagesCount    int    `db:"messages_count"`
		LastReadSequence int    `db:"last_read_sequence"`
		ClearedAt        string `db:"cleared_at"`
		Created          string `db:"created"`
		Updated          string `db:"updated"`
	}

	rows := []convRow{}
	if err := e.App.DB().NewQuery(query).Bind(params).All(&rows); err != nil {
		return internalError("failed to query conversations", err)
	}

	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}

	items := make([]map[string]any, len(rows))
	for i, r := range rows {
		unread := r.MessagesCount - r.LastReadSequence
		if unread < 0 {
			unread = 0
		}
		items[i] = map[string]any{
			"id":                 r.ID,
			"title":              r.Title,
			"last_message":       r.LastMessage,
			"last_message_at":    r.LastMessageAt,
			"messages_count":     r.MessagesCount,
			"last_read_sequence": r.LastReadSequence,
			"unread_count":       unread,
			"created":            r.Created,
			"updated":            r.Updated,
		}
	}

	var nextCursor string
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		nextCursor = last.LastMessageAt + "|" + last.ID
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":       items,
		"has_more":    hasMore,
		"next_cursor": nextCursor,
		"request_id":  requestIDFrom(e),
	})
}

// listDMMessagesHandler lists ordered messages in a conversation.
func listDMMessagesHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	convID := e.Request.PathValue("id")
	limit := messaging.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), messaging.DefaultPageLimit), messaging.DefaultPageLimit)
	afterSeq := parseIntParam(e.Request.URL.Query().Get("after_sequence"), 0)

	// Verify membership
	member, err := e.App.FindFirstRecordByFilter(
		dmMembersCollectionName,
		"conversation_id = {:conv} && user_id = {:user}",
		dbx.Params{"conv": convID, "user": e.Auth.Id},
	)
	if err != nil || member == nil {
		return forbiddenError("you are not a participant in this conversation")
	}

	query := e.App.RecordQuery(dmMessagesCollectionName).
		AndWhere(dbx.HashExp{"conversation_id": convID})

	clearedAt := member.GetString("cleared_at")
	if clearedAt != "" {
		query = query.AndWhere(dbx.NewExp("created > {:cleared_at}", dbx.Params{"cleared_at": clearedAt}))
	}

	if afterSeq > 0 {
		query = query.AndWhere(dbx.NewExp("sequence > {:seq}", dbx.Params{"seq": afterSeq}))
	}

	query = query.OrderBy("sequence ASC").Limit(int64(limit + 1))

	records := []*core.Record{}
	if err := query.All(&records); err != nil {
		return internalError("failed to query messages", err)
	}

	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}

	items := make([]map[string]any, len(records))
	for i, r := range records {
		items[i] = dmMessagePayload(r)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items":      items,
		"has_more":   hasMore,
		"request_id": requestIDFrom(e),
	})
}

// markConversationReadHandler marks all messages in a conversation as read for caller.
func markConversationReadHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	convID := e.Request.PathValue("id")

	member, err := e.App.FindFirstRecordByFilter(
		dmMembersCollectionName,
		"conversation_id = {:conv} && user_id = {:user}",
		dbx.Params{"conv": convID, "user": e.Auth.Id},
	)
	if err != nil || member == nil {
		return forbiddenError("you are not a participant in this conversation")
	}

	conv, err := e.App.FindRecordById(dmConversationsCollectionName, convID)
	if err != nil || conv == nil {
		return notFoundError("conversation not found")
	}

	maxSeq := conv.GetInt("messages_count")
	member.Set("last_read_sequence", maxSeq)
	if err := e.App.Save(member); err != nil {
		return internalError("failed to update read sequence", err)
	}

	// Also mark in-app notifications for this conversation as read
	_, _ = e.App.DB().NewQuery(`
		UPDATE notifications 
		SET read = true 
		WHERE recipient_id = {:user} AND type = 'dm' AND payload LIKE {:pattern}
	`).Bind(dbx.Params{
		"user":    e.Auth.Id,
		"pattern": `%"conversation_id":"` + convID + `"%`,
	}).Execute()

	return e.JSON(http.StatusOK, map[string]any{
		"conversation_id":    convID,
		"last_read_sequence": maxSeq,
		"request_id":         requestIDFrom(e),
	})
}

// clearConversationHandler marks a conversation cleared for the caller.
func clearConversationHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	convID := e.Request.PathValue("id")

	member, err := e.App.FindFirstRecordByFilter(
		dmMembersCollectionName,
		"conversation_id = {:conv} && user_id = {:user}",
		dbx.Params{"conv": convID, "user": e.Auth.Id},
	)
	if err != nil || member == nil {
		return forbiddenError("you are not a participant in this conversation")
	}

	nowISO := types.NowDateTime().String()
	member.Set("cleared_at", nowISO)
	if err := e.App.Save(member); err != nil {
		return internalError("failed to clear conversation", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"cleared":    true,
		"cleared_at": nowISO,
		"request_id": requestIDFrom(e),
	})
}
