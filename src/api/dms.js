import { db } from '../../firebase';
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
  limit
} from 'firebase/firestore';

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
  const convId = getConversationId(myUid, theirUid);
  const convRef = doc(db, 'dms', convId);

  await setDoc(convRef, {
    participants: [myUid, theirUid],
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
export const subscribeToDmList = (uid, callback) => {
  const q = query(
    collection(db, 'dms'),
    where('participants', 'array-contains', uid),
    orderBy('lastTimestamp', 'desc'),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[subscribeToDmList]', err));
};

/**
 * Subscribe to messages in a conversation.
 */
export const subscribeToDmMessages = (conversationId, callback) => {
  const q = query(
    collection(db, 'dms', conversationId, 'messages'),
    orderBy('timestamp', 'asc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[subscribeToDmMessages]', err));
};

/**
 * Send a message in a conversation.
 * Uses increment() to avoid a separate read for the unread counter.
 */
export const sendDmMessage = async (conversationId, senderUid, text, recipientUid) => {
  const convRef = doc(db, 'dms', conversationId);
  const msgRef = collection(db, 'dms', conversationId, 'messages');

  await addDoc(msgRef, {
    sender_uid: senderUid,
    text: text.trim(),
    timestamp: serverTimestamp(),
  });

  // Strip BBCode tags for the preview snippet
  const cleanSnippet = text.replace(/\[.*?\]/g, '').trim().substring(0, 100);

  await updateDoc(convRef, {
    lastMessage: cleanSnippet,
    lastTimestamp: serverTimestamp(),
    [`unread.${recipientUid}`]: increment(1),
  });
};

/**
 * Reset unread count for the current user in a conversation.
 */
export const markDmRead = async (conversationId, uid) => {
  const convRef = doc(db, 'dms', conversationId);
  await updateDoc(convRef, {
    [`unread.${uid}`]: 0,
  });
};
