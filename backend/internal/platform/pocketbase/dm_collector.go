// dm_collector.go — the Min-Watermark Garbage Collector for direct messages.
//
// WHY A COLLECTOR AND NOT A REQUEST. The owner ruled on 2026-10-19 that a
// direct-message chat is a PERSONAL PROJECTION of a message stream: each
// participant sees their own window over the shared rows, and "I delete this
// for myself" is a statement about that window alone.
//
// A user request therefore never removes a row. It only moves the caller's own
// erase point (`dm_members.erased_sequence`). Physical removal is a separate,
// ASYNCHRONOUS consequence: a message may go only when NO participant can read
// it any more, and that is a property of the whole conversation, not of one
// member's click.
//
// THE WATERMARK. For a conversation, the watermark is the LOWEST erase point
// among its participants:
//
//	watermark = min(erased_sequence of every member)
//
// Everything at or below it is unreadable by everybody — every member erased
// past it — and is what the collector removes. The owner named the deleted
// account explicitly: a participant whose account was deleted can never log in
// and can therefore never read anything, so it must not hold the watermark
// back. That is what `erased_sequence = INT_MAX` on a deleted account means:
// not a number to compare, but "this participant will never read anything".
//
// The watermark is a MINIMUM and not a maximum, because two members who erased
// at DIFFERENT moments hold different points: the one who erased early holds a
// LOW point, so the messages that only the later member released stay in the
// database until the earlier one releases them too.
//
// THE CONVERSATION ROW. A conversation is removed only when the collector has
// removed ALL of its messages AND every participant has marked the chat as
// irreversibly deleted. A conversation that still holds a message someone may
// read is a live conversation, and its row must stay.
package pocketbase

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// dmCollectorJobID identifies the collection job in PocketBase's cron.
const dmCollectorJobID = "__aerunDMCollector__"

// dmCollectorSchedule runs the collector every five minutes.
//
// It is deliberately not faster: the collector is a housekeeping job, not a
// user-visible one. Nothing waits for it — the messages a member erased are
// already invisible to them the moment they erase, because their own window
// moved. The collector only decides when the ROWS leave the database.
const dmCollectorSchedule = "*/5 * * * *"

// dmErasedSequenceUnlimited is the erase point of a participant who can never
// read anything again — an account that was deleted.
//
// It is a value, not a flag, and it is INT_MAX on purpose: the watermark is a
// MINIMUM over the participants, so a participant that holds nothing back must
// be LARGER than every real erase point, not a special case in the
// comparison. The one place it must not be treated as a number is the read
// filter, where a member's own window is compared against it — and there the
// deleted account cannot log in, so nothing reads through it.
const dmErasedSequenceUnlimited = 2147483647 // math.MaxInt32

// registerDMCollectorCron schedules the collection job.
//
// PocketBase starts its scheduler from an OnServe hook registered at priority
// 999, so a job added while our own OnServe handler runs (default priority)
// is always in place before the first tick — the same guarantee
// registerGuestPresenceCron documents. Adding the same job id twice replaces
// it, which keeps this idempotent for the tests that bind OnServe more than
// once.
func registerDMCollectorCron(app core.App) error {
	return app.Cron().Add(dmCollectorJobID, dmCollectorSchedule, func() {
		removed, err := collectDeletedDMMessages(app)
		if err != nil {
			app.Logger().Warn("dm collector failed", "error", err)
			return
		}
		if removed > 0 {
			app.Logger().Info("dm collector removed messages", "messages", removed)
		}
	})
}

// collectDeletedDMMessages removes the messages no participant can read any
// more, and returns how many rows it deleted.
//
// It never deletes a message a participant can still read, and it never
// deletes one while a participant who has not erased yet could still read it.
// The whole computation is done in ONE transaction per conversation: a
// participant's erase point can move while the collector walks the list, and
// deleting a message that someone then releases is a race we cannot afford —
// a message removed while its owner could still read it is lost history.
func collectDeletedDMMessages(app core.App) (int, error) {
	convs, err := app.FindAllRecords(dmConversationsCollectionName, nil)
	if err != nil {
		return 0, err
	}

	removed := 0
	for _, conv := range convs {
		deleted, err := collectOneConversation(app, conv)
		if err != nil {
			// A failed conversation must not stop the others: the collector
			// retries on its next tick, and a single bad row cannot be
			// allowed to freeze the whole table.
			app.Logger().Warn("dm collector skipped a conversation",
				"conversation", conv.Id, "error", err)
			continue
		}
		removed += deleted
	}
	return removed, nil
}

