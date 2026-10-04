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
	// Rolls is the result of the dice in the message. See createPostForm.Rolls:
	// the `[roll=<id>]` tag in the text is only a pointer, and this map is what
	// it points into.
	Rolls map[string]any `json:"rolls"`
}

type sendDMMessageForm struct {
	Text  string         `json:"text"`
	Rolls map[string]any `json:"rolls"`
}

type editDMMessageForm struct {
	Text string `json:"text"`
	// A POINTER, like editPostForm.Rolls: an edit that did not touch the dice
	// must not wipe the throws the message already carries.
	Rolls *map[string]any `json:"rolls"`
}

// requireDMMember reports whether userID is a participant in conversationID.
//
// Every DM command passes through this rather than trusting the conversation id
// in the URL: rows in dm_messages carry a conversation_id but no per-viewer
// access rule, so "is this my conversation" has to be asked explicitly or a
// member could read and rewrite somebody else's mail by guessing an id.
func requireDMMember(txApp core.App, conversationID, userID string) error {
	member, err := txApp.FindFirstRecordByFilter(
		dmMembersCollectionName,
		"conversation_id = {:c} && user_id = {:u}",
		dbx.Params{"c": conversationID, "u": userID},
	)
	if err != nil || member == nil {
		return forbiddenError("this conversation is not yours")
	}
	return nil
}

