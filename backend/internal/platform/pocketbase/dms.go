package pocketbase

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

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

// THE TWO FOLDERS of the direct-message list (owner's model, 2026-10-19).
//
// "Inbox" is the chats the member still has. "Deleted" is the chats they
// explicitly removed: the history still exists, and a second, explicit step
// there erases it for good — but only the parts no participant can read
// any more.
//
// The split is per-member (both markers live in dm_members), so two
// participants can hold the same conversation in different folders at the same
// time — which is exactly the state the owner's rule has to survive.
const (
	dmFolderInbox   = "inbox"
	dmFolderDeleted = "deleted"
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

// isMemberOnline reports whether userID is currently active in the live presence map.
//
// Firebase parity: onDmMessageCreated checked whether the recipient was currently
// online on the forum (state == 'online'). In PocketBase, live presence is
// tracked in onlineMembers with presenceTTL (75s, refreshed every 30s by heartbeat).
// When a user logs out, they are removed from onlineMembers immediately.
// When a user closes the tab, they expire after presenceTTL.
func isMemberOnline(userID string, now time.Time) bool {
	presenceMu.RLock()
	defer presenceMu.RUnlock()
	m, ok := onlineMembers[userID]
	return ok && !m.LastSeen.Before(now.Add(-presenceTTL))
}

// dmEmailEnabled mirrors the Firebase check
// `settings.email_notifications.dms !== false` (default true).
func dmEmailEnabled(user *core.Record) bool {
	return emailNotificationsPref(user, "dms")
}

// emailNotificationsPref reads one boolean from
// settings.email_notifications.<prefKey>, defaulting to true when the member
// never touched the toggle — the same "absent means enabled" contract
// Firebase had. It backs dmEmailEnabled ("dms") and topicReplyEmailEnabled
// ("topic_replies").
func emailNotificationsPref(user *core.Record, prefKey string) bool {
	raw := user.Get("settings")
	if raw == nil {
		return true
	}
	var settings map[string]any
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &settings); err != nil {
			return true
		}
	case map[string]any:
		settings = v
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return true
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return true
		}
	}
	node, ok := settings["email_notifications"]
	if !ok || node == nil {
		return true
	}
	group, ok := node.(map[string]any)
	if !ok {
		if data, err := json.Marshal(node); err == nil {
			_ = json.Unmarshal(data, &group)
		}
	}
	if group == nil {
		return true
	}
	val, ok := group[prefKey]
	if !ok || val == nil {
		return true
	}
	if b, ok := val.(bool); ok {
		return b
	}
	return true
}

// maybeEnqueueDMEmail queues the first-unread DM email for recipient — unless
// the recipient disabled DM mail or is currently online.
//
// Enqueue-time guard (fixes "both online, email still sent"). The dispatch
// worker re-checks before sending: up to a minute passes between queue and
// send, and the recipient may come online in between.
func maybeEnqueueDMEmail(txApp core.App, conversationID string, recipient *core.Record, senderNick, text string) {
	recipientId := ""
	if recipient != nil {
		recipientId = recipient.Id
	}
	if recipient == nil || !dmEmailEnabled(recipient) {
		txApp.Logger().Debug("dm-email skipped: recipient nil or email disabled", "conversation_id", conversationID, "recipient_id", recipientId)
		return
	}
	if isMemberOnline(recipient.Id, time.Now()) {
		txApp.Logger().Debug("dm-email skipped: recipient is online", "conversation_id", conversationID, "recipient_id", recipient.Id)
		return
	}
	tpl, ok := loadEmailTemplates(txApp)[emailTemplateDM]
	if !ok {
		txApp.Logger().Debug("dm-email skipped: template missing", "conversation_id", conversationID, "recipient_id", recipientId)
		// The resolver guarantees the built-in default, so this only ever
		// happens if the defaults themselves lose the key — better to skip
		// one mail than to send an empty one.
		return
	}
	// The subject template carries {SENDER_NAME}; the title also feeds the
	// wrapper's <title>, exactly as renderDmNotificationEmail set it in
	// functions/email.js.
	title := "New Direct Message from " + senderNick
	subject, bodyHTML := renderEmailFromTemplate(tpl, txApp.Settings().Meta.AppName, title, map[string]string{
		phRecipientName: recipient.GetString("nickname"),
		phSenderName:    senderNick,
		phSnippet:       dmEmailSnippet(text),
		phMessagesURL:   strings.TrimRight(txApp.Settings().Meta.AppURL, "/") + "/messages",
	})
	dedupeKey := messaging.MakeDMUnreadDedupeKey(conversationID, recipient.Id)
	_ = enqueueOutboxEvent(txApp, dedupeKey, "email:dm_unread", MailPayload{
		RecipientID: recipient.Id,
		ToEmail:     recipient.Email(),
		Subject:     subject,
		BodyText:    fmt.Sprintf("%s sent you a message:\n\n%s", senderNick, text),
		BodyHTML:    bodyHTML,
	})
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

		// The other side is holding this message on screen. Without the nudge
		// it keeps showing the words that were just corrected.
		publishDMSignalToPeers(txApp, msg.GetString("conversation_id"), msg.Id, e.Auth.Id)

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
			//
			// The row still rides back, because this is the ONLY answer the
			// caller has: the sender is excluded from the signal this delete
			// publishes, so without the row here the thread would keep
			// rendering the text that no longer exists until some unrelated
			// poll happened to land.
			return http.StatusOK, map[string]any{
				"deleted":    true,
				"id":         id,
				"message":    dmMessagePayload(msg),
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

		// A delete is more visible than an edit: the reader is left holding text
		// that no longer exists anywhere. They must not keep it until a poll.
		publishDMSignalToPeers(txApp, msg.GetString("conversation_id"), msg.Id, e.Auth.Id)

		// The tombstone is returned for the same reason the edit returns its
		// row: the sender is deliberately NOT signalled about their own
		// mutation, so this response is the only thing that can repaint the
		// bubble they are looking at. Answering "deleted: true" alone left
		// the client holding the text it had just withdrawn, with a success
		// toast on top of it.
		return http.StatusOK, map[string]any{
			"deleted":    true,
			"id":         id,
			"message":    dmMessagePayload(msg),
			"request_id": requestIDFrom(e),
		}, nil
	})
	return writeCommandResult(e, outcome, err)
}

