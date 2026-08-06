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
      // Берем запас в 20 минут вместо 15, чтобы исключить рассинхрон часов
      const TWENTY_MINS_MS = 20 * 60 * 1000;
      const thresholdTimestamp = Timestamp.fromMillis(Date.now() - TWENTY_MINS_MS);

      // 1. Получаем список документов из user_presence
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

      // 2. Разово запрашиваем профиль каждого пользователя
      const usersList = [];
      await Promise.all(
        activeUids.map(async (uid) => {
          try {
            const userSnap = await getDoc(doc(db, 'users', uid));
            if (userSnap.exists()) {
              const uData = userSnap.data();
              if (uData.role_id !== 'banned') {
                usersList.push({ id: userSnap.id, ...uData });
              }
            }
          } catch (e) {
            console.warn('[fetchActiveUser doc error]', e);
          }
        })
      );

      usersList.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      
      if (isSubscribed) {
        callback(usersList);
      }
    } catch (err) {
      console.error('[subscribeToActiveUsers error]', err);
    }
  };

  // Небольшой таймаут 200мс гарантирует, что pushLastSeen при старте страницы успеет отправиться в сеть
  const timer = setTimeout(fetchActive, 200);
  
  return () => { 
    isSubscribed = false; 
    clearTimeout(timer);
  };
};
// Активные за 24 часа (ОДНОКРАТНЫЙ запрос)
// Активные за 24 часа (ОДНОКРАТНЫЙ запрос)
export const subscribeToDailyActiveUsers = (callback) => {
  let isSubscribed = true;

  const fetchDaily = async () => {
    try {
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const thresholdTimestamp = Timestamp.fromMillis(Date.now() - ONE_DAY_MS);

      // 1. Берем активность за последние 24 часа из user_presence
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

      // 2. Разово вытягиваем их профили
      const usersList = [];
      await Promise.all(
        activeUids.map(async (uid) => {
          try {
            const userSnap = await getDoc(doc(db, 'users', uid));
            if (userSnap.exists()) {
              const uData = userSnap.data();
              if (uData.role_id !== 'banned' && uData.role_id !== 'pending') {
                usersList.push({ id: userSnap.id, ...uData });
              }
            }
          } catch (e) {
            console.warn('[fetchDailyActiveUser doc error]', e);
          }
        })
      );

      usersList.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      
      if (isSubscribed) {
        callback(usersList);
      }
    } catch (err) {
      console.error('[subscribeToDailyActiveUsers error]', err);
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