// collectOneConversation applies the watermark to ONE conversation and returns
// how many messages it removed.
func collectOneConversation(app core.App, conv *core.Record) (int, error) {
	convID := conv.Id

	removed := 0
	err := app.RunInTransaction(func(txApp core.App) error {
		members, err := txApp.FindAllRecords(
			dmMembersCollectionName,
			dbx.NewExp("conversation_id = {:conv}", dbx.Params{"conv": convID}),
		)
		if err != nil {
			return err
		}
		if len(members) == 0 {
			// A conversation with no membership rows is a ghost: there is
			// nobody who could ever read it, and nothing to read it with.
			return txApp.Delete(conv)
		}

		// THE WATERMARK: the lowest erase point among the participants.
		//
		// A participant who has not erased holds the line at ZERO, and that
		// is what keeps the conversation alive: they can still read
		// everything, so nothing may go. A participant whose account was
		// deleted holds INT_MAX, so they never hold the line back.
		watermark := dmErasedSequenceUnlimited
		allErased := true
		for _, m := range members {
			point := m.GetInt("erased_sequence")
			if point <= 0 {
				// This participant has not erased the chat: it stays for
				// them, so nothing may go.
				allErased = false
				watermark = 0
				break
			}
			if point < watermark {
				watermark = point
			}
		}
		if watermark <= 0 {
			return nil
		}

		// Everything at or below the watermark is unreadable by every
		// participant — it can go.
		msgs, err := txApp.FindAllRecords(
			dmMessagesCollectionName,
			dbx.NewExp("conversation_id = {:conv} AND sequence <= {:seq}",
				dbx.Params{"conv": convID, "seq": watermark}),
		)
		if err != nil {
			return err
		}
		for _, msg := range msgs {
			if err := txApp.Delete(msg); err != nil {
				return err
			}
			removed++
		}

		// The conversation row goes only when NOTHING is left in it AND every
		// participant has marked the chat as irreversibly deleted. A chat
		// that still holds a message someone may read is a live chat, and
		// its row must stay.
		remaining, err := txApp.FindAllRecords(
			dmMessagesCollectionName,
			dbx.NewExp("conversation_id = {:conv}", dbx.Params{"conv": convID}),
		)
		if err != nil {
			return err
		}
		if len(remaining) > 0 || !allErased {
			// The preview may have pointed at a message that just went, and
			// the inbox would keep showing text that is no longer there.
			return refreshDMConversationPreview(txApp, convID)
		}
		for _, m := range members {
			if err := txApp.Delete(m); err != nil {
				return err
			}
		}
		return txApp.Delete(conv)
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}

// markUserDMErasesForever records that a participant can never read another
// message of their conversations, because their account is gone.
//
// It is called when an account is deleted. The erase point becomes INT_MAX —
// "this participant will never read anything" — so the watermark of every
// conversation they were in is decided by the members who are still around.
//
// It is also what makes the owner's rule true for a deleted account: a
// surviving member who deletes their own side of a chat with a deleted
// account has, by that alone, taken the watermark to their own erase point,
// and the collector removes the rows.
func markUserDMErasesForever(txApp core.App, userID string) error {
	if userID == "" {
		return nil
	}
	members, err := txApp.FindAllRecords(
		dmMembersCollectionName,
		dbx.NewExp("user_id = {:user}", dbx.Params{"user": userID}),
	)
	if err != nil {
		return err
	}
	for _, m := range members {
		m.Set("erased_sequence", dmErasedSequenceUnlimited)
		if err := txApp.Save(m); err != nil {
			return err
		}
	}
	return nil
}

// refreshDMConversationPreview refreshes the conversation's preview after the
// collector removed the messages the preview pointed at.
//
// Without this the inbox would keep showing the text of a message that is
// gone — the most visible way a physical deletion could leak the content it
// was supposed to remove.
func refreshDMConversationPreview(txApp core.App, convID string) error {
	conv, err := txApp.FindRecordById(dmConversationsCollectionName, convID)
	if err != nil || conv == nil {
		return nil
	}
	rows, err := txApp.FindAllRecords(
		dmMessagesCollectionName,
		dbx.NewExp("conversation_id = {:conv}", dbx.Params{"conv": convID}),
	)
	if err != nil {
		return err
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
		conv.Set("last_message_at", lastAt.String())
	}
	return txApp.Save(conv)
}
