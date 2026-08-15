import { db } from '../../firebase';
import {
  collection,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  getDocs,
  serverTimestamp,
  documentId
} from 'firebase/firestore';

/**
 * topic_subscriptions schema:
 * {
 *   topic_id: string,
 *   user_id: string,
 *   created_at: Timestamp
 * }
 */

export const subscribeToTopicStatus = (topicId, userId, callback) => {
  if (!userId) {
    callback(false);
    return () => {};
  }

  let isSubscribed = true;
  const q = query(
    collection(db, 'topic_subscriptions'),
    where('topic_id', '==', topicId),
    where('user_id', '==', userId)
  );

  getDocs(q)
    .then(snap => { if (isSubscribed) callback(!snap.empty); })
    .catch(err => console.error('[subscribeToTopicStatus]', err));

  // Возвращаем функцию-заглушку (совместимость с useEffect cleanup)
  return () => { isSubscribed = false; };
};

export const toggleSubscription = async (topicId, userId) => {
  if (!userId) return;
  
  const q = query(
    collection(db, 'topic_subscriptions'),
    where('topic_id', '==', topicId),
    where('user_id', '==', userId)
  );
  const snap = await getDocs(q);
  
  if (snap.empty) {
    // Follow
    await addDoc(collection(db, 'topic_subscriptions'), {
      topic_id: topicId,
      user_id: userId,
      created_at: serverTimestamp()
    });
    return true;
  } else {
    // Unfollow
    const promises = snap.docs.map(d => deleteDoc(d.ref));
    await Promise.all(promises);
    return false;
  }
};

export const getTopicSubscribers = async (topicId) => {
  const q = query(collection(db, 'topic_subscriptions'), where('topic_id', '==', topicId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data().user_id);
};

export const fetchUserSubscribedTopics = async (userId) => {
  if (!userId) return [];
  const q = query(
    collection(db, 'topic_subscriptions'),
    where('user_id', '==', userId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return [];

  const topicIds = [...new Set(snap.docs.map(d => d.data().topic_id).filter(Boolean))];
  if (topicIds.length === 0) return [];

  const topicsMap = {};
  for (let i = 0; i < topicIds.length; i += 30) {
    const chunk = topicIds.slice(i, i + 30);
    const tQuery = query(
      collection(db, 'topics'),
      where(documentId(), 'in', chunk)
    );
    const tSnap = await getDocs(tQuery);
    tSnap.forEach(doc => {
      topicsMap[doc.id] = { id: doc.id, ...doc.data() };
    });
  }

  const result = topicIds.map(id => topicsMap[id]).filter(Boolean);
  result.sort((a, b) => {
    const aTime = a.last_post_at?.toMillis?.() || 0;
    const bTime = b.last_post_at?.toMillis?.() || 0;
    return bTime - aTime;
  });

  return result;
};