// publishDMSignalToPeers nudges everyone in a conversation except the caller.
//
// Sending a DM publishes a signal per recipient; editing and deleting one did
// not, so a member who corrected or removed their own message left the other
// side showing the old words until some unrelated poll happened to land. Since
// those mutations are as visible as sending — arguably more, because the text
// the reader already has changes underneath them — they ride the same signal
// and re-read through /api/aerun like everything else.
//
// Addressed per member rather than to the conversation, because a conversation
// id is not something a non-member may learn from the stream.
func publishDMSignalToPeers(txApp core.App, conversationID, messageID, excludeUserID string) {
	type memberRow struct {
		UID string `db:"user_id"`
	}
	var members []memberRow
	if err := txApp.DB().NewQuery(`
		SELECT user_id FROM ` + dmMembersCollectionName + `
		WHERE conversation_id = {:conv} AND user_id <> {:self}`).
		Bind(dbx.Params{"conv": conversationID, "self": excludeUserID}).
		All(&members); err != nil {
		// Best-effort, like the audit row: the mutation itself is already
		// stored, and failing the request would report a broken edit that
		// actually succeeded.
		txApp.Logger().Warn("dm peer signal query failed", "error", err, "conversation", conversationID)
		return
	}
	for _, m := range members {
		publishSignal(txApp, realtimeSignalDMPost, messageID, m.UID)
	}
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

	acc := AccessFrom(e)
	// Opening a NEW dialogue is the case the owner reported: an unverified
	// account could start a private conversation with any player and post
	// under a nickname that proves nothing. Pending accounts are exempt here
	// for the same reason as everywhere else (see requireVerified): the
	// "cannot open the first dialogue" rule for pending lives deeper down,
	// inside the transaction, where the race for the first message is
	// resolved.
	if err := requireVerified(acc); err != nil {
		return err
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
		// deliberately does not permit DMs — a spectator, a custom role with the key
		// removed. The stored role row is the authority, so the recipient's own
		// effective permissions decide, narrowed by the same status rules that would
		// authenticate them.
		//
		// A PENDING recipient is NOT one of those accounts (owner ruling
		// 2026-10-20): a pending member receives private messages and answers
		// inside the dialogue somebody opened with them. The status narrowing keeps
		// `use_direct_messages` for pending precisely so that this check passes —
		// see internal/auth/status.go.
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
			if isUserDeleted(u) {
				return 0, nil, forbiddenError("cannot send message to a deleted user")
			}
			recipientAcc := accessForUser(txApp, u)
			if !auth.Has(recipientAcc.Permissions, auth.PermUseDirectMessages) {
				return 0, nil, forbiddenError(
					"this account cannot receive direct messages (role " + string(recipientAcc.Role) + ")")
			}
			recipientUsers[i] = u
		}

		// Race guard for the first message (owner ruling 2026-10-14): the pair
		// may already have a thread because the other member's own first send
		// is running concurrently. Each request, looked at alone, finds "no
		// thread yet" and would INSERT its own — leaving BOTH members with two
		// threads and one message each. So before any write, re-check for the
		// pair's conversation inside THIS transaction (the command mutex
		// serialises it behind the first request, whose writes are committed
		// by the time this read runs). Found → append this message into the
		// existing conversation and return 200 with its id and the caller's
		// own row: one conversation, both messages, in both inboxes.
		//
		// Scoped to the 1:1 case (`len(recipients) == 1`): the pair query is
		// inherently a pair query, and the draft first-send flow is always
		// single-recipient. Group creates keep the creation path as before.
		if len(recipients) == 1 {
			if existingID, qErr := findPairConversationID(txApp, e.Auth.Id, recipients[0]); qErr != nil {
				return 0, nil, internalError("failed to look up conversation", qErr)
			} else if existingID != "" {
				existing, fErr := txApp.FindRecordById(dmConversationsCollectionName, existingID)
				if fErr != nil || existing == nil {
					return 0, nil, notFoundError("conversation not found")
				}
				// The pair query only matches conversations the caller belongs
				// to, so the sender's membership row must exist; a missing one
				// is a contradiction, not a silent pass.
				senderMem, mErr := txApp.FindFirstRecordByFilter(
					dmMembersCollectionName,
					"conversation_id = {:conv} && user_id = {:user}",
					dbx.Params{"conv": existingID, "user": e.Auth.Id},
				)
				if mErr != nil || senderMem == nil {
					return 0, nil, forbiddenError("you are not a participant in this conversation")
				}
				msg, nextSeq, aErr := appendMessageToConversation(
					txApp, existing, senderMem, e.Auth.GetString("nickname"), cleanText, form.Rolls)
				if aErr != nil {
					return 0, nil, aErr
				}
				return http.StatusOK, map[string]any{
					"conversation_id": existing.Id,
					"sequence":        nextSeq,
					"message":         dmMessagePayload(msg),
					"request_id":      requestIDFrom(e),
				}, nil
			}
		}

		// A PENDING sender may not OPEN a conversation (owner ruling
		// 2026-10-20). A pending member receives private messages and answers
		// inside the dialogue somebody else opened with them, but the first word
		// is not theirs to write: a pending account has no way to reach the
		// member it would be writing to.
		//
		// The check is on the SENDER's status, and it is a status rule rather
		// than a permission one — the permission set cannot say "receive but do
		// not initiate" (internal/auth/status.go keeps the key for pending
		// exactly so the RECEIVE half works).
		//
		// It sits AFTER the race guard above on purpose: that branch appends
		// to a conversation which ALREADY exists, which is a reply and not an
		// opening. The race branch returns before this point, so a pending
		// account can answer in a dialogue somebody opened with them, and only
		// the opening is refused.
		// The status comes from the RESOLVED access context, the same source
		// every other status rule reads (requireNotBanned, requireLiveAccount):
		// the raw column is not the answer, the resolved one is.
		if AccessFrom(e).Status == auth.StatusPending {
			return 0, nil, forbiddenError(
				"a pending account cannot start a conversation; it can only answer one that was started for it")
		}

		// 1. Create dm_conversations record.
		//
		// last_message_at is intentionally NOT set here: it is anchored to the
		// seed message's OWN created instant once that row exists (step 3 below),
		// never to a wall-clock sample. A leading last_message_at becomes
		// cleared_at on the next clear and would then survive the
		// `created > cleared_at` filter in listDMMessagesHandler.
		convCol, err := txApp.FindCollectionByNameOrId(dmConversationsCollectionName)
		if err != nil {
			return 0, nil, internalError("dm_conversations collection unavailable", err)
		}

		conv := core.NewRecord(convCol)
		conv.Set("title", cleanTitle)
		conv.Set("last_message", cleanText)
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
		senderMem.Set("cleared_sequence", 0)
		senderMem.Set("deleted", false)
		senderMem.Set("erased_sequence", 0)
		// A new conversation starts at its first message: the member's window
		// opens at the beginning of the stream.
		senderMem.Set("visible_from_sequence", 1)
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
			rMem.Set("cleared_sequence", 0)
			rMem.Set("deleted", false)
			rMem.Set("erased_sequence", 0)
			rMem.Set("visible_from_sequence", 1)
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

		// Anchor the conversation's last_message_at to the seed message's OWN
		// created instant. clearConversationHandler copies this value into the
		// member's cleared_at, and listDMMessagesHandler keeps rows with
		// `created > cleared_at`. If last_message_at were sampled a moment
		// earlier than created (a wall-clock read taken before the row existed),
		// the seed message would survive the clear filter by construction. Using
		// the row's own timestamp makes the boundary exact: the seed is hidden
		// after a clear, and the next reply is strictly greater.
		conv.Set("last_message_at", msg.GetDateTime("created").String())
		if err := txApp.Save(conv); err != nil {
			return 0, nil, internalError("failed to update conversation", err)
		}

		// 4. Outbox email events for recipients.
		//
		// There is deliberately NO in-app notification here. A direct message is
		// signalled only through the DM counter (dm_members.last_read_sequence vs
		// dm_conversations.messages_count) plus the per-recipient dm.post realtime
		// nudge below — exactly like the Firebase era (onDmMessageCreated never
		// wrote to the notifications collection). Writing a "dm" row as well would
		// surface every DM in the notifications feed and inflate unread_notifications.
		senderNick := e.Auth.GetString("nickname")
		for _, rUser := range recipientUsers {
			// The DM list is a SEPARATE resource from the notification list —
			// so without this nudge the conversation preview waits for a poll
			// while the badge updates instantly.
			//
			// Addressed to each recipient individually rather than to the
			// conversation: a conversation id is not something a non-member may
			// learn from the stream.
			publishSignal(txApp, realtimeSignalDMPost, msg.Id, rUser.Id)

			// Email, first-unread only, offline only (Firebase parity).
			maybeEnqueueDMEmail(txApp, conv.Id, rUser, senderNick, cleanText)
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

// findPairConversationID returns the id of the conversation that contains BOTH
// `user` and `peer`, or "" when there is none. It is the same query
// findConversationWithPeerHandler answers over the wire, extracted so the
// read-only endpoint and the create-time race re-check can never diverge on
// what "the conversation with this peer" means.
//
// `app` may be the top-level app (a plain read) or a transaction-bound txApp
// (the create-time re-check), because both expose the same DB(). The ORDER BY
// resolves the ambiguity when more than one shared conversation exists: the
// most recently active one wins, exactly as the endpoint reports it.
func findPairConversationID(app core.App, user, peer string) (string, error) {
	query := `
		SELECT c.id AS id
		FROM ` + dmConversationsCollectionName + ` c
		JOIN ` + dmMembersCollectionName + ` mine
			ON mine.conversation_id = c.id AND mine.user_id = {:user}
		JOIN ` + dmMembersCollectionName + ` theirs
			ON theirs.conversation_id = c.id AND theirs.user_id = {:peer}
		ORDER BY c.last_message_at DESC, c.id DESC
		LIMIT 1
	`
	var rows []struct {
		ID string `db:"id"`
	}
	if err := app.DB().NewQuery(query).
		Bind(dbx.Params{"user": user, "peer": peer}).
		All(&rows); err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	return rows[0].ID, nil
}

// appendMessageToConversation writes ONE message into an EXISTING conversation
// and returns the saved row with its sequence. It is the single implementation
// of "send a message into a thread", shared by sendDMMessageHandler (the
// ordinary reply) and the race fallback in createDMHandler (two members sent
// their first message at nearly the same instant, so the loser appends into the
// winner's conversation instead of opening a duplicate) — one body means the
// two paths cannot drift apart.
//
// It performs, in order: the other-participant checks (removed, banned, and the
// live `use_direct_messages` re-check — a permission revoked after the thread
// opened must still take effect), the monotonic sequence assignment, the
// conversation preview/count update, the sender's own read-watermark advance,
// and delivery (per-recipient `dm.post` signal + first-unread email).
//
// Everything runs inside the caller's transaction: any returned error rolls the
// whole append back, so a failed check never leaves a half-written message.
// `senderMem` is the caller's already-loaded dm_members row (it is also what the
// caller used to assert participation); `senderNick` feeds the email body.
func appendMessageToConversation(
	txApp core.App,
	conv *core.Record,
	senderMem *core.Record,
	senderNick string,
	cleanText string,
	rolls map[string]any,
) (*core.Record, int, error) {
	senderID := senderMem.GetString("user_id")

	// The counterparties: every participant except the sender. Group threads
	// exist, so a single removed/banned/permission-less member is enough to make
	// the whole thread unwritable — hence a per-member check, not just the peer.
	otherMembers, err := txApp.FindRecordsByFilter(
		dmMembersCollectionName,
		"conversation_id = {:conv} && user_id != {:user}",
		"created",
		100,
		0,
		dbx.Params{"conv": conv.Id, "user": senderID},
	)
	if err != nil {
		return nil, 0, internalError("failed to load conversation members", err)
	}
	for _, m := range otherMembers {
		other, oErr := txApp.FindRecordById(usersCollectionName, m.GetString("user_id"))
		if oErr != nil || other == nil {
			// The member's users row is gone (deleted without a cascade, or a
			// ghost that never imported). Refuse the write rather than dropping
			// the reply into a void (D3).
			return nil, 0, forbiddenError("cannot send message to a removed user")
		}
		if other.GetString("status") == string(auth.StatusBanned) {
			return nil, 0, forbiddenError("cannot send message to a banned user")
		}
		if isUserDeleted(other) {
			return nil, 0, forbiddenError("cannot send message to a deleted user")
		}
		if !auth.Has(accessForUser(txApp, other).Permissions, auth.PermUseDirectMessages) {
			return nil, 0, forbiddenError("a participant can no longer receive direct messages")
		}
	}

	// Monotonic sequence assignment within the conversation transaction.
	nextSeq := conv.GetInt("messages_count") + 1

	msgCol, err := txApp.FindCollectionByNameOrId(dmMessagesCollectionName)
	if err != nil {
		return nil, 0, internalError("dm_messages collection unavailable", err)
	}
	msg := core.NewRecord(msgCol)
	msg.Set("conversation_id", conv.Id)
	msg.Set("sender_id", senderID)
	msg.Set("sequence", nextSeq)
	msg.Set("text", cleanText)
	if err := writeRolls(msg, cleanText, rolls); err != nil {
		return nil, 0, validationError(err.Error())
	}
	if err := txApp.Save(msg); err != nil {
		return nil, 0, internalError("failed to save message", err)
	}

	// last_message_at is anchored to the reply's OWN created instant, not a
	// wall-clock sample: it becomes cleared_at on the next clear, and a sample
	// taken before the row existed would let the reply survive its own clear
	// boundary. The row's own timestamp makes the horizon exact (see
	// createDMHandler's seed anchoring for the same reasoning).
	conv.Set("last_message", cleanText)
	conv.Set("last_message_at", msg.GetDateTime("created").String())
	conv.Set("messages_count", nextSeq)
	if err := txApp.Save(conv); err != nil {
		return nil, 0, internalError("failed to update conversation", err)
	}

	// The sender has read their own message.
	senderMem.Set("last_read_sequence", nextSeq)
	if err := txApp.Save(senderMem); err != nil {
		return nil, 0, internalError("failed to update sender read sequence", err)
	}

	// A NEW MESSAGE TO A MEMBER WHO DELETED THE CHAT (owner ruling 2026-10-19).
	//
	// The chat is a personal projection: the recipient had removed it, and
	// their projection of it starts again from THIS message. So their window's
	// lower edge moves to the new message's sequence, and the archive marker
	// is cleared — the chat is in their inbox again, holding only what came
	// after it, with the previous history still behind their horizon.
	//
	// Without this the chat would stay invisible to them forever: their
	// horizon hides the old messages, and the inbox query skips deleted chats,
	// so a conversation they are still a member of would simply never appear
	// again — while the peer keeps writing into it.
	//
	// Only the RECIPIENT's projection moves. The sender keeps their own view of
	// the whole conversation: they were not the one who deleted it.
	for _, m := range otherMembers {
		if !m.GetBool("deleted") {
			continue
		}
		m.Set("deleted", false)
		m.Set("visible_from_sequence", nextSeq)
		if err := txApp.Save(m); err != nil {
			return nil, 0, internalError("failed to restore a deleted conversation for a recipient", err)
		}
	}

	// Delivery to each counterpart. The DM list is a SEPARATE resource from the
	// notification list, so the `dm.post` nudge keeps the badge/inbox fresh
	// without a poll; the email is first-unread only and offline only (Firebase
	// parity). Addressed per recipient, because a conversation id is not
	// something a non-member may learn from the stream.
	for _, m := range otherMembers {
		rID := m.GetString("user_id")
		publishSignal(txApp, realtimeSignalDMPost, msg.Id, rID)
		if u, uErr := txApp.FindRecordById(usersCollectionName, rID); uErr == nil && u != nil {
			maybeEnqueueDMEmail(txApp, conv.Id, u, senderNick, cleanText)
		}
	}

	return msg, nextSeq, nil
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

	acc := AccessFrom(e)
	// Replying inside an already open dialogue. The owner ruled that an
	// unverified member may ANSWER there (only OPENING one is refused), so
	// this handler keeps its own gate: requireVerified lets pending through
	// and refuses only accounts whose email was never confirmed.
	if err := requireVerified(acc); err != nil {
		return err
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

		// The whole append — the removed/banned/permission re-checks, the
		// monotonic sequence, the preview/count update, the sender's read
		// watermark and delivery — lives in appendMessageToConversation, shared
		// with createDMHandler's race fallback so the two send paths cannot
		// diverge on what a send leaves behind.
		msg, nextSeq, appendErr := appendMessageToConversation(
			txApp, conv, member, e.Auth.GetString("nickname"), cleanText, form.Rolls)
		if appendErr != nil {
			return 0, nil, appendErr
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
// convRow is one row of the conversation listing query.
//
// Declared at package scope because the listing and the membership backfill in
// loadConversationParticipants both need it — a function-local type would force
// the backfill to take a structural type just to name this one.
type convRow struct {
	ID               string `db:"id"`
	Title            string `db:"title"`
	LastMessage      string `db:"last_message"`
	LastMessageAt    string `db:"last_message_at"`
	MessagesCount    int    `db:"messages_count"`
	LastReadSequence int    `db:"last_read_sequence"`
	ClearedAt        string `db:"cleared_at"`
	ClearedSequence  int    `db:"cleared_sequence"`
	Deleted          bool   `db:"deleted"`
	ErasedSequence   int    `db:"erased_sequence"`
	// VisibleFromSequence is the member's LOWER visibility edge: the first
	// message they still see. It is 1 for everyone who has not removed the
	// chat, and jumps to the newest message when a chat they removed comes
	// back as a new dialogue.
	VisibleFromSequence int `db:"visible_from_sequence"`
	// UnreadCount is COUNTED in SQL (see the listing query) rather than
	// derived from the two counters, which stopped being equivalent once a
	// member's window could hide rows the conversation counter still held.
	UnreadCount int    `db:"unread_count"`
	Created     string `db:"created"`
	Updated     string `db:"updated"`
}

// conversationPeer is one member of a conversation as the inbox renders them.
//
// Nickname and avatar are read from the users row rather than denormalised onto
// the conversation, so a member who renames or changes their picture shows the
// current one everywhere instead of a stale copy per thread.
type conversationPeer struct {
	UID       string `db:"user_id"`
	Nickname  string `db:"nickname"`
	AvatarURL string `db:"avatar_url"`
}

// loadConversationParticipants resolves the membership of the listed
// conversations in one query.
//
// The caller is excluded in Go rather than SQL because "everybody except me" is
// not expressible as a readable join against a bound parameter — and membership
// rows are few, so filtering after the read costs nothing.
func loadConversationParticipants(e *core.RequestEvent, rows []convRow) (map[string][]conversationPeer, error) {
	out := map[string][]conversationPeer{}
	if len(rows) == 0 {
		return out, nil
	}

	type memberRow struct {
		ConversationID string `db:"conversation_id"`
		UID            string `db:"user_id"`
		Nickname       string `db:"nickname"`
		AvatarURL      string `db:"avatar_url"`
	}
	var members []memberRow
	// The membership of every conversation the caller is in, keyed back to the
	// conversation. A subquery rather than a generated IN list: ids stay bound
	// parameters, so nothing is concatenated into SQL, and it cannot outrun the
	// page — the outer read still decides which ids the response contains.
	//
	// Slightly wider than this page of rows on purpose; ids outside the page are
	// simply never looked up below.
	memberSQL := `
		SELECT dm.conversation_id AS conversation_id,
		       dm.user_id AS user_id,
		       COALESCE(u.nickname, '') AS nickname,
		       COALESCE(u.avatar_url, '') AS avatar_url
		FROM ` + dmMembersCollectionName + ` dm
		LEFT JOIN ` + usersCollectionName + ` u ON u.id = dm.user_id
		WHERE dm.conversation_id IN (
			SELECT conversation_id FROM ` + dmMembersCollectionName + ` WHERE user_id = {:user}
		)`
	if err := e.App.DB().NewQuery(memberSQL).
		Bind(dbx.Params{"user": e.Auth.Id}).
		All(&members); err != nil {
		return nil, internalError("failed to load conversation members", err)
	}

	for _, m := range members {
		if m.UID == e.Auth.Id {
			continue
		}
		out[m.ConversationID] = append(out[m.ConversationID], conversationPeer{
			UID:       m.UID,
			Nickname:  m.Nickname,
			AvatarURL: m.AvatarURL,
		})
	}
	return out, nil
}

// participantUIDs, participantNames and participantAvatars shape the peers for
// the three shapes the client reads: a list to navigate with, and two maps to
// look a name or a picture up by id.
func participantUIDs(peers []conversationPeer) []string {
	uids := make([]string, 0, len(peers))
	for _, p := range peers {
		uids = append(uids, p.UID)
	}
	return uids
}

func participantNames(peers []conversationPeer) map[string]string {
	names := make(map[string]string, len(peers))
	for _, p := range peers {
		names[p.UID] = p.Nickname
	}
	return names
}

func participantAvatars(peers []conversationPeer) map[string]string {
	avatars := make(map[string]string, len(peers))
	for _, p := range peers {
		avatars[p.UID] = p.AvatarURL
	}
	return avatars
}

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
			m.cleared_sequence AS cleared_sequence,
			m.deleted AS deleted,
			m.erased_sequence AS erased_sequence,
			m.visible_from_sequence AS visible_from_sequence,
			-- The unread count is COUNTED, not derived (owner ruling 2026-10-19).
			-- The difference of two counters was only correct while every
			-- message was still a row: a removed chat holds messages the member
			-- can no longer see but the conversation counter still counted them,
			-- and a chat that came back as a new dialogue counted the history
			-- behind its lower edge. Counting the rows the member can actually
			-- see answers both: an archived chat is 0, and a revived one is 1.
			--
			-- The horizon is part of the count for the same reason it is part
			-- of the read filter: a message the member CANNOT see is not
			-- unread, it is gone for them. The badge and this column are
			-- therefore the same number, computed by the same rule
			-- (see getUnreadCountsHandler).
			(
				SELECT COUNT(*) FROM dm_messages msg
				WHERE msg.conversation_id = c.id
				  AND msg.sequence > m.last_read_sequence
				  AND msg.sequence >= m.visible_from_sequence
				  AND msg.sequence > MAX(m.cleared_sequence, m.erased_sequence)
			) AS unread_count,
			c.created AS created,
			c.updated AS updated
		FROM dm_members m
		JOIN dm_conversations c ON c.id = m.conversation_id
		WHERE m.user_id = {:user}
	`
	params := dbx.Params{"user": e.Auth.Id}

	// ONE LIST, ONE FOLDER (owner ruling 2026-10-19).
	//
	// The "Deleted" folder is gone from the interface: a chat the member
	// removed is not somewhere they browse, it is simply out of their inbox
	// until the peer writes again — at which point it RETURNS to the inbox as
	// a new dialogue (see appendMessageToConversation), holding only what
	// came after the removal.
	//
	// So the list is the inbox, and a chat is in it when the member has not
	// removed it. The marker is per-member because it lives in `dm_members`:
	// two participants can hold the SAME conversation differently at the same
	// time, and that is exactly the state the owner's rule describes ("if the
	// users deleted the chats at different moments...").
	//
	// A chat that was merely CLEARED (read up to N) stays in the inbox: the
	// member has not removed it, they have caught up with it. That is the
	// difference between "mark as read" and "delete".
	query += " AND m.deleted = false"

	if cursor != "" {
		parts := strings.Split(cursor, "|")
		if len(parts) == 2 {
			query += " AND ((c.last_message_at < {:cursor_time}) OR (c.last_message_at = {:cursor_time} AND c.id < {:cursor_id}))"
			params["cursor_time"] = parts[0]
			params["cursor_id"] = parts[1]
		}
	}

	query += fmt.Sprintf(" ORDER BY c.last_message_at DESC, c.id DESC LIMIT %d", limit+1)

	rows := []convRow{}
	if err := e.App.DB().NewQuery(query).Bind(params).All(&rows); err != nil {
		return internalError("failed to query conversations", err)
	}

	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}

	// The inbox needs to know WHO each conversation is with.
	//
	// It had no way to find out: the payload carries ids, titles and counts, and
	// no participant list at all. The UI reached for `conv.participants` and
	// `conv.participantNames`, so every row rendered as a nameless "User" and
	// clicking one threw on `undefined.find`. That code was written against a
	// payload this endpoint never produced — it was unreachable only because no
	// conversation had ever been listed.
	//
	// Batched in ONE query for the same reason loadVisibleTopics is: a
	// per-conversation read would make drawing the inbox N+1 requests, which is
	// how this screen was a single request once already.
	participantsByConv, err := loadConversationParticipants(e, rows)
	if err != nil {
		return err
	}

	items := make([]map[string]any, len(rows))
	for i, r := range rows {
		peers := participantsByConv[r.ID]
		items[i] = map[string]any{
			"id":                 r.ID,
			"title":              r.Title,
			"last_message":       r.LastMessage,
			"last_message_at":    r.LastMessageAt,
			"messages_count":     r.MessagesCount,
			"last_read_sequence": r.LastReadSequence,
			"unread_count":       r.UnreadCount,
			"created":            r.Created,
			"updated":            r.Updated,
			// A private conversation is addressed by the other participants, so
			// this is what a row in the inbox is FOR — not a decoration.
			"participants":       participantUIDs(peers),
			"participantNames":   participantNames(peers),
			"participantAvatars": participantAvatars(peers),
			// True when the caller is the ONLY resolvable member: the peer's
			// dm_members row is either gone entirely (a migration ghost that
			// never imported) so the LEFT JOIN yields no row, or every other
			// membership is the caller. The inbox must not navigate into such a
			// thread — there is nobody to read or write to — it offers deletion
			// instead (bug M2). An orphaned row from a runtime delete still
			// yields one peer with an empty nickname, so peers is non-empty and
			// this stays false: that thread keeps its real history readable and
			// shows the gone member as a placeholder.
			"peer_missing": len(peers) == 0,
			// Keyed by member rather than a bare number: the inbox reads it as
			// conv.unread[myUid]. This listing only ever describes the caller, so
			// their entry is the only one there is to give.
			"unread": map[string]int{e.Auth.Id: r.UnreadCount},
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

// findConversationWithPeerHandler serves GET /api/aerun/conversations/peer/{peerId}.
//
// The browser used to answer "do I already have a thread with this person?" by
// reading `dm_members` itself. That collection is server-only — every rule is
// nil — so the read was refused every time, and the client quietly fell through
// to creating a second conversation for someone it had already written to.
//
// Resolving it here also keeps the answer correct past the first page: the
// inbox listing is paginated, so once a member has more threads than one page
// holds, a client-side scan of that list simply stops finding older
// correspondents and starts duplicating them again.
//
// 404 means "no thread yet", which is the caller's cue to create one — not an
// error, so it is answered with an empty result rather than a failure shape.
func findConversationWithPeerHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	peerID := strings.TrimSpace(e.Request.PathValue("peerId"))
	if peerID == "" {
		return validationError("peer identifier is required")
	}
	if peerID == e.Auth.Id {
		return validationError("a conversation with yourself is not a conversation")
	}

	pairID, err := findPairConversationID(e.App, e.Auth.Id, peerID)
	if err != nil {
		return internalError("failed to look up conversation", err)
	}

	resp := map[string]any{
		"conversation_id": pairID,
		"request_id":      requestIDFrom(e),
	}
	return e.JSON(http.StatusOK, resp)
}

// listDMMessagesHandler lists ordered messages in a conversation.
func listDMMessagesHandler(e *core.RequestEvent) error {
	if e.Auth == nil {
		return forbiddenError("authentication required")
	}

	convID := e.Request.PathValue("id")
	limit := messaging.ClampLimit(parseIntParam(e.Request.URL.Query().Get("limit"), messaging.DefaultPageLimit), messaging.DefaultPageLimit)
	afterSeq := parseIntParam(e.Request.URL.Query().Get("after_sequence"), 0)
	beforeSeq := parseIntParam(e.Request.URL.Query().Get("before_sequence"), 0)

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

	// The horizon is an ORDINAL, not a timestamp.
	//
	// It used to be `created > cleared_at`, a strict comparison of two
	// millisecond-resolution timestamps. Two messages written inside the same
	// millisecond carry the same value, so a reply that followed the clear in
	// that millisecond compared EQUAL and vanished from the thread until some
	// later message moved the clock — a race that failed roughly one run in
	// thirty (TestClearedConversationShowsTheNextMessageImmediately).
	//
	// `sequence` is monotonic within the conversation and has no resolution
	// limit, so "hidden up to and including N" is exact.
	//
	// BOTH horizons apply. `cleared_sequence` is the read/unread boundary
	// (what the member has consumed); `erased_sequence` is the point past
	// which the member has ERASED the chat for themselves — they will never
	// read those messages again, and that is what the hard-delete rule counts.
	//
	// A member who erased reads nothing of the chat, and a member who merely
	// cleared it reads everything after their read horizon.
	hiddenUpTo := member.GetInt("cleared_sequence")
	if erased := member.GetInt("erased_sequence"); erased > hiddenUpTo {
		hiddenUpTo = erased
	}
	// EACH FILTER OWNS ITS OWN PARAMETER NAME.
	//
	// dbx binds the named parameters of a whole query into ONE map, keyed by
	// the name inside the placeholder. Two expressions that use the same name
	// do NOT mean "the same value": the last one written wins, and every
	// placeholder of that name then resolves to it. Four filters sharing
	// `{:seq}` therefore collapsed into one — and because the window's lower
	// edge is written last, it silently REPLACED the horizon: a member who
	// had erased a conversation went on reading the very messages they had
	// erased, and a chat revived as a new dialogue came back empty.
	//
	// The names below are deliberately distinct. Merging them back is the
	// defect this comment exists to prevent.
	if hiddenUpTo > 0 {
		query = query.AndWhere(dbx.NewExp("sequence > {:horizonSeq}", dbx.Params{"horizonSeq": hiddenUpTo}))
	}

	// The LOWER EDGE of this member's window (owner ruling 2026-10-19).
	//
	// The horizon above is the upper edge — what the member has consumed or
	// erased. This is the lower one — the first message they still see, and
	// it is what makes "a new message in an archived chat arrives as a NEW
	// dialogue" work: the previous history stays behind the edge, so the
	// chat reappears in the inbox holding only what came after it.
	//
	// It is a separate column rather than a reuse of the horizon because the
	// two edges move for different reasons and in different directions: the
	// horizon only ever moves forward as the member reads or erases, while
	// this edge jumps FORWARD on a new message to a member who had deleted
	// the chat. Deriving one from the other would make an archived chat's
	// history reappear the moment a new message arrives.
	if visibleFrom := member.GetInt("visible_from_sequence"); visibleFrom > 0 {
		query = query.AndWhere(dbx.NewExp("sequence >= {:visibleFromSeq}", dbx.Params{"visibleFromSeq": visibleFrom}))
	}

	if afterSeq > 0 {
		query = query.AndWhere(dbx.NewExp("sequence > {:afterSeq}", dbx.Params{"afterSeq": afterSeq}))
	}
	// Walking backwards through the thread. Without this there was no way to ask
	// for anything older than what the caller already holds, so "load older
	// messages" had no server-side meaning at all.
	if beforeSeq > 0 {
		query = query.AndWhere(dbx.NewExp("sequence < {:beforeSeq}", dbx.Params{"beforeSeq": beforeSeq}))
	}

	// Newest-first for the LIMIT to mean what the caller wants, then reversed
	// back to chronological on the way out.
	//
	// The page a member opens is the END of a conversation. Ordering ASC and
	// keeping the first `limit` returned sequences 1..N, so opening a thread
	// showed its very first messages instead of the latest, the unread count
	// disagreed with what was on screen, and the history button had nothing left
	// to load — the displayed messages were already the oldest that exist.
	query = query.OrderBy("sequence DESC").Limit(int64(limit + 1))

	records := []*core.Record{}
	if err := query.All(&records); err != nil {
		return internalError("failed to query messages", err)
	}

	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}

	// The wire order is newest-first; a thread reads oldest-first.
	for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
		records[i], records[j] = records[j], records[i]
	}

	items := make([]map[string]any, len(records))
	oldestSequence := 0
	for i, r := range records {
		items[i] = dmMessagePayload(r)
		if i == 0 {
			oldestSequence = r.GetInt("sequence")
		}
	}

	return e.JSON(http.StatusOK, map[string]any{
		"items": items,
		// `has_more` means "older messages exist", which is what the thread's
		// history button asks about.
		"has_more": hasMore,
		// Sequence to pass back as before_sequence for the next older page.
		"oldest_sequence": oldestSequence,
		"request_id":      requestIDFrom(e),
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
	// Reading a chat moves the READ watermark ONLY. It must not move the
	// VISIBILITY horizon (`cleared_sequence`): that horizon is what hides
	// messages from the member, and it belongs to the two actions that mean
	// "take this away from me" — `clear` (the legacy "delete the dialog",
	// which is what `clearedAt` meant in the Firebase era) and `erase`.
	//
	// Moving it here made reading a chat HIDE that chat: the thread the
	// member had just read came back empty on the next poll, because the
	// read filter hides everything at or below the horizon. The client marks
	// a conversation read the moment a new message arrives, so the history
	// would have vanished under the reader's cursor.
	//
	// `erased_sequence` is not touched either: an erased chat stays erased
	// for them whatever they read afterwards.
	if err := e.App.Save(member); err != nil {
		return internalError("failed to update read sequence", err)
	}

	// Wake the reader's own counters. The unread-counts poll has no timer
	// while the reader's realtime stream is connected (shared-poll stops it),
	// and nothing else publishes on a read — so without this nudge the
	// navbar/tab badge keeps the last POLLED value after the thread already
	// marked everything read. Addressed to the READER, not the peers: their
	// counters are untouched by somebody else catching up, and a conversation
	// id is not something a non-member may learn from the stream.
	//
	// A dedicated dm.read topic, not dm.post: both carry a conversation id,
	// so reusing the post topic would wake the thread as if a message had
	// arrived. Every DM resource re-reads on any signal anyway, so the extra
	// thread/inbox re-reads are harmless convergence — and topic-stats is the
	// one resource that filters DM topics out (forum.js).
	publishSignal(e.App, realtimeSignalDMRead, convID, e.Auth.Id)

	// Reset the first-unread email dedupe: the conversation is fully read, so
	// the NEXT unread message wave is a new "first unread" and must queue its own
	// email (Firebase parity: email notification per unread wave).
	dedupeKey := messaging.MakeDMUnreadDedupeKey(convID, e.Auth.Id)
	// 1. A pending row from the wave just read was not sent yet; delete it rather
	// than send an email about messages the user already read.
	if pending, err := e.App.FindFirstRecordByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:key} && status = 'pending'",
		dbx.Params{"key": dedupeKey},
	); err == nil && pending != nil {
		_ = e.App.Delete(pending)
	}
	// 2. An already sent event with this dedupe_key would block future waves due
	// to the UNIQUE index on dedupe_key. Retire its dedupe_key so audit history
	// is preserved while freeing the dedupe key for the next wave.
	if sent, err := e.App.FindFirstRecordByFilter(
		outboxEventsCollectionName,
		"dedupe_key = {:key} && status != 'pending'",
		dbx.Params{"key": dedupeKey},
	); err == nil && sent != nil {
		sent.Set("dedupe_key", fmt.Sprintf("%s:read:%d", dedupeKey, time.Now().UnixNano()))
		_ = e.App.Save(sent)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"conversation_id":    convID,
		"last_read_sequence": maxSeq,
		"request_id":         requestIDFrom(e),
	})
}

// clearConversationHandler hides from the caller everything they have already
// seen — it is the "mark as read" of a conversation.
//
// THE HORIZON IS AN ORDINAL, NOT A TIMESTAMP.
//
// It used to be `cleared_at` — the `created` instant of the last message the
// member had seen — and the message list filtered on it with a STRICT
// comparison, `created > cleared_at`. `created` is millisecond-resolution, so
// two messages written inside the same millisecond carry the same value; the
// reply that followed the clear in that millisecond compared EQUAL and
// vanished from the thread until some later message moved the clock. The
// test pinning that contract failed roughly one run in thirty, on the parent
// commit as much as on this one.
//
// `sequence` is monotonic within the conversation and has no resolution limit,
// so "hidden up to and including N" is exact — the race disappears rather
// than becoming rarer.
//
// A chat cleared this way STAYS IN THE INBOX: a new message grows the
// conversation past the horizon, and the chat comes back. Moving a chat out
// of the inbox for good is a different action (deleteConversationHandler).
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

	// The horizon is the highest sequence the conversation holds: everything
	// up to and including it is now hidden from the caller.
	conv, err := e.App.FindRecordById(dmConversationsCollectionName, convID)
	if err != nil || conv == nil {
		return notFoundError("conversation not found")
	}
	horizon := conv.GetInt("messages_count")

	member.Set("cleared_sequence", horizon)
	// `cleared_at` is kept in step for the legacy import path and for the
	// down-migration of the schema change; the runtime reads the ordinals.
	member.Set("cleared_at", types.NowDateTime().String())
	if err := e.App.Save(member); err != nil {
		return internalError("failed to clear conversation", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"cleared":          true,
		"cleared_sequence": horizon,
		"request_id":       requestIDFrom(e),
	})
}

// eraseConversationHandler erases the conversation FOR THE CALLER (owner's
// ruling, 2026-10-19).
//
// IT IS ALWAYS SUCCESSFUL, AND IT DELETES NOTHING FROM THE DATABASE.
//
// The owner ruled this on 2026-10-19, and the reason is the difference
// between a MESSAGE STREAM and a record: the chat is a personal projection of
// a stream of events, and a participant's own decision to stop reading it is
// expressed in their own projection — not by removing rows everybody shares.
//
// So this handler writes exactly one thing: the caller's ERASE POINT, the
// sequence past which they will never read this conversation again. That is
// the marker the Min-Watermark collector later reads to decide what may
// physically disappear (see dm_collector.go).
//
// It does NOT ask whether the peer can still read the conversation, and it
// does NOT delete a single row. An earlier version of this handler did both,
// and refused with 409 while a living peer had not erased yet — which made
// the step impossible to take: nobody could be first, because being first is
// exactly what the 409 forbade.
//
// The physical removal happens in the collector, once every participant has
// erased past the same point (or their account is gone).
func eraseConversationHandler(e *core.RequestEvent) error {
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

	claim, err := claimFrom(e)
	if err != nil {
		return err
	}

	outcome, err := runCommand(e.App, claim, func(txApp core.App) (int, any, error) {
		conv, err := txApp.FindRecordById(dmConversationsCollectionName, convID)
		if err != nil || conv == nil {
			return 0, nil, notFoundError("conversation not found")
		}
		total := conv.GetInt("messages_count")

		// The caller's own erase, and the ONLY thing this handler writes.
		//
		// It is recorded as a SEQUENCE, not a flag, because "erased up to N"
		// is what the rule needs: a member who erases a chat holding five
		// messages has discarded exactly those five, and a message that
		// arrives in the same chat afterwards is not covered by it.
		//
		// The read horizon moves to the same point, so the messages stop being
		// shown to them in the thread — which is what "can no longer read
		// them" means in the UI.
		//
		// The archive marker goes with it: the chat leaves the member's inbox
		// and comes back only when the peer writes again — and then it returns
		// as a NEW dialogue (see appendMessageToConversation).
		horizon := total
		if erased := member.GetInt("erased_sequence"); erased > horizon {
			horizon = erased
		}
		member.Set("erased_sequence", horizon)
		member.Set("cleared_sequence", horizon)
		member.Set("deleted", true)
		if err := txApp.Save(member); err != nil {
			return 0, nil, internalError("failed to erase conversation", err)
		}

		return http.StatusOK, map[string]any{
			"erased": true,
			// The caller's own erase point — the point past which THEY will
			// never read this conversation.
			"erased_up_to": horizon,
			// The conversation itself is untouched: it stays readable for the
			// peer until the peer erases it too (or their account is deleted),
			// and the collector removes the rows afterwards.
			"request_id": requestIDFrom(e),
		}, nil
	})

	return writeCommandResult(e, outcome, err)
}
