import { db } from '../../firebase';
import {
  collection,
  addDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  where,
  serverTimestamp,
  runTransaction,
  updateDoc,
  deleteDoc,
  increment,
  getDocs
} from 'firebase/firestore';

// ── Categories ──────────────────────────────────────────────────────────────

export const subscribeToCategories = (callback) => {
  const q = query(collection(db, 'categories'), orderBy('order', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};

export const addCategory = async (catData) => {
  await addDoc(collection(db, 'categories'), {
    ...catData,
    topics_count: 0,
    posts_count: 0,
    created_at: serverTimestamp()
  });
};

export const updateCategory = async (id, catData) => {
  await updateDoc(doc(db, 'categories', id), {
    ...catData,
    updated_at: serverTimestamp()
  });
};

export const deleteCategory = async (id) => {
  await deleteDoc(doc(db, 'categories', id));
};

// ── Topics ───────────────────────────────────────────────────────────────────

// Topics in a category — sorted client-side to avoid composite index requirement
export const subscribeToTopics = (categoryId, callback) => {
  const q = query(
    collection(db, 'topics'),
    where('category_id', '==', categoryId)
  );
  return onSnapshot(q,
    (snapshot) => {
      const topics = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by last activity desc, fall back to created_at
      topics.sort((a, b) => {
        const aTime = a.last_post_at?.toMillis?.() ?? a.created_at?.toMillis?.() ?? 0;
        const bTime = b.last_post_at?.toMillis?.() ?? b.created_at?.toMillis?.() ?? 0;
        return bTime - aTime;
      });
      callback(topics);
    },
    (err) => console.error('[subscribeToTopics]', err)
  );
};

// Single topic by ID
export const subscribeToTopic = (topicId, callback) => {
  return onSnapshot(doc(db, 'topics', topicId), (snapshot) => {
    callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
  });
};

// Most recent topic in a category — client-side sort to avoid needing a composite index
export const subscribeToLastTopicInCategory = (categoryId, callback) => {
  const q = query(
    collection(db, 'topics'),
    where('category_id', '==', categoryId)
  );
  return onSnapshot(q,
    (snapshot) => {
      if (snapshot.empty) { callback(null); return; }
      const topics = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      topics.sort((a, b) => {
        const aTime = a.last_post_at?.toMillis?.() ?? a.created_at?.toMillis?.() ?? 0;
        const bTime = b.last_post_at?.toMillis?.() ?? b.created_at?.toMillis?.() ?? 0;
        return bTime - aTime;
      });
      callback(topics[0]);
    },
    (err) => console.error('[subscribeToLastTopicInCategory]', err)
  );
};

// Create new topic + first post atomically
export const createTopic = async (topicData, firstPostData) => {
  await runTransaction(db, async (transaction) => {
    const topicRef = doc(collection(db, 'topics'));
    const postRef = doc(collection(db, 'posts'));
    const categoryRef = doc(db, 'categories', topicData.category_id);
    const userRef = doc(db, 'users', topicData.author_id);

    transaction.set(topicRef, {
      ...topicData,
      views: 0,
      reputation: 0,
      last_post_at: serverTimestamp(),
      last_post_author: topicData.author_name,
      last_post_author_id: topicData.author_id,
      created_at: serverTimestamp(),
      posts_count: 1
    });

    transaction.set(postRef, {
      ...firstPostData,
      topic_id: topicRef.id,
      reputation: 0,
      created_at: serverTimestamp()
    });

    transaction.update(categoryRef, {
      topics_count: increment(1),
      posts_count: increment(1),
      last_post_at: serverTimestamp(),
      last_post_author: topicData.author_name,
      last_post_topic_id: topicRef.id,
      last_post_topic_title: topicData.title
    });

    // Increment the author's post_count
    transaction.update(userRef, { post_count: increment(1) });
  });
};

// ── Posts ─────────────────────────────────────────────────────────────────────

export const subscribeToPosts = (topicId, callback) => {
  const q = query(
    collection(db, 'posts'),
    where('topic_id', '==', topicId)
  );
  return onSnapshot(q,
    (snapshot) => {
      const posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by creation time asc (oldest first)
      posts.sort((a, b) => {
        const aTime = a.created_at?.toMillis?.() ?? 0;
        const bTime = b.created_at?.toMillis?.() ?? 0;
        return aTime - bTime;
      });
      callback(posts);
    },
    (err) => console.error('[subscribeToPosts]', err)
  );
};

// Reply to a topic
export const createPost = async (postData) => {
  await runTransaction(db, async (transaction) => {
    const postRef = doc(collection(db, 'posts'));
    const topicRef = doc(db, 'topics', postData.topic_id);
    const userRef = doc(db, 'users', postData.author_id);

    // Need to read topic first to get category_id
    const topicSnap = await transaction.get(topicRef);
    const categoryId = topicSnap.exists() ? topicSnap.data().category_id : null;

    transaction.set(postRef, {
      ...postData,
      reputation: 0,
      created_at: serverTimestamp()
    });

    transaction.update(topicRef, {
      last_post_at: serverTimestamp(),
      last_post_author: postData.author_name,
      last_post_author_id: postData.author_id,
      posts_count: increment(1)
    });

    if (categoryId) {
      transaction.update(doc(db, 'categories', categoryId), {
        posts_count: increment(1),
        last_post_at: serverTimestamp(),
        last_post_author: postData.author_name,
        last_post_topic_id: postData.topic_id,
        last_post_topic_title: topicSnap.data().title
      });
    }

    // Increment the author's post_count
    transaction.update(userRef, { post_count: increment(1) });
  });
};

// Edit a post
export const updatePost = async (postId, content, metadata = {}) => {
  await updateDoc(doc(db, 'posts', postId), {
    content,
    ...metadata,
    edited_at: serverTimestamp()
  });
};

// Delete a post — if it's the last post, deletes the topic too
export const deletePost = async (post) => {
  await runTransaction(db, async (transaction) => {
    const postRef = doc(db, 'posts', post.id);
    const topicRef = doc(db, 'topics', post.topic_id);
    const userRef = doc(db, 'users', post.author_id);

    const topicSnap = await transaction.get(topicRef);
    if (!topicSnap.exists()) {
      // Topic already gone, just delete the post
      transaction.delete(postRef);
      return;
    }

    const topicData = topicSnap.data();
    const categoryId = topicData.category_id;
    const isLastPost = (topicData.posts_count ?? 1) <= 1;

    // Always delete the post itself
    transaction.delete(postRef);

    // Decrement author post_count
    transaction.update(userRef, { post_count: increment(-1) });

    if (isLastPost) {
      // Delete the whole topic too
      transaction.delete(topicRef);

      if (categoryId) {
        transaction.update(doc(db, 'categories', categoryId), {
          topics_count: increment(-1),
          posts_count: increment(-1)
        });
      }
    } else {
      // Just decrement counters
      transaction.update(topicRef, { posts_count: increment(-1) });

      if (categoryId) {
        transaction.update(doc(db, 'categories', categoryId), {
          posts_count: increment(-1)
        });
      }
    }
  });
};
// ── Users ─────────────────────────────────────────────────────────────────────

export const updateUser = async (uid, userData) => {
  await updateDoc(doc(db, 'users', uid), {
    ...userData,
    updated_at: serverTimestamp()
  });
};

export const subscribeToUser = (uid, callback) => {
  return onSnapshot(doc(db, 'users', uid), (snapshot) => {
    callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
  });
};
export const subscribeToAllUsers = (callback) => {
  const q = query(collection(db, 'users'), orderBy('nickname', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};

export const checkNicknameExists = async (nickname, excludeUid = null) => {
  if (!nickname) return false;

  // We need to do a case-insensitive check, but Firestore doesn't support that directly easily
  // For exact match:
  const q = query(collection(db, 'users'), where('nickname', '==', nickname));
  const querySnapshot = await getDocs(q);

  // If excluding a uid (e.g. self)
  const matchingDocs = querySnapshot.docs.filter(doc => doc.id !== excludeUid);

  return matchingDocs.length > 0;
};
