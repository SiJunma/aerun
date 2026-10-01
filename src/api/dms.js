import { db, rtdb } from '../../firebase';
import {
  collection,
  doc,
  setDoc,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  where,
  serverTimestamp,
  updateDoc,
  increment,
  limit,
  getDocs,
  startAfter,
  Timestamp
} from 'firebase/firestore';
import { ref, onValue, remove, set } from 'firebase/database';
import { processDiceRolls } from '../utils/dice';

/**
 * Returns a deterministic conversation ID for two users.
 * Always the same regardless of who initiates.
 */
export const getConversationId = (uid1, uid2) =>
  [uid1, uid2].sort().join('_');

/**
 * Get or create the conversation document between two users.
 * Uses setDoc with merge:true (upsert) — no pre-read required.
 * Only participant info is merged; lastMessage/unread are set by sendDmMessage.
 */
export const getOrCreateConversation = async (myUid, theirUid, myProfile, theirProfile) => {
  const participants = [myUid, theirUid].sort();
  const convId = participants.join('_');
  const convRef = doc(db, 'dms', convId);

  await setDoc(convRef, {
    participants,
    participantNames: {
      [myUid]: myProfile?.nickname || 'User',
      [theirUid]: theirProfile?.nickname || 'User',
    },
    participantAvatars: {
      [myUid]: myProfile?.avatar_url || '',
      [theirUid]: theirProfile?.avatar_url || '',
    },
  }, { merge: true });

  return convId;
};

/**
 * Subscribe to all conversations for a given user, sorted by lastTimestamp desc.
 * Only conversations with at least one message appear (lastTimestamp set by sendDmMessage).
 */
export const subscribeToDmList = (uid, callback, errorCallback) => {
  const q = query(
    collection(db, 'dms'),
    where('participants', 'array-contains', uid),
    orderBy('lastTimestamp', 'desc'),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.error('[subscribeToDmList]', err);
    if (errorCallback) errorCallback(err);
  });
};

/**
 * Subscribe to real-time unread DM counts and conversation highlights from RTDB (0 Firestore reads).
 */
export const subscribeToDmUnread = (uid, callback) => {
  if (!uid || !rtdb) {
    callback({ total: 0, conversations: {} });
    return () => {};
  }

  try {
    const unreadRef = ref(rtdb, `dm_unread/${uid}`);
    return onValue(unreadRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        callback({ total: 0, conversations: {} });
        return;
      }
      callback({
        total: data.total || 0,
        conversations: data.conversations || {}
      });
    }, (err) => {
      console.warn('[subscribeToDmUnread onValue err]', err);
      callback({ total: 0, conversations: {} });
    });
  } catch (err) {
    console.warn('[subscribeToDmUnread caught]', err);
    callback({ total: 0, conversations: {} });
    return () => {};
  }
};

/**
 * Fetches a batch of older messages in a conversation for pagination (10-15 messages).
 */
export const fetchOlderDmMessages = async (conversationId, oldestTimestamp, batchSize = 15) => {
  if (!conversationId || !oldestTimestamp) return [];
  try {
    let cursor = oldestTimestamp;
    if (!(cursor instanceof Timestamp)) {
      if (cursor && typeof cursor.seconds === 'number') {
        cursor = new Timestamp(cursor.seconds, cursor.nanoseconds || 0);
      } else if (cursor && typeof cursor._seconds === 'number') {
        cursor = new Timestamp(cursor._seconds, cursor._nanoseconds || 0);
      } else if (typeof cursor === 'number') {
        cursor = Timestamp.fromMillis(cursor);
      } else if (typeof cursor === 'string') {
        cursor = Timestamp.fromDate(new Date(cursor));
      } else if (typeof cursor?.toDate === 'function') {
        cursor = Timestamp.fromDate(cursor.toDate());
      }
    }

    const messagesRef = collection(db, 'dms', conversationId, 'messages');
    let q = query(
      messagesRef,
      orderBy('timestamp', 'desc'),
      startAfter(cursor),
      limit(batchSize)
    );

    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
  } catch (err) {
    console.error('[fetchOlderDmMessages err]', err);
    return [];
  }
};

/**
 * Subscribe to messages in a conversation (legacy/active listener with limit).
 */
export const subscribeToDmMessages = (conversationId, limitCount, callback, errorCallback) => {
  const q = query(
    collection(db, 'dms', conversationId, 'messages'),
    orderBy('timestamp', 'desc'),
    limit(limitCount)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse());
  }, (err) => {
    console.error('[subscribeToDmMessages]', err);
    if (errorCallback) errorCallback(err);
  });
};

/**
 * Send a message in a conversation.
 * Uses increment() to avoid a separate read for the unread counter.
 */
export const sendDmMessage = async (conversationId, senderUid, text, recipientUid) => {
  const convRef = doc(db, 'dms', conversationId);
  const msgRef = collection(db, 'dms', conversationId, 'messages');

  const { content: processedContent, rolls } = processDiceRolls(text);

  await addDoc(msgRef, {
    sender_uid: senderUid,
    text: processedContent.trim(),
    rolls,
    timestamp: serverTimestamp(),
  });

  // Strip BBCode tags for the preview snippet, specially handling spoilers
  let cleanSnippet = text;
  cleanSnippet = cleanSnippet.replace(/\[spoiler(?:="([^"]*)")?\][\s\S]*?\[\/spoiler\]/gi, (match, p1) => {
    return p1 ? `__SPOILER_START__${p1}__SPOILER_END__` : '__SPOILER_START__Спойлер__SPOILER_END__';
  });
  cleanSnippet = cleanSnippet.replace(/\[.*?\]/g, '').trim();
  cleanSnippet = cleanSnippet.replace(/__SPOILER_START__(.*?)__SPOILER_END__/g, '[$1]');
  cleanSnippet = cleanSnippet.substring(0, 100);

  await updateDoc(convRef, {
    lastMessage: cleanSnippet,
    lastTimestamp: serverTimestamp(),
    [`unread.${recipientUid}`]: increment(1),
  });
};

/**
 * Reset unread count for the current user in a conversation (in Firestore and RTDB).
 */
export const markDmRead = async (conversationId, uid) => {
  try {
    const convRef = doc(db, 'dms', conversationId);
    await updateDoc(convRef, {
      [`unread.${uid}`]: 0,
    });

    if (rtdb && uid && conversationId) {
      await remove(ref(rtdb, `dm_unread/${uid}/conversations/${conversationId}`));
      // Recalculate total in RTDB
      const convsRef = ref(rtdb, `dm_unread/${uid}/conversations`);
      onValue(convsRef, (snap) => {
        let total = 0;
        snap.forEach(child => {
          total += (child.val()?.unread_count || 0);
        });
        set(ref(rtdb, `dm_unread/${uid}/total`), total).catch(() => {});
      }, { onlyOnce: true });
    }
  } catch (err) {
    console.warn('[markDmRead err]', err);
  }
};

/**
 * Deletes the conversation history for the current user by setting a clearedAt timestamp.
 */
export const deleteConversation = async (conversationId, uid) => {
  const convRef = doc(db, 'dms', conversationId);
  await updateDoc(convRef, {
    [`clearedAt.${uid}`]: serverTimestamp(),
    [`unread.${uid}`]: 0,
  });

  if (rtdb && uid && conversationId) {
    remove(ref(rtdb, `dm_unread/${uid}/conversations/${conversationId}`)).catch(() => {});
  }
};
