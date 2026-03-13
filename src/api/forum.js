import { db } from '../../firebase';
import {
  collection,
  addDoc,
  setDoc,
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
import { getTopicSubscribers } from './subscriptions';
import { 
  createNotification, 
  getUnreadTopicNotification, 
  updateNotificationPayload,
  handleTopicDeletionNotifications,
  handlePostDeletionNotifications
} from './notifications';

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
        // First sort by pin status
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;

        // Then by last activity desc
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

  // ── Trigger Notifications (Background) ──
  (async () => {
    try {
      const subscribers = await getTopicSubscribers(postData.topic_id);
      const filteredSubscribers = subscribers.filter(uid => uid !== postData.author_id);
      
      if (filteredSubscribers.length === 0) return;

      const topicSnap = await getDoc(doc(db, 'topics', postData.topic_id));
      const topicTitle = topicSnap.exists() ? topicSnap.data().title : 'Unknown Topic';

      for (const recipientUid of filteredSubscribers) {
        // Check for existing unread notification for this topic
        const existing = await getUnreadTopicNotification(recipientUid, postData.topic_id);
        
        if (existing) {
          // Merge: increment post_count, update created_at to bring to top
          await updateNotificationPayload(existing.id, {
            ...existing.payload,
            post_count: (existing.payload?.post_count || 1) + 1,
            last_post_id: postRef.id
          }, true); // true = update created_at
        } else {
          // Create new
          await createNotification('topic_reply', {
            topic_id: postData.topic_id,
            topic_title: topicTitle,
            first_post_id: postRef.id,
            last_post_id: postRef.id,
            post_count: 1
          }, recipientUid);
        }
      }
    } catch (err) {
      console.error('[createPost notifications error]', err);
    }
  })();

  return postRef.id;
};

// ── Drafts ────────────────────────────────────────────────────────────────────

// Create a draft post — does NOT touch counters or send notifications
// Drafts are now stored in a per-user subcollection to avoid permission errors in the main posts collection
export const createDraftPost = async (postData) => {
  const draftRef = doc(db, 'users', postData.author_id, 'drafts', postData.topic_id);
  await setDoc(draftRef, {
    ...postData,
    is_draft: true,
    reputation: 0,
    created_at: serverTimestamp()
  });
  return postData.topic_id; // Using topicId as docId since there is only 1 draft per topic per user
};

export const subscribeToTopicDraft = (topicId, uid, callback) => {
  if (!uid) return () => {};
  const draftRef = doc(db, 'users', uid, 'drafts', topicId);
  return onSnapshot(draftRef, (snapshot) => {
    callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
  });
};


// Save/update draft content — does NOT set edited_at (draft has no edit history)
export const updateDraftPost = async (uid, topicId, content, metadata = {}) => {
  const { edited_at: _ignored, ...cleanMeta } = metadata;
  const draftRef = doc(db, 'users', uid, 'drafts', topicId);
  await updateDoc(draftRef, {
    content,
    ...cleanMeta
    // intentionally no edited_at
  });
};

export const deleteDraftPost = async (uid, topicId) => {
  const draftRef = doc(db, 'users', uid, 'drafts', topicId);
  await deleteDoc(draftRef);
};