// editDMMessageHandler lets a sender correct a message they sent.
//
// Sender-only, deliberately. The recipient cannot edit what the other person
// wrote — that would make a private conversation forgeable by its audience —
// and neither can a moderator: a DM is not forum content, and staff authority
// over the forum does not extend into it. `edit_others_posts` does NOT apply
// here.
//
// A tombstone is not editable. Once deleted there is no text left to correct,
// and accepting an edit would quietly resurrect a message the sender took back.
func editDMMessageHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}
	id := e.Request.PathValue("id")

	raw, err := readBodyLimited(e, maxDMBodyBytes)
	if err != nil {
		return err
	}
	var form editDMMessageForm
	if err := json.Unmarshal(raw, &form); err != nil {
		return validationError("invalid JSON body")
	}
	cleanText, err := messaging.ValidateMessageText(form.Text)
	if err != nil {
		return validationError(err.Error())
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		msg, err := txApp.FindRecordById(dmMessagesCollectionName, id)
		if err != nil || msg == nil {
			return 0, nil, notFoundError("message not found")
		}
		if err := requireDMMember(txApp, msg.GetString("conversation_id"), e.Auth.Id); err != nil {
			return 0, nil, err
		}
		if msg.GetString("sender_id") != e.Auth.Id {
			return 0, nil, forbiddenError("you can only edit messages you sent")
		}
		if !msg.GetDateTime("deleted_at").IsZero() {
			return 0, nil, conflictError("this message was deleted and can no longer be edited")
		}

		msg.Set("text", cleanText)
		// Only when the request carries them: an edit that never touched the dice
		// must leave the stored throws alone, exactly as editPostForm does.
		if form.Rolls != nil {
			if err := writeRolls(msg, cleanText, *form.Rolls); err != nil {
				return 0, nil, validationError(err.Error())
			}
		}
		msg.Set("edited", types.NowDateTime())
		if err := txApp.Save(msg); err != nil {
			return 0, nil, internalError("failed to edit the message", err)
		}

		// The conversation preview is a copy of the newest message's text, so
		// an edit that left it stale would show the old words in the list.
		if err := refreshConversationPreview(txApp, msg.GetString("conversation_id")); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"message":    dmMessagePayload(msg),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// deleteDMMessageHandler soft-deletes a message the caller SENT.
//
// The row survives with an emptied text and a `deleted_at`, so the thread keeps
// its shape and the other participant can see that something was said and
// removed. This is the deliberate opposite of the forum, where deleting a post
// removes it completely.
//
// Sender-only, for the same reason editing is. The counterpart — "delete for
// me" — is the `clear` route that already exists, and that one IS per-viewer.
func deleteDMMessageHandler(e *core.RequestEvent) error {
	claim, err := claimFrom(e)
	if err != nil {
		return err
	}
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}
	id := e.Request.PathValue("id")

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		msg, err := txApp.FindRecordById(dmMessagesCollectionName, id)
		if err != nil || msg == nil {
			return 0, nil, notFoundError("message not found")
		}
		if err := requireDMMember(txApp, msg.GetString("conversation_id"), e.Auth.Id); err != nil {
			return 0, nil, err
		}
		if msg.GetString("sender_id") != e.Auth.Id {
			return 0, nil, forbiddenError("you can only delete messages you sent")
		}
		if !msg.GetDateTime("deleted_at").IsZero() {
			// Idempotent by outcome, and deliberately does NOT rewrite
			// deleted_at: that timestamp is the record of when the message
			// actually went, and a second delete must not move it.
			return http.StatusOK, map[string]any{
				"deleted":    true,
				"id":         id,
				"request_id": requestIDFrom(e),
			}, nil
		}

		msg.Set("text", "")
		msg.Set("deleted_at", types.NowDateTime())
		if err := txApp.Save(msg); err != nil {
			return 0, nil, internalError("failed to delete the message", err)
		}

		// messages_count deliberately does NOT change: the row is still a
		// message in this conversation. Only the preview moves.
		if err := refreshConversationPreview(txApp, msg.GetString("conversation_id")); err != nil {
			return 0, nil, err
		}

		if err := recordAuditLog(txApp, "dm_message_delete", e.Auth.Id, map[string]any{
			"message_id":      msg.Id,
			"conversation_id": msg.GetString("conversation_id"),
			"sequence":        msg.GetInt("sequence"),
		}); err != nil {
			return 0, nil, err
		}

		return http.StatusOK, map[string]any{
			"deleted":    true,
			"id":         id,
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// refreshConversationPreview re-derives a conversation's `last_message` from the
// newest NON-DELETED row, and clears it when every message was deleted.
//
// Without this the conversation list would keep showing the text of a message
// that has just been deleted — the most visible way a soft delete could leak
// the very content it was supposed to remove.
func refreshConversationPreview(txApp core.App, conversationID string) error {
	conv, err := txApp.FindRecordById(dmConversationsCollectionName, conversationID)
	if err != nil || conv == nil {
		return internalError("conversation missing for a message", err)
	}
	rows, err := txApp.FindAllRecords(
		dmMessagesCollectionName,
		dbx.NewExp("conversation_id = {:c}", dbx.Params{"c": conversationID}),
	)
	if err != nil {
		return internalError("failed to read a conversation's messages", err)
	}

	preview := ""
	lastAt := types.DateTime{}
	bestSeq := -1
	for _, row := range rows {
		if !row.GetDateTime("deleted_at").IsZero() {
			continue
		}
		if seq := row.GetInt("sequence"); seq > bestSeq {
			bestSeq = seq
			preview = row.GetString("text")
			lastAt = row.GetDateTime("created")
		}
	}

	conv.Set("last_message", preview)
	if !lastAt.IsZero() {
		conv.Set("last_message_at", lastAt)
	}
	return txApp.Save(conv)
}

func dmMessagePayload(rec *core.Record) map[string]any {
	// A deleted message keeps its row, its place in the sequence and its
	// position in the thread — the conversation must not develop a hole. Only
	// the text is gone, and `deleted` says so, so the client can render a
	// tombstone instead of pretending nothing was ever sent.
	//
	// The text is never echoed back after deletion, not even empty: an empty
	// string in a payload reads as "a message with no content" to a client
	// that does not check the flag, which is how a deleted message turns back
	// into a blank row in the UI.
	payload := map[string]any{
		"id":              rec.Id,
		"conversation_id": rec.GetString("conversation_id"),
		"sender_id":       rec.GetString("sender_id"),
		"sequence":        rec.GetInt("sequence"),
		"created":         rec.GetDateTime("created").String(),
		"edited":          "",
		"deleted":         false,
	}

	if deletedAt := rec.GetDateTime("deleted_at"); !deletedAt.IsZero() {
		payload["deleted"] = true
		payload["deleted_at"] = deletedAt.String()
		return payload
	}

	payload["text"] = rec.GetString("text")
	// The throws, resolved exactly as on a post. Both participants of a
	// conversation are members of it, and `view_master_dice` is applied the same
	// way here — a DM is not a place where a permission quietly stops applying.
	if rolls, err := decodeRolls(rec.Get("rolls")); err == nil && len(rolls) > 0 {
		payload["rolls"] = rolls
	}
	if edited := rec.GetDateTime("edited"); !edited.IsZero() {
		payload["edited"] = edited.String()
	}
	return payload
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
		// Verify recipients exist, are active, and may actually be messaged.
		//
		// THE RECIPIENT'S RIGHT IS CHECKED, NOT ONLY THE SENDER'S. The route already
		// gates the caller on `use_direct_messages`, which is why hiding the button
		// looked sufficient. It is not: any member who holds the key could POST a
		// recipient id directly and open a conversation with an account whose role
		// deliberately does not permit DMs — a spectator, a pending account, a custom
		// role with the key removed. The stored role row is the authority, so the
		// recipient's own effective permissions decide, narrowed by the same status
		// rules that would authenticate them.
		//
		// A rejected recipient names the ROLE, not the account, so the sender learns
		// that the capability is switched off without learning who holds what.
		recipientUsers := make([]*core.Record, len(recipients))
		for i, rID := range recipients {
			u, err := txApp.FindRecordById(usersCollectionName, rID)
			if err != nil || u == nil {
				return 0, nil, notFoundError(fmt.Sprintf("recipient %s not found", rID))
			}
			if u.GetString("status") == string(auth.StatusBanned) {
				return 0, nil, forbiddenError("cannot send message to a banned user")
			}
			recipientAcc := accessForUser(txApp, u)
			if !auth.Has(recipientAcc.Permissions, auth.PermUseDirectMessages) {
				return 0, nil, forbiddenError(
					"this account cannot receive direct messages (role " + string(recipientAcc.Role) + ")")
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
		if err := writeRolls(msg, cleanText, form.Rolls); err != nil {
			return 0, nil, validationError(err.Error())
		}
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
				"sender_uid":      e.Auth.Id,
				"sender_nickname": senderNick,
				"preview":         cleanText,
			})

			// The DM list is a SEPARATE resource from the notification list, and
			// the notification signal fired above — so without this nudge the
			// conversation preview waits for a poll while the badge updates
			// instantly.
			//
			// Addressed to each recipient individually rather than to the
			// conversation: a conversation id is not something a non-member may
			// learn from the stream.
			publishSignal(txApp, realtimeSignalDMPost, msg.Id, rUser.Id)

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

		// Nobody may message a suspended account, and createDMHandler already
		// says so — but only for conversations opened AFTER the ban. A thread
		// started while everybody was still active kept accepting messages
		// forever, which is how a ban quietly stops applying to the one channel
		// people actually talk in.
		//
		// Every OTHER participant is checked, not just the counterpart: group
		// conversations exist, so one suspended member is enough to make the
		// whole thread unwritable.
		others, err := txApp.FindAllRecords(dmMembersCollectionName,
			dbx.HashExp{"conversation_id": convID})
		if err != nil {
			return 0, nil, internalError("failed to read conversation members", err)
		}
		for _, member := range others {
			if member.GetString("user_id") == e.Auth.Id {
				continue
			}
			other, err := txApp.FindRecordById(usersCollectionName, member.GetString("user_id"))
			if err != nil || other == nil {
				continue
			}
			if other.GetString("status") == string(auth.StatusBanned) {
				return 0, nil, forbiddenError("cannot send message to a banned user")
			}
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
		if err := writeRolls(msg, cleanText, form.Rolls); err != nil {
			return 0, nil, validationError(err.Error())
		}

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

		// 4. Find other members to notify, and check each may still receive DMs.
		//
		// The recipient's permission is re-checked HERE, not only when the
		// conversation was opened. A conversation created while the recipient
		// held `use_direct_messages` outlives the role change that removed it —
		// demote a member afterwards and the send path would keep working
		// forever, because the gate at conversation creation already passed.
		// Re-checking on every send is what makes a permission take effect on the
		// member it was actually changed for.
		otherMembers, err := txApp.FindRecordsByFilter(
			dmMembersCollectionName,
			"conversation_id = {:conv} && user_id != {:user}",
			"created",
			100,
			0,
			dbx.Params{"conv": convID, "user": e.Auth.Id},
		)
		if err != nil {
			return 0, nil, internalError("failed to load conversation members", err)
		}
		for _, m := range otherMembers {
			recipient, rErr := txApp.FindRecordById(usersCollectionName, m.GetString("user_id"))
			if rErr != nil || recipient == nil {
				return 0, nil, internalError("failed to load conversation member", rErr)
			}
			if !auth.Has(accessForUser(txApp, recipient).Permissions, auth.PermUseDirectMessages) {
				return 0, nil, forbiddenError("a participant can no longer receive direct messages")
			}
		}

		if err == nil {
			senderNick := e.Auth.GetString("nickname")
			for _, m := range otherMembers {
				rID := m.GetString("user_id")
				_, _ = createNotification(txApp, rID, e.Auth.Id, "dm", "New direct message from "+senderNick, map[string]any{
					"conversation_id": conv.Id,
					"message_id":      msg.Id,
					"sequence":        nextSeq,
					"sender_uid":      e.Auth.Id,
					"sender_nickname": senderNick,
					"preview":         cleanText,
				})

				// The DM list is a SEPARATE resource from the notification list,
				// and the notification signal fired above — so without this nudge
				// the conversation preview waits for a poll while the badge updates
				// instantly.
				//
				// Addressed to each recipient individually rather than to the
				// conversation: a conversation id is not something a non-member
				// may learn from the stream.
				publishSignal(txApp, realtimeSignalDMPost, msg.Id, rID)

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
