import { sendApi, pb } from './pocketbase';
import { processDiceRolls } from '../utils/dice';
import { sharedPoll } from './shared-poll';

/**
 * Returns a deterministic conversation ID for two users.
 */
export const getConversationId = (uid1, uid2) =>
  [uid1, uid2].sort().join('_');

/**
 * Get or create the conversation document between two users.
 */
export const getOrCreateConversation = async (myUid, theirUid, myProfile, theirProfile) => {
  if (!myUid || !theirUid) return null;

  try {
    const myMemberships = await pb.collection('dm_members').getFullList({
      filter: `user_id = "${myUid}"`
    });
    for (const m of myMemberships) {
      const other = await pb.collection('dm_members').getFirstListItem(
        `conversation_id = "${m.conversation_id}" && user_id = "${theirUid}"`
      ).catch(() => null);
      if (other) {
        return m.conversation_id;
      }
    }
  } catch (err) {
    console.warn('[getOrCreateConversation lookup]', err);
  }

  // If not found, create via domain API
  const title = theirProfile?.nickname || 'Direct Message';
  const res = await sendApi('/api/aerun/dms', {
    method: 'POST',
    body: {
      recipient_ids: [theirUid],
      title,
      text: 'Conversation started'
    }
  });

  return res?.conversation?.id || res?.id || res?.conversation_id;
};

// ── DM list ──────────────────────────────────────────────────────────────────
//
// ONE list read for the whole app. The Navbar badge and the messages page both
// wanted it, each with its own 10s interval and its own realtime channel, so an
// open DM page issued the same `GET /api/aerun/dms` twice on two clocks.
//
// Keyed by account: the cached list must never be handed to a different member
// after a sign-out, and a stale account's loop must not survive the switch.
export const subscribeToDmList = (uid, callback, errorCallback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }
  const poll = sharedPoll(`dm-list:${uid}`, {
    fetch: async () => {
      const res = await sendApi('/api/aerun/dms');
      return (res?.items || []).map(conv => ({
        id: conv.id,
        ...conv,
        lastTimestamp: conv.last_message_at,
        lastMessage: conv.last_message
      }));
    },
    intervalMs: 10000,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToDmList err]', err),
  });

  // The error travels WITH the last good list rather than replacing it, so a
  // failed refresh leaves the conversation list on screen.
  return poll.subscribe((items, err) => {
    if (err && errorCallback) errorCallback(err);
    callback(items);
  });
};

// ── Unread counters ──────────────────────────────────────────────────────────
//
// ONE counters read, and it now carries the topic badge too.
//
// `unread_topics` used to be computed in the browser from a `topics?limit=50`
// list that the main-page projection carried for exactly this purpose: fifty whole
// topic records to render one integer, capped so that a member with 60 unread was
// told 50, and derived from a localStorage read map so the desktop and the phone
// disagreed about the same account. The server already counts notifications and
// DMs here, so the topic count belongs here too — the badge costs no request it
// was not already making, and it is the only number of the three that can no
// longer be capped by a page size.
//
// The shared resource name is unchanged, and it is scoped by account: the counters
// are caller-scoped, so AuthProvider (dmUnread) and TitleProvider (tab title) are
// reading the SAME resource and the second subscriber costs nothing.
export const subscribeToUnreadCounts = (uid, callback) => {
  if (!uid) {
    callback({ total: 0, conversations: {}, topics: 0, notifications: 0 });
    return () => {};
  }
  const poll = sharedPoll(`dm-unread:${uid}`, {
    fetch: async () => {
      const res = await sendApi('/api/aerun/me/unread-counts');
      return {
        total: res?.total_unread_messages || res?.unread_conversations || 0,
        conversations: {},
        // A missing key reads as 0 rather than NaN: an older backend that predates
        // the field should show no badge, not break the navbar's arithmetic.
        topics: Number(res?.unread_topics) || 0,
        // The UNREAD NOTIFICATION COUNT, which this response already carried and
        // this mapping used to drop on the floor.
        //
        // Both badges that show it — the navbar bell and the tab title — used to
        // answer it by fetching `GET /me/notifications?limit=100` and counting
        // `!n.read` in the browser, on every page of the forum. That is a row list
        // carried for a number, the same defect `latestTopics` was on the
        // main-page projection, and it was capped while it was at it: a member with
        // 150 unread notifications was told 100, because the badge could only see
        // the newest hundred rows. The server counts every unread, unread-not-
        // archived row, so the badge reads the count and the LIST is fetched only
        // where rows are actually rendered.
        notifications: Number(res?.unread_notifications) || 0
      };
    },
    intervalMs: 15000,
    initialValue: { total: 0, conversations: {}, topics: 0, notifications: 0 },
  });

  // No realtime channel here: the counters are derived state that changes only
  // as a side effect of a message, and that message already wakes the DM list
  // poll and the notification poll in this same tab. See
  // markdowns/REALTIME_HYBRID_PLAN.md — this resource is a candidate for the
  // realtime rollout, but it must not be a special case in the meantime.
  return poll.subscribe((counts) => callback(counts));
};

