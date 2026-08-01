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
  deleteDoc,
  getDocs
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

// Оптимизированный ReadMap (без includeMetadataChanges)
export const subscribeToReadMap = (uid, callback) => {
  if (!uid) { callback({}); return () => { }; }
  const ref = doc(db, 'users', uid, 'readmap', 'topics');
  return onSnapshot(ref, snap => {
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

import { getFunctions, httpsCallable } from 'firebase/functions';

export const subscribeToLatestTopics = (callback, limitCount = 50) => {
  let isSubscribed = true;
  const fetchTopics = async () => {
    try {
      const functions = getFunctions();
      const getGlobalTopics = httpsCallable(functions, 'getSecuredGlobalTopics');
      const result = await getGlobalTopics({ orderByField: 'last_post_at', limitCount });
      if (isSubscribed) callback(result.data.topics || []);
    } catch (err) {
      console.error('[subscribeToLatestTopics]', err);
      if (isSubscribed) callback([]);
    }
  };
  fetchTopics();
  return () => { isSubscribed = false; };
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
  let isSubscribed = true;
  const fetchTopics = async () => {
    try {
      const functions = getFunctions();
      const getGlobalTopics = httpsCallable(functions, 'getSecuredGlobalTopics');
      const result = await getGlobalTopics({ orderByField: 'posts_count', limitCount });
      if (isSubscribed) callback(result.data.topics || []);
    } catch (err) {
      console.error('[subscribeToTopTopics]', err);
      if (isSubscribed) callback([]);
    }
  };
  fetchTopics();
  return () => { isSubscribed = false; };
};

export const subscribeToUser = (uid, callback) => {
  return onSnapshot(doc(db, 'users', uid), (snapshot) => {
    callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
  });
};

// Пользователи онлайн (ОДНОКРАТНЫЙ запрос вместо onSnapshot)
export const subscribeToActiveUsers = (callback) => {
  let isSubscribed = true;
  const fetchActive = async () => {
    try {
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const q = query(
        collection(db, 'users'),
        where('last_seen', '>=', new Date(Date.now() - ONE_HOUR_MS))
      );
      const snapshot = await getDocs(q);
      if (!isSubscribed) return;

      const users = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.status !== 'banned');
      users.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      callback(users);
    } catch (err) {
      console.error('[subscribeToActiveUsers]', err);
    }
  };

  fetchActive();
  return () => { isSubscribed = false; };
};

// Активные за 24 часа (ОДНОКРАТНЫЙ запрос)
export const subscribeToDailyActiveUsers = (callback) => {
  let isSubscribed = true;
  const fetchDaily = async () => {
    try {
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const q = query(
        collection(db, 'users'),
        where('last_seen', '>=', new Date(Date.now() - ONE_DAY_MS))
      );
      const snapshot = await getDocs(q);
      if (!isSubscribed) return;

      const users = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.role_id !== 'banned' && u.role_id !== 'pending');
      users.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      callback(users);
    } catch (err) {
      console.error('[subscribeToDailyActiveUsers]', err);
    }
  };

  fetchDaily();
  return () => { isSubscribed = false; };
};

// Гости (ОДНОКРАТНЫЙ запрос)
export const subscribeToActiveGuests = (callback) => {
  let isSubscribed = true;
  const fetchGuests = async () => {
    try {
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const q = query(
        collection(db, 'guest_activity'),
        where('last_seen', '>=', new Date(Date.now() - ONE_HOUR_MS))
      );
      const snapshot = await getDocs(q);
      if (!isSubscribed) return;

      const guests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(guests);
    } catch (err) {
      console.error('[subscribeToActiveGuests]', err);
    }
  };

  fetchGuests();
  return () => { isSubscribed = false; };
};

// Все пользователи (Разовый запрос)
export const subscribeToAllUsers = (callback) => {
  let isSubscribed = true;
  const fetchAll = async () => {
    try {
      const q = query(collection(db, 'users'), orderBy('nickname', 'asc'));
      const snapshot = await getDocs(q);
      if (!isSubscribed) return;
      callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error('[subscribeToAllUsers]', err);
    }
  };

  fetchAll();
  return () => { isSubscribed = false; };
};
