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
  getDocs,
  getDoc,
  Timestamp
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

export const fetchLatestTopics = async (limitCount = 50) => {
  try {
    const functions = getFunctions();
    const getGlobalTopics = httpsCallable(functions, 'getSecuredGlobalTopics');
    const result = await getGlobalTopics({ orderByField: 'last_post_at', limitCount });
    return result.data.topics || [];
  } catch (err) {
    console.error('[fetchLatestTopics]', err);
    return [];
  }
};

import { subscribeToLatestTopicsRtdb } from './categories';

export const subscribeToLatestTopics = (callback, limitCount = 50) => {
  let hasReceivedRtdb = false;
  
  // 1. Subscribe to RTDB real-time stream
  const unsubRtdb = subscribeToLatestTopicsRtdb((topics) => {
    if (topics && topics.length > 0) {
      hasReceivedRtdb = true;
      callback(topics.slice(0, limitCount));
    }
  }, limitCount);

  // 2. Initial fallback fetch via Callable function if RTDB is still empty
  fetchLatestTopics(limitCount).then(topics => {
    if (!hasReceivedRtdb && topics && topics.length > 0) {
      callback(topics);
    }
  });

  return () => {
    if (typeof unsubRtdb === 'function') unsubRtdb();
  };
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

const userProfileCache = new Map(); // uid -> { data, ts }
const USER_PROFILE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Пользователи онлайн (ОДНОКРАТНЫЙ запрос вместо onSnapshot)
export const subscribeToActiveUsers = (callback) => {
  let isSubscribed = true;

  const fetchActive = async () => {
    try {
      const FIFTEEN_MINS_MS = 15 * 60 * 1000;
      const thresholdTimestamp = Timestamp.fromMillis(Date.now() - FIFTEEN_MINS_MS);

      const presenceQ = query(
        collection(db, 'user_presence'),
        where('last_seen', '>=', thresholdTimestamp)
      );
      const presenceSnap = await getDocs(presenceQ);

      if (!isSubscribed) return;

      const activeUids = presenceSnap.docs.map(d => d.id);
      if (activeUids.length === 0) {
        callback([]);
        return;
      }

      const usersList = [];
      const now = Date.now();

      await Promise.all(
        activeUids.map(async (uid) => {
          try {
            const cached = userProfileCache.get(uid);
            if (cached && (now - cached.ts < USER_PROFILE_CACHE_TTL)) {
              if (cached.data.role_id !== 'banned') {
                usersList.push(cached.data);
              }
              return;
            }

            const userSnap = await getDoc(doc(db, 'users', uid));
            if (userSnap.exists()) {
              const uData = { id: userSnap.id, ...userSnap.data() };
              userProfileCache.set(uid, { data: uData, ts: now });
              if (uData.role_id !== 'banned') {
                usersList.push(uData);
              }
            }
          } catch (e) {
            console.warn('[fetchActiveUser doc error]', e);
          }
        })
      );

      usersList.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      if (isSubscribed) callback(usersList);
    } catch (err) {
      console.error('[subscribeToActiveUsers error]', err);
    }
  };

  const timer = setTimeout(fetchActive, 200);
  return () => { 
    isSubscribed = false; 
    clearTimeout(timer);
  };
};

/**
 * Real-time listener for active user UIDs from user_presence (last 15 mins).
 * Returns a Set of active UIDs with zero extra fetches for profile data.
 */
export const subscribeToActiveUserIds = (callback) => {
  const FIFTEEN_MINS_MS = 15 * 60 * 1000;
  const thresholdTimestamp = Timestamp.fromMillis(Date.now() - FIFTEEN_MINS_MS);

  const presenceQ = query(
    collection(db, 'user_presence'),
    where('last_seen', '>=', thresholdTimestamp)
  );

  return onSnapshot(presenceQ, (presenceSnap) => {
    const activeUids = new Set(presenceSnap.docs.map(d => d.id));
    callback(activeUids);
  }, (err) => console.error('[subscribeToActiveUserIds error]', err));
};

// Разовый запрос активных за последние 24 часа пользователей
export const fetchDailyActiveUsers = async () => {
  try {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const thresholdTimestamp = Timestamp.fromMillis(Date.now() - ONE_DAY_MS);

    // Запрашиваем коллекцию users напрямую по дате последнего логина
    const q = query(
      collection(db, 'users'),
      where('last_seen', '>=', thresholdTimestamp)
    );
    const snap = await getDocs(q);

    const usersList = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => u.role_id !== 'banned' && u.role_id !== 'pending');

    usersList.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
    return usersList;
  } catch (err) {
    console.error('[fetchDailyActiveUsers error]', err);
    return [];
  }
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