// Publish a draft: create real post, update counters + notifications, then delete draft
export const publishDraft = async (uid, topicId) => {
  const draftRef = doc(db, 'users', uid, 'drafts', topicId);
  const topicRef = doc(db, 'topics', topicId);
  const postRef = doc(collection(db, 'posts'));

  // Read draft data first
  const draftSnap = await getDoc(draftRef);
  if (!draftSnap.exists()) throw new Error('Draft not found');
  const postData = draftSnap.data();

  let categoryId = null;
  let topicTitle = '';

  await runTransaction(db, async (transaction) => {
    const topicSnap = await transaction.get(topicRef);
    if (!topicSnap.exists()) throw new Error('Topic not found');

    const topic = topicSnap.data();
    categoryId = topic.category_id;
    topicTitle = topic.title;

    const userRef = doc(db, 'users', postData.author_id);

    // 1. Create the real post from draft data
    transaction.set(postRef, {
      ...postData,
      is_draft: false,
      edited_at: null,
      created_at: serverTimestamp()
    });

    // 2. Delete the draft
    transaction.delete(draftRef);

    // 3. Update topic counters and last_post_* fields
    transaction.update(topicRef, {
      last_post_at: serverTimestamp(),
      last_post_author: postData.author_name,
      last_post_author_id: postData.author_id,
      last_post_is_character: postData.is_character || false,
      last_post_author_character_id: postData.author_character_id || null,
      posts_count: increment(1)
    });

    // 4. Update category counters and last_post_* fields
    if (categoryId) {
      transaction.update(doc(db, 'categories', categoryId), {
        posts_count: increment(1),
        last_post_at: serverTimestamp(),
        last_post_author: postData.author_name,
        last_post_author_id: postData.author_id,
        last_post_topic_id: topicId,
        last_post_topic_title: topicTitle,
        last_post_is_character: postData.is_character || false,
        last_post_author_character_id: postData.author_character_id || null
      });
    }

    // 5. Increment author post_count
    transaction.update(userRef, { post_count: increment(1) });
  });

  // ── Trigger Notifications (Background) ──
  (async () => {
    try {
      const subscribers = await getTopicSubscribers(topicId);
      const filteredSubscribers = subscribers.filter(uid => uid !== postData.author_id);

      if (filteredSubscribers.length === 0) return;

      for (const recipientUid of filteredSubscribers) {
        const existing = await getUnreadTopicNotification(recipientUid, topicId);

        if (existing) {
          await updateNotificationPayload(existing.id, {
            ...existing.payload,
            post_count: (existing.payload?.post_count || 1) + 1,
            last_post_id: postRef.id
          }, true);
        } else {
          await createNotification('topic_reply', {
            topic_id: topicId,
            topic_title: topicTitle,
            first_post_id: postRef.id,
            last_post_id: postRef.id,
            post_count: 1
          }, recipientUid);
        }
      }
    } catch (err) {
      console.error('[publishDraft notifications error]', err);
    }
  })();

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

  // If deleting a draft — simply remove the doc, no counters were touched
  if (post.is_draft) {
    await deleteDoc(postRef);
    return;
  }

  // Step 1: Find reputation logs for this post to revert reputation
  const logsQuery = query(collection(db, 'reputation_logs'), where('post_id', '==', post.id));
  const logsSnap = await getDocs(logsQuery);
  let totalRepChange = 0;
  logsSnap.forEach(ld => {
    totalRepChange += (ld.data().value || 0);
  });

  // Step 2: transactionally delete the post and update counters
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
    transaction.update(userRef, { 
      post_count: increment(-1),
      reputation: increment(-totalRepChange)
    });

    // Delete associated reputation logs
    logsSnap.forEach(logDoc => {
      transaction.delete(logDoc.ref);
    });

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

  // ── Handle Notifications (Background) ──
  (async () => {
    try {
      if (isLastPost) {
        await handleTopicDeletionNotifications(post.topic_id);
      } else {
        await handlePostDeletionNotifications(post.topic_id, post.id);
      }
    } catch (err) {
      console.error('[deletePost notification cleanup error]', err);
    }
  })();
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
  const q = query(
    collection(db, 'users'), 
    where('nickname', '==', nickname),
    limit(1)
  );
  const querySnapshot = await getDocs(q);

  // If excluding a uid (e.g. self)
  const matchingDocs = querySnapshot.docs.filter(doc => doc.id !== excludeUid);

  return matchingDocs.length > 0;
};
// Batch update topic fields (is_pinned, is_locked)
export const batchUpdateTopics = async (topicIds, data) => {
  const batch = db.batch ? db.batch() : null; // Firestore batch is better if available, but we can use transactions or simple updates
  // Since we might need to update multiple docs, let's use a simple loop or a transaction if they are few.
  // Actually, standard updateDoc is fine for multiple independent calls, or we can use writeBatch.
  
  const promises = topicIds.map(id => updateDoc(doc(db, 'topics', id), {
    ...data,
    updated_at: serverTimestamp()
  }));
  await Promise.all(promises);
};

