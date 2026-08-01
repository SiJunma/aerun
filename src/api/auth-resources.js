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

export const subscribeToLatestTopics = (categoryIds, callback, limitCount = 50) => {
  if (!categoryIds || categoryIds.length === 0) {
    callback([]);
    return () => {};
  }

  const chunks = [];
  for (let i = 0; i < categoryIds.length; i += 30) {
    chunks.push(categoryIds.slice(i, i + 30));
  }

  const unsubs = [];
  const resultsMap = new Map();
  let initializedChunks = 0;

  chunks.forEach((chunk, index) => {
    const q = query(
      collection(db, 'topics'),
      where('category_id', 'in', chunk),
      orderBy('last_post_at', 'desc'),
      limit(limitCount)
    );
    
    const unsub = onSnapshot(q, (snapshot) => {
      resultsMap.set(index, snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
      
      let allTopics = [];
      resultsMap.forEach(topics => {
        allTopics = allTopics.concat(topics);
      });
      
      allTopics.sort((a, b) => {
        const tA = a.last_post_at?.toMillis?.() || Date.parse(a.last_post_at) || 0;
        const tB = b.last_post_at?.toMillis?.() || Date.parse(b.last_post_at) || 0;
        return tB - tA;
      });
      
      callback(allTopics.slice(0, limitCount));
    }, (err) => console.error(`[subscribeToLatestTopics] Error in chunk ${index}:`, err));
    
    unsubs.push(unsub);
  });

  return () => {
    unsubs.forEach(unsub => unsub());
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
  // Subscribe to a wider window (60 mins) and let the component filter for the active window (15 mins)
  // This allows the "Online Now" list to update as people time out without a page refresh.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const q = query(
    collection(db, 'users'), 
    where('last_seen', '>=', new Date(Date.now() - ONE_HOUR_MS))
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
  // Same as users: subscribe to 60 mins and filter on client
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const q = query(
    collection(db, 'guest_activity'),
    where('last_seen', '>=', new Date(Date.now() - ONE_HOUR_MS))
  );

  return onSnapshot(q, (snapshot) => {
    const guests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    callback(guests);
  }, (err) => console.error('[subscribeToActiveGuests]', err));
};

export const subscribeToAllUsers = (callback) => {
  const q = query(collection(db, 'users'), orderBy('nickname', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};
