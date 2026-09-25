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
  } catch {}

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
  } catch {}

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

/**
 * Send a message in a conversation.
 */
export const sendDmMessage = async (conversationId, senderUid, text, recipientUid) => {
  if (!conversationId || !text) return;
  const { content: processedContent } = processDiceRolls(text);

  return await sendApi(`/api/aerun/dms/${conversationId}/messages`, {
    method: 'POST',
    body: {
      text: processedContent.trim()
    }
  });
};

/**
 * Reset unread count for current user in conversation.
 */
export const markDmRead = async (conversationId, uid) => {
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
export const deleteConversation = async (conversationId, uid) => {
  if (!conversationId) return;
  try {
    await sendApi(`/api/aerun/dms/${conversationId}/clear`, {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[deleteConversation err]', err);
  }
};
