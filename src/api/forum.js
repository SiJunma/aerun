import { db } from '../../firebase';
import { logAdminAction } from './audit';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  collection,
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
  getDoc,
  writeBatch,
  getCountFromServer
} from 'firebase/firestore';

import { processDiceRolls } from '../utils/dice';


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
        const aTime = a.last_post_at?.toMillis?.() ?? 0;
        const bTime = b.last_post_at?.toMillis?.() ?? 0;
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

    transaction.set(topicRef, {
      ...topicData,
      views: 0,
      reputation: 0,
      created_at: serverTimestamp(),
      posts_count: 0 // Will be incremented by onPostCreated for the first post
    });

    const { content: processedContent, rolls } = processDiceRolls(firstPostData.content);

    transaction.set(postRef, {
      ...firstPostData,
      content: processedContent,
      rolls,
      topic_id: topicRef.id,
      reputation: 0,
      created_at: serverTimestamp()
    });

    // post_count increment is handled server-side via Cloud Functions
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

export const fetchSecuredPosts = async (topicId) => {
  try {
    const functions = getFunctions();
    const getSecured = httpsCallable(functions, 'getSecuredPosts');
    const result = await getSecured({ topicId });
    // result.data.posts will be dates in ISO string format, 
    // but the app components (like BBCode) might expect Firebase Timestamp.
    // Client-side, we should map them back or ensure the components handle string dates.
    // Actually, BBCode and TopicPage use posts. To make it seamless:
    const posts = result.data.posts || [];
    return posts.map(p => {
      // Mock toMillis() for ISO string sorting in case it's used elsewhere
      const dateVal = p.created_at ? new Date(p.created_at) : null;
      return {
        ...p,
        created_at: dateVal ? {
          toDate: () => dateVal,
          toMillis: () => dateVal.getTime(),
          seconds: Math.floor(dateVal.getTime() / 1000)
        } : null,
        updated_at: p.updated_at ? {
           toDate: () => new Date(p.updated_at),
           toMillis: () => new Date(p.updated_at).getTime()
        } : null
      };
    });
  } catch (err) {
    console.error('[fetchSecuredPosts]', err);
    return [];
  }
};

/**
 * Subscribe to posts by a specific user.
 */
export const subscribeToUserPosts = (uid, limitCount, callback) => {
  const q = query(
    collection(db, 'posts'),
    where('author_id', '==', uid)
  );
  return onSnapshot(q,
    (snapshot) => {
      const posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort by creation time desc (newest first) client-side
      posts.sort((a, b) => {
        const aTime = a.created_at?.toMillis?.() ?? 0;
        const bTime = b.created_at?.toMillis?.() ?? 0;
        return bTime - aTime;
      });
      callback(posts.slice(0, limitCount));
    },
    (err) => console.error('[subscribeToUserPosts]', err)
  );
};

