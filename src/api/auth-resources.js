import { db } from '../../firebase';
import {
  doc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  query,
  orderBy,
  where,
  limit,
  deleteDoc
} from 'firebase/firestore';

// ── Read Map (server-side "last visit" tracking) ─────────────────────────────

export const recordTopicVisit = async (uid, topicId, offset = null) => {
  if (!uid || !topicId) return;
  const ref = doc(db, 'users', uid, 'readmap', 'topics');
  
  // If offset is provided, store as object; otherwise store as flat timestamp for compatibility
  const value = offset !== null 
    ? { timestamp: serverTimestamp(), offset } 
    : serverTimestamp();
    
  await setDoc(ref, { [topicId]: value }, { merge: true });
};

export const subscribeToReadMap = (uid, callback) => {
  if (!uid) { callback({}); return () => {}; }
  const ref = doc(db, 'users', uid, 'readmap', 'topics');
  return onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    callback(snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : {});
  }, err => {
    if (err.code !== 'permission-denied') {
      console.error('ReadMap unsub error:', err);
    }
  });
};

export const markAllTopicsRead = async (uid, topicIds) => {
  if (!uid || !topicIds?.length) return;
  const ref = doc(db, 'users', uid, 'readmap', 'topics');
  const update = {};
  topicIds.forEach(id => {
    update[id] = serverTimestamp();
  });
  await setDoc(ref, update, { merge: true });
};

// ── Latest Content ─────────────────────────────────────────────────────────

export const subscribeToLatestTopics = (callback, limitCount = 50) => {
  const q = query(
    collection(db, 'topics'),
    orderBy('last_post_at', 'desc'),
    limit(limitCount)
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};

// ── Guest Activity ──────────────────────────────────────────────────────────

export const recordGuestActivity = async (guestId) => {
  if (!guestId) return;
  const ref = doc(db, 'guest_activity', guestId);
  await setDoc(ref, {
    last_seen: serverTimestamp()
  });
};

export const deleteGuestActivity = async (guestId) => {
  if (!guestId) return;
  await deleteDoc(doc(db, 'guest_activity', guestId));
};

// ── Statistics & Global Content ─────────────────────────────────────────────

export const subscribeToTopTopics = (callback, limitCount = 50) => {
  const q = query(
    collection(db, 'topics'),
    orderBy('posts_count', 'desc'),
    limit(limitCount)
  );
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[subscribeToTopTopics]', err));
};

export const subscribeToUser = (uid, callback) => {
  return onSnapshot(doc(db, 'users', uid), (snapshot) => {
    callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
  });
};

export const subscribeToActiveUsers = (callback) => {
  const FIFTEEN_MINS_MS = 15 * 60 * 1000;
  const q = query(
    collection(db, 'users'), 
    where('last_seen', '>=', new Date(Date.now() - FIFTEEN_MINS_MS))
  );
  
  return onSnapshot(q, (snapshot) => {
    const users = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => u.status !== 'banned');
    users.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
    callback(users);
  }, (err) => console.error('[subscribeToActiveUsers]', err));
};

export const subscribeToDailyActiveUsers = (callback) => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const q = query(
    collection(db, 'users'),
    where('last_seen', '>=', new Date(Date.now() - ONE_DAY_MS))
  );
  return onSnapshot(q, (snapshot) => {
    const users = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => u.role_id !== 'banned' && u.role_id !== 'pending');
    users.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
    callback(users);
  }, (err) => console.error('[subscribeToDailyActiveUsers]', err));
};

export const subscribeToActiveGuests = (callback) => {
  const FIFTEEN_MINS_MS = 15 * 60 * 1000;
  const q = query(
    collection(db, 'guest_activity'),
    where('last_seen', '>=', new Date(Date.now() - FIFTEEN_MINS_MS))
  );

  return onSnapshot(q, (snapshot) => {
    callback(snapshot.size);
  }, (err) => console.error('[subscribeToActiveGuests]', err));
};

export const subscribeToAllUsers = (callback) => {
  const q = query(collection(db, 'users'), orderBy('nickname', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};