// Delete multiple topics and their posts atomically
export const deleteTopics = async (topicIds) => {
  for (const topicId of topicIds) {
    const topicRef = doc(db, 'topics', topicId);
    const topicSnap = await getDoc(topicRef);
    if (!topicSnap.exists()) continue;

    const topicData = topicSnap.data();
    const categoryId = topicData.category_id;
    const postsCount = topicData.posts_count || 0;

    await runTransaction(db, async (transaction) => {
      // 1. Delete all posts in topic
      const postsQ = query(collection(db, 'posts'), where('topic_id', '==', topicId));
      const postsSnap = await getDocs(postsQ);
      postsSnap.forEach(pDoc => transaction.delete(pDoc.ref));

      // 2. Delete topic
      transaction.delete(topicRef);

      // 3. Update Category counters
      if (categoryId) {
        const catRef = doc(db, 'categories', categoryId);
        transaction.update(catRef, {
          topics_count: increment(-1),
          posts_count: increment(-postsCount)
        });
      }
      
      // Note: We don't bother reverting reputation here as it's a "hard delete" of a topic,
      // usually done by admins. If we wanted to be perfectly clean, we'd loop logs too.
    });
    
    // Recalculate Category last_post if needed
    if (categoryId) {
      const catTopicsQ = query(
        collection(db, 'topics'),
        where('category_id', '==', categoryId),
        orderBy('last_post_at', 'desc'),
        limit(1)
      );
      const catTopicsSnap = await getDocs(catTopicsQ);
      const catRef = doc(db, 'categories', categoryId);
      
      if (!catTopicsSnap.empty) {
        const latestTopic = { id: catTopicsSnap.docs[0].id, ...catTopicsSnap.docs[0].data() };
        await updateDoc(catRef, {
          last_post_at: latestTopic.last_post_at || null,
          last_post_author: latestTopic.last_post_author || null,
          last_post_author_id: latestTopic.last_post_author_id || null,
          last_post_topic_id: latestTopic.id || null,
          last_post_topic_title: latestTopic.title || null,
          last_post_is_character: latestTopic.last_post_is_character || false,
          last_post_author_character_id: latestTopic.last_post_author_character_id || null
        });
      } else {
        await updateDoc(catRef, {
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

    // ── Handle Notifications (Background) ──
    (async () => {
      try {
        await handleTopicDeletionNotifications(topicId);
      } catch (err) {
        console.error('[deleteTopics notification cleanup error]', err);
      }
    })();
  }
};

// Move topics to another category
export const moveTopics = async (topicIds, targetCategoryId) => {
  const targetCatRef = doc(db, 'categories', targetCategoryId);
  const targetCatSnap = await getDoc(targetCatRef);
  if (!targetCatSnap.exists()) throw new Error('Target category not found');

  for (const topicId of topicIds) {
    const topicRef = doc(db, 'topics', topicId);
    const topicSnap = await getDoc(topicRef);
    if (!topicSnap.exists()) continue;

    const topicData = topicSnap.data();
    const sourceCategoryId = topicData.category_id;
    const postsCount = topicData.posts_count || 0;

    if (sourceCategoryId === targetCategoryId) continue;

    await runTransaction(db, async (transaction) => {
      // 1. Update Topic's category_id
      transaction.update(topicRef, { 
        category_id: targetCategoryId,
        updated_at: serverTimestamp()
      });

      // 2. Update Source Category counters
      if (sourceCategoryId) {
        transaction.update(doc(db, 'categories', sourceCategoryId), {
          topics_count: increment(-1),
          posts_count: increment(-postsCount)
        });
      }

      // 3. Update Target Category counters
      transaction.update(targetCatRef, {
        topics_count: increment(1),
        posts_count: increment(postsCount)
      });
    });

    // Recalculate last_post for both categories (simplified: just trigger update logic)
    const updateCatLastPost = async (catId) => {
      const q = query(collection(db, 'topics'), where('category_id', '==', catId), orderBy('last_post_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      const ref = doc(db, 'categories', catId);
      if (!snap.empty) {
        const top = snap.docs[0].data();
        await updateDoc(ref, {
          last_post_at: top.last_post_at || null,
          last_post_author: top.last_post_author || null,
          last_post_author_id: top.last_post_author_id || null,
          last_post_topic_id: snap.docs[0].id || null,
          last_post_topic_title: top.title || null,
          last_post_is_character: top.last_post_is_character || false,
          last_post_author_character_id: top.last_post_author_character_id || null
        });
      } else {
        await updateDoc(ref, { 
          last_post_at: null, 
          last_post_author: null, 
          last_post_author_id: null,
          last_post_topic_id: null, 
          last_post_topic_title: null,
          last_post_is_character: null,
          last_post_author_character_id: null
        });
      }
    };

    if (sourceCategoryId) await updateCatLastPost(sourceCategoryId);
    await updateCatLastPost(targetCategoryId);
  }
};
// Most discussed topics across all categories
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
