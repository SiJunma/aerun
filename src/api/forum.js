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
  getDocs,
  limit,
  getDoc
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
  const topicRef = doc(collection(db, 'topics'));
  
  await runTransaction(db, async (transaction) => {
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
      last_post_is_character: topicData.is_character || false,
      last_post_author_character_id: topicData.author_character_id || null,
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
      last_post_author_id: topicData.author_id,
      last_post_topic_id: topicRef.id,
      last_post_topic_title: topicData.title,
      last_post_is_character: topicData.is_character || false,
      last_post_author_character_id: topicData.author_character_id || null
    });

    // Increment the author's post_count
    transaction.update(userRef, { post_count: increment(1) });
  });

  return topicRef.id;
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
  const postRef = doc(collection(db, 'posts'));
  
  await runTransaction(db, async (transaction) => {
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
      last_post_is_character: postData.is_character || false,
      last_post_author_character_id: postData.author_character_id || null,
      posts_count: increment(1)
    });

    if (categoryId) {
      transaction.update(doc(db, 'categories', categoryId), {
        posts_count: increment(1),
        last_post_at: serverTimestamp(),
        last_post_author: postData.author_name,
        last_post_author_id: postData.author_id,
        last_post_topic_id: postData.topic_id,
        last_post_topic_title: topicSnap.data().title,
        last_post_is_character: postData.is_character || false,
        last_post_author_character_id: postData.author_character_id || null
      });
    }

    // Increment the author's post_count
    transaction.update(userRef, { post_count: increment(1) });
  });

  return postRef.id;
};

// Edit a post
export const updatePost = async (postId, content, metadata = {}) => {
  await updateDoc(doc(db, 'posts', postId), {
    content,
    ...metadata,
    edited_at: serverTimestamp()
  });
};

// Update topic fields (title, description, etc.)
export const updateTopic = async (topicId, data) => {
  const topicRef = doc(db, 'topics', topicId);
  await updateDoc(topicRef, {
    ...data,
    updated_at: serverTimestamp()
  });

  // If title was updated, check if it needs to be synced to the category denormalized field
  if (data.title) {
    try {
      const topicSnap = await getDoc(topicRef);
      if (topicSnap.exists()) {
        const topicData = topicSnap.data();
        const categoryId = topicData.category_id;
        if (categoryId) {
          const categoryRef = doc(db, 'categories', categoryId);
          const categorySnap = await getDoc(categoryRef);
          if (categorySnap.exists() && categorySnap.data().last_post_topic_id === topicId) {
            await updateDoc(categoryRef, {
              last_post_topic_title: data.title
            });
          }
        }
      }
    } catch (err) {
      console.error('[updateTopic sync]', err);
    }
  }
};

// Delete a post — if it's the last post, deletes the topic too;
// otherwise recalculates last_post_* fields on the topic and category.
export const deletePost = async (post) => {
  const postRef = doc(db, 'posts', post.id);
  const topicRef = doc(db, 'topics', post.topic_id);
  const userRef = doc(db, 'users', post.author_id);

  // Step 1: transactionally delete the post and update counters
  let topicData = null;
  let categoryId = null;
  let isLastPost = false;

  await runTransaction(db, async (transaction) => {
    const topicSnap = await transaction.get(topicRef);
    if (!topicSnap.exists()) {
      transaction.delete(postRef);
      return;
    }

    topicData = topicSnap.data();
    categoryId = topicData.category_id;
    isLastPost = (topicData.posts_count ?? 1) <= 1;

    transaction.delete(postRef);
    transaction.update(userRef, { post_count: increment(-1) });

    if (isLastPost) {
      transaction.delete(topicRef);
      if (categoryId) {
        transaction.update(doc(db, 'categories', categoryId), {
          topics_count: increment(-1),
          posts_count: increment(-1)
        });
      }
    } else {
      transaction.update(topicRef, { posts_count: increment(-1) });
      if (categoryId) {
        transaction.update(doc(db, 'categories', categoryId), {
          posts_count: increment(-1)
        });
      }
    }
  });

  // Step 2: if topic still exists, recalculate last_post_* from remaining posts
  if (!isLastPost && topicData && categoryId) {
    // Find new last post in the topic
    const remainingQ = query(
      collection(db, 'posts'),
      where('topic_id', '==', post.topic_id),
      orderBy('created_at', 'desc'),
      limit(1)
    );
    const remainingSnap = await getDocs(remainingQ);

    if (!remainingSnap.empty) {
      const newLastPost = remainingSnap.docs[0].data();
      const newLastAt = newLastPost.created_at;
      const newLastAuthor = newLastPost.author_name;
      const newLastAuthorId = newLastPost.author_id;
      const newIsChar = newLastPost.is_character || false;
      const newCharId = newLastPost.author_character_id || null;

      // Update topic's denormalized last_post fields
      await updateDoc(topicRef, {
        last_post_at: newLastAt,
        last_post_author: newLastAuthor,
        last_post_author_id: newLastAuthorId,
        last_post_is_character: newIsChar,
        last_post_author_character_id: newCharId
      });

      // Find the most-recent topic in the category to update category's last_post fields
      const catTopicsQ = query(
        collection(db, 'topics'),
        where('category_id', '==', categoryId),
        orderBy('last_post_at', 'desc'),
        limit(1)
      );
      const catTopicsSnap = await getDocs(catTopicsQ);

      if (!catTopicsSnap.empty) {
        const latestTopic = { id: catTopicsSnap.docs[0].id, ...catTopicsSnap.docs[0].data() };
        await updateDoc(doc(db, 'categories', categoryId), {
          last_post_at: latestTopic.last_post_at,
          last_post_author: latestTopic.last_post_author,
          last_post_author_id: latestTopic.last_post_author_id,
          last_post_topic_id: latestTopic.id,
          last_post_topic_title: latestTopic.title,
          last_post_is_character: latestTopic.last_post_is_character || false,
          last_post_author_character_id: latestTopic.last_post_author_character_id || null
        });
      }
    }
  } else if (isLastPost && categoryId) {
    // Topic was deleted — recalculate category's last_post from remaining topics
    const catTopicsQ = query(
      collection(db, 'topics'),
      where('category_id', '==', categoryId),
      orderBy('last_post_at', 'desc'),
      limit(1)
    );
    const catTopicsSnap = await getDocs(catTopicsQ);

    if (!catTopicsSnap.empty) {
      const latestTopic = { id: catTopicsSnap.docs[0].id, ...catTopicsSnap.docs[0].data() };
      await updateDoc(doc(db, 'categories', categoryId), {
        last_post_at: latestTopic.last_post_at,
        last_post_author: latestTopic.last_post_author,
        last_post_author_id: latestTopic.last_post_author_id,
        last_post_topic_id: latestTopic.id,
        last_post_topic_title: latestTopic.title,
        last_post_is_character: latestTopic.last_post_is_character || false,
        last_post_author_character_id: latestTopic.last_post_author_character_id || null
      });
    } else {
      // No topics left in category
      await updateDoc(doc(db, 'categories', categoryId), {
        last_post_at: null,
        last_post_author: null,
        last_post_author_id: null,
        last_post_topic_id: null,
        last_post_topic_title: null,
        last_post_is_character: null,
        last_post_author_character_id: null
      });
    }
  }
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