// Reply to a topic
export const createPost = async (postData) => {
  const postRef = doc(collection(db, 'posts'));
  
  await runTransaction(db, async (transaction) => {
    const { content: processedContent, rolls } = processDiceRolls(postData.content);

    transaction.set(postRef, {
      ...postData,
      content: processedContent,
      rolls,
      reputation: 0,
      created_at: serverTimestamp()
    });
    // post_count increment is handled server-side via Cloud Functions
  });

  // Notifications are handled server-side by the onPostCreated Cloud Function
  // (handlePostNotifications). Do NOT duplicate that logic here.

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
  return postData.topic_id; // One draft per topic per user
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

// Publish a draft: reuses the proven 4-op transaction structure of createPost,
// then deletes the draft. The old approach used a single 5-op transaction which
// caused permission-denied for non-admin users due to how Firestore Security Rules
// evaluate get() calls across multi-document commits.
export const publishDraft = async (uid, topicId) => {
  const draftRef = doc(db, 'users', uid, 'drafts', topicId);

  // 1. Read the draft
  const draftSnap = await getDoc(draftRef);
  if (!draftSnap.exists()) throw new Error('Draft not found');
  const rawDraft = draftSnap.data();

  // 2. Strip draft-only fields; createPost will add reputation, created_at, rolls
  const { is_draft: _d, reputation: _r, created_at: _ts, ...postData } = rawDraft;

  // 3. Create the post using the standard path — identical to a normal reply.
  //    This handles: post creation, topic/category/user counter updates, AND notifications.
  const newPostId = await createPost(postData);

  // 4. Delete the draft now that the post is live (separate operation — simpler rules)
  await deleteDoc(draftRef);

  return newPostId;
};

/**
 * Locate which page a post appears on within its topic.
 * Returns a stable deep-link descriptor suitable for URL construction.
 *
 * @param {string} postId
 * @param {number} itemsPerPage  Must match the pagination constant used by the UI.
 * @returns {{ found: boolean, reason?: string, topicId?: string, postId?: string, page?: number, anchor?: string }}
 */
export const locatePost = async (postId, itemsPerPage = 20) => {
  if (!postId) return { found: false, reason: 'missing_post_id' };

  try {
    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (!postSnap.exists()) return { found: false, reason: 'not_found' };

    const { topic_id: topicId, created_at: createdAt } = postSnap.data();
    if (!topicId) return { found: false, reason: 'missing_topic_id' };

    // created_at is null on a freshly committed post whose server timestamp
    // hasn't propagated yet. A post with no timestamp is necessarily the
    // newest one in the thread, so page 1 of a single-post view — or the
    // last page in a multi-page view — is the correct fallback.
    // We cannot use serverTimestamp() here: it is a write sentinel and
    // Firestore rejects it as a query comparator.
    if (!createdAt) {
      return { found: true, topicId, postId, page: 1, anchor: `#post-${postId}` };
    }

    const priorPostsQuery = query(
      collection(db, 'posts'),
      where('topic_id', '==', topicId),
      where('created_at', '<', createdAt)
    );

    const countSnap = await getCountFromServer(priorPostsQuery);
    const countBefore = countSnap.data().count;
    const page = Math.floor(countBefore / itemsPerPage) + 1;

    return { found: true, topicId, postId, page, anchor: `#post-${postId}` };
  } catch (err) {
    console.error('[locatePost]', err);
    return { found: false, reason: 'error' };
  }
};

export const updatePost = async (postId, content, metadata = {}, performerId, authorId) => {
  await updateDoc(doc(db, 'posts', postId), {
    content,
    ...metadata,
    edited_at: serverTimestamp()
  });
  if (performerId && authorId && performerId !== authorId) {
    await logAdminAction('post_edited_by_admin', performerId, { targetId: postId, authorId });
  }
};

export const updateTopic = async (topicId, data, performerId, authorId) => {
  const topicRef = doc(db, 'topics', topicId);
  await updateDoc(topicRef, {
    ...data,
    updated_at: serverTimestamp()
  });

  if (performerId) {
    if (data.is_pinned !== undefined) {
      await logAdminAction(data.is_pinned ? 'topic_pinned' : 'topic_unpinned', performerId, { targetId: topicId, title: data.title });
    }
    if (data.is_locked !== undefined) {
      await logAdminAction(data.is_locked ? 'topic_locked' : 'topic_unlocked', performerId, { targetId: topicId, title: data.title });
    }
    if ((data.title !== undefined || data.description !== undefined) && performerId !== authorId) {
      await logAdminAction('topic_edited_by_admin', performerId, { targetId: topicId, authorId });
    }
  }

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

export const deletePost = async (post, performerId) => {
  const postRef = doc(db, 'posts', post.id);

  if (performerId && performerId !== post.author_id) {
    await logAdminAction('post_deleted_by_admin', performerId, { targetId: post.id, topicId: post.topic_id, authorId: post.author_id });
  }

  // Simply delete the post. Cloud Functions handle:
  // - Decrementing posts_count for topic, category, user
  // - Reverting reputation and deleting reputation_logs
  // - Synchronizing last_post metadata for topic and category
  // - Cleaning up notifications
  await deleteDoc(postRef);
};
// ── Users ─────────────────────────────────────────────────────────────────────

export const updateUser = async (uid, userData, performerId) => {
  // Check if nickname is changing — log it for any change (self or admin)
  if (userData.nickname !== undefined && performerId) {
    try {
      const existingSnap = await getDoc(doc(db, 'users', uid));
      if (existingSnap.exists()) {
        const oldNickname = existingSnap.data().nickname;
        if (oldNickname !== userData.nickname) {
          await logAdminAction('nickname_changed', performerId, {
            targetId: uid,
            oldNickname,
            newNickname: userData.nickname,
            self: uid === performerId
          });
        }
      }
    } catch (e) {
      console.error('[updateUser nickname log]', e);
    }
  }

  await updateDoc(doc(db, 'users', uid), {
    ...userData,
    updated_at: serverTimestamp()
  });
  if (performerId && uid !== performerId) {
    await logAdminAction('user_profile_edited_by_admin', performerId, { targetId: uid });
  }
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

export const deleteTopics = async (topicIds, performerId) => {
  for (const topicId of topicIds) {
    const topicRef = doc(db, 'topics', topicId);
    const topicSnap = await getDoc(topicRef);
    if (!topicSnap.exists()) continue;

    const topicData = topicSnap.data();
    const categoryId = topicData.category_id;

    // Fetch posts outside of atomic block to avoid running queries inside a transaction callback
    const postsQ = query(collection(db, 'posts'), where('topic_id', '==', topicId));
    const postsSnap = await getDocs(postsQ);

    const batch = writeBatch(db);

    // 1. Delete all posts in topic
    postsSnap.forEach(pDoc => batch.delete(pDoc.ref));

    // 2. Delete topic
    batch.delete(topicRef);
    
    // Log
    if (performerId) {
      await logAdminAction('topic_deleted', performerId, { targetId: topicId, title: topicData.title });
    }

    // NOTE: topics_count / posts_count decrements are handled server-side
    // by the onTopicDeleted / onPostDeleted Cloud Function triggers.

    // Commit the batch
    await batch.commit();
    
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
          last_post_author_avatar: latestTopic.last_post_author_avatar || null,
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

  }
};

export const moveTopics = async (topicIds, targetCategoryId, performerId) => {
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
    
    if (performerId) {
      await logAdminAction('topic_moved', performerId, { targetId: topicId, title: topicData.title, sourceCategoryId, targetCategoryId });
    }

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

// Batch update topic fields (is_pinned, is_locked)
export const batchUpdateTopics = async (topicIds, data, performerId) => {
  const promises = topicIds.map(async (id) => {
    const topicRef = doc(db, 'topics', id);
    const snap = await getDoc(topicRef);
    if (!snap.exists()) return;
    const topicData = snap.data();
    const title = topicData.title;
    
    await updateDoc(topicRef, {
      ...data,
      updated_at: serverTimestamp()
    });
    
    if (performerId) {
      if (data.is_pinned !== undefined) {
        await logAdminAction(data.is_pinned ? 'topic_pinned' : 'topic_unpinned', performerId, { targetId: id, title });
      }
      if (data.is_locked !== undefined) {
        await logAdminAction(data.is_locked ? 'topic_locked' : 'topic_unlocked', performerId, { targetId: id, title });
      }
    }
  });
  await Promise.all(promises);
};

