import { sendApi, pb } from './pocketbase';
import { processDiceRolls } from '../utils/dice';

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

/**
 * Subscribe to all conversations for a given user.
 */
export const subscribeToDmList = (uid, callback, errorCallback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/dms');
      if (!isSubscribed) return;
      const items = (res?.items || []).map(conv => ({
        id: conv.id,
        ...conv,
        lastTimestamp: conv.last_message_at,
        lastMessage: conv.last_message
      }));
      callback(items);
    } catch (err) {
      console.warn('[subscribeToDmList err]', err);
      if (errorCallback) errorCallback(err);
    }
  };

  load();
  const interval = setInterval(load, 10000);

  let unsub = () => {};
  try {
    pb.collection('dm_conversations').subscribe('*', () => {
      load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

/**
 * Subscribe to real-time unread DM counts.
 */
export const subscribeToDmUnread = (uid, callback) => {
  if (!uid) {
    callback({ total: 0, conversations: {} });
    return () => {};
  }

  let isSubscribed = true;
  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/me/unread-counts');
      if (!isSubscribed) return;
      callback({
        total: res?.total_unread_messages || res?.unread_conversations || 0,
        conversations: {}
      });
    } catch {
      if (isSubscribed) callback({ total: 0, conversations: {} });
    }
  };

  load();
  const interval = setInterval(load, 15000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

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
 */
export const subscribeToDmMessages = (conversationId, limitCount, callback, errorCallback) => {
  if (!conversationId) {
    callback([]);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/dms/${conversationId}/messages?limit=${limitCount}`);
      if (!isSubscribed) return;
      const items = (res?.items || []).map(m => ({
        id: m.id,
        ...m,
        sender_uid: m.sender_id,
        timestamp: m.created
      }));
      callback(items);
    } catch (err) {
      console.error('[subscribeToDmMessages err]', err);
      if (errorCallback) errorCallback(err);
    }
  };

  load();
  const interval = setInterval(load, 5000);

  let unsub = () => {};
  try {
    pb.collection('dm_messages').subscribe('*', (e) => {
      if (e.record?.conversation_id === conversationId) {
        load();
      }
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
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