// subscribeToDmUnread keeps its name at the call sites that only read DMs.
export const subscribeToDmUnread = subscribeToUnreadCounts;

/**
 * Fetches older messages in a conversation for pagination.
 */
export const fetchOlderDmMessages = async (conversationId, oldestTimestamp, batchSize = 15) => {
  if (!conversationId) return [];
  try {
    const res = await sendApi(`/api/aerun/dms/${conversationId}/messages?limit=${batchSize}`);
    return (res?.items || []).map(m => ({
      id: m.id,
      ...m,
      sender_uid: m.sender_id,
      timestamp: m.created
    }));
  } catch (err) {
    console.error('[fetchOlderDmMessages err]', err);
    return [];
  }
};

/**
 * Subscribe to messages in a conversation.
 *
 * The 5-second poll is deliberate here and unique: this is the one view a member
 * is watching while somebody else types, and there is no server push scoped to a
 * conversation id this client can trust. It is also the ONLY resource that still
 * polls this fast, and it stops while the tab is hidden.
 */
export const subscribeToDmMessages = (conversationId, limitCount, callback, errorCallback) => {
  if (!conversationId) {
    callback([]);
    return () => {};
  }

  // Keyed per conversation so opening a second thread does not inherit the first
  // one's messages, and so a closed thread releases its own loop.
  const poll = sharedPoll(`dm-messages:${conversationId}:${limitCount}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/dms/${conversationId}/messages?limit=${limitCount}`);
      return (res?.items || []).map(m => ({
        id: m.id,
        ...m,
        sender_uid: m.sender_id,
        timestamp: m.created
      }));
    },
    intervalMs: 5000,
    initialValue: [],
    onError: (err) => console.error('[subscribeToDmMessages err]', err),
  });

  return poll.subscribe((items, err) => {
    if (err && errorCallback) errorCallback(err);
    callback(items);
  });
};

/**
 * Send a message in a conversation.
 */
// `senderUid` / `recipientUid` are no longer read: the backend derives both
// from the auth token and refuses to let a client post as somebody else.
export const sendDmMessage = async (conversationId, _senderUid, text, _recipientUid, idempotencyKey) => {
  if (!conversationId || !text) return;
  // Sent alongside the text for the same reason as on the forum: without the
  // map the `[roll=<id>]` tag in the body is an unresolved pointer, and a DM
  // rendered the raw tag on both sides of the conversation.
  const { content: processedContent, rolls } = processDiceRolls(text);

  return await sendApi(`/api/aerun/dms/${conversationId}/messages`, {
    method: 'POST',
    // A stable key per logical send. sendApi otherwise mints a fresh random one
    // per call, so a double-click that escapes the in-flight latch is two posts.
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: {
      text: processedContent.trim(),
      ...(rolls && Object.keys(rolls).length > 0 ? { rolls } : {})
    }
  });
};

/**
 * Edit a message you sent.
 *
 * Sender-only on the server: the recipient cannot rewrite what somebody else
 * wrote, and staff authority over the forum does not extend into private mail.
 * A tombstone answers 409 — there is no text left to correct, and accepting an
 * edit would quietly resurrect a message the sender took back.
 */
export const editDmMessage = async (messageId, text) => {
  if (!messageId || !text) return null;
  const { content: processedContent } = processDiceRolls(text);
  return await sendApi(`/api/aerun/dm-messages/${messageId}`, {
    method: 'PATCH',
    body: { text: processedContent.trim() }
  });
};

/**
 * Delete a message you sent, leaving a TOMBSTONE.
 *
 * The row survives and keeps its place in the thread, so the other participant
 * still sees that something was said and removed — the opposite of the forum,
 * where a deleted post is simply gone. `messages_count` does not move.
 */
export const deleteDmMessage = async (messageId) => {
  if (!messageId) return null;
  return await sendApi(`/api/aerun/dm-messages/${messageId}`, {
    method: 'DELETE'
  });
};

/**
 * Reset unread count for current user in conversation.
 */
export const markDmRead = async (conversationId, _uid) => {
  if (!conversationId) return;
  try {
    await sendApi(`/api/aerun/dms/${conversationId}/read`, {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[markDmRead err]', err);
  }
};

/**
 * Deletes / clears the conversation history for current user.
 */
export const deleteConversation = async (conversationId, _uid) => {
  if (!conversationId) return;
  try {
    await sendApi(`/api/aerun/dms/${conversationId}/clear`, {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[deleteConversation err]', err);
  }
};
