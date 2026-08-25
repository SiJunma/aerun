import { db, rtdb } from '../../firebase';
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
  getCountFromServer,
  Timestamp
} from 'firebase/firestore';
import {
  getDatabase,
  ref as rtdbRef,
  remove as rtdbRemove,
  update as rtdbUpdate,
  onChildAdded,
  onChildRemoved,
  query as rtdbQuery,
  orderByChild,
  startAfter
} from 'firebase/database';

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

// Single topic by ID with quiet polling (no persistent WebSocket)
// Single topic by ID with real-time listener (much cheaper than setInterval polling)
export const subscribeToTopic = (topicId, callback) => {
  const unsub = onSnapshot(doc(db, 'topics', topicId),
    (snap) => {
      callback(snap.exists() ? { id: snap.id, ...snap.data() } : null, null);
    },
    (err) => {
      console.error('[subscribeToTopic]', err);
      callback(null, err);
    }
  );

  return unsub; // Возвращаем функцию отписки напрямую
};

export const fetchSecuredTopics = async (categoryId, page = 1, pageSize = 20) => {
  try {
    const functions = getFunctions();
    const getSecured = httpsCallable(functions, 'getSecuredTopics');
    const result = await getSecured({ categoryId, page, pageSize });
    return result.data; // { pinned: [], topics: [] }
  } catch (err) {
    console.error('[fetchSecuredTopics]', err);
    return { pinned: [], topics: [] };
  }
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
      category_id: topicData.category_id,
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

export const subscribeToNewPostsRtdb = (topicId, sinceTimestamp, callback) => {
  if (!topicId) return () => {};
  const rtdb = getDatabase();
  const postsRef = rtdbRef(rtdb, `topic_posts_cache/${topicId}/posts`);
  const effectiveSince = typeof sinceTimestamp === 'number' ? sinceTimestamp : Date.now();
  const q = rtdbQuery(postsRef, orderByChild('created_at'), startAfter(effectiveSince));

  const unsubscribe = onChildAdded(q, (snapshot) => {
    const post = snapshot.val();
    if (!post) return;

    post.id = snapshot.key;

    // Parse created_at timestamp
    let postMs = typeof post.created_at === 'number'
      ? post.created_at
      : (post.created_at?.toMillis ? post.created_at.toMillis() : Date.now());

    const validDate = new Date(postMs);
    post.created_at = {
      toDate: () => validDate,
      toMillis: () => validDate.getTime(),
      seconds: Math.floor(validDate.getTime() / 1000)
    };

    if (post.edited_at) {
      const editMs = typeof post.edited_at === 'number'
        ? post.edited_at
        : new Date(post.edited_at).getTime();
      const editDate = !isNaN(editMs) ? new Date(editMs) : new Date();
      post.edited_at = {
        toDate: () => editDate,
        toMillis: () => editDate.getTime()
      };
    }

    callback(post);
  }, (err) => {
    console.error('[subscribeToNewPostsRtdb error]', err);
  });

  return () => unsubscribe();
};

export const subscribeToPostRemovalsRtdb = (topicId, callback) => {
  const rtdb = getDatabase();
  const postsRef = rtdbRef(rtdb, `topic_posts_cache/${topicId}/posts`);

  const unsubscribe = onChildRemoved(postsRef, (snapshot) => {
    const removedPostId = snapshot.key;
    if (removedPostId) {
      callback(removedPostId);
    }
  }, (err) => {
    console.error('[subscribeToPostRemovalsRtdb error]', err);
  });

  return () => unsubscribe();
};

export const fetchSecuredPosts = async (topicId, page = 1, pageSize = 20, lastVisit = null) => {
  try {
    const functions = getFunctions();
    const getSecured = httpsCallable(functions, 'getSecuredPosts');
    const result = await getSecured({ topicId, page, pageSize, lastVisit });

    const normalizePost = (p) => {
      if (!p) return null;
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
    };

    const posts = (result.data.posts || []).map(normalizePost);
    const pinnedPost = result.data.pinnedPost ? normalizePost(result.data.pinnedPost) : null;
    const lastPost = result.data.lastPost ? normalizePost(result.data.lastPost) : null;

    return {
      posts,
      pinnedPost,
      page: result.data.page || (typeof page === 'number' ? page : 1),
      lastPost
    };
  } catch (err) {
    console.error('[fetchSecuredPosts]', err);
    throw err;
  }
};

/**
 * Securely fetch user posts via Cloud Function.
 */
export const fetchUserPosts = async (targetUid, page = 1, pageSize = 20, postFilter = 'all') => {
  try {
    const functions = getFunctions();
    const getUserPosts = httpsCallable(functions, 'getUserPosts');
    const result = await getUserPosts({ targetUid, page, pageSize, postFilter });

    const posts = result.data.posts || [];
    const mappedPosts = posts.map(p => {
      // Map ISO strings back to Firestore-like Timestamp objects for component compatibility
      const dateVal = p.created_at ? new Date(p.created_at) : null;
      const updateVal = p.updated_at ? new Date(p.updated_at) : null;

      return {
        ...p,
        created_at: dateVal ? {
          toDate: () => dateVal,
          toMillis: () => dateVal.getTime(),
          seconds: Math.floor(dateVal.getTime() / 1000)
        } : null,
        updated_at: updateVal ? {
          toDate: () => updateVal,
          toMillis: () => updateVal.getTime()
        } : null
      };
    });

    return {
      posts: mappedPosts,
      totalCount: result.data.totalCount || 0,
      hasMore: result.data.hasMore || false
    };
  } catch (err) {
    console.error('[fetchUserPosts]', err);
    return { posts: [], totalCount: 0, hasMore: false };
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
  if (!uid) return () => { };
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
    const functions = getFunctions();
    const locate = httpsCallable(functions, 'locatePost');
    const result = await locate({ postId, itemsPerPage });
    return result.data;
  } catch (err) {
    console.error('[locatePost]', err);
    return { found: false, reason: 'error' };
  }
};

/**
 * Locate the page of the first unread post for a user in a topic.
 *
 * @param {string} topicId
 * @param {number} lastVisitMs
 * @param {number} itemsPerPage
 * @returns {{ found: boolean, page?: number }}
 */
export const locateUnreadPost = async (topicId, lastVisitMs, itemsPerPage = 20) => {
  if (!topicId || !lastVisitMs) return { found: false, reason: 'missing_args' };

  try {
    const functions = getFunctions();
    const locate = httpsCallable(functions, 'locateUnreadPost');
    const result = await locate({ topicId, lastVisitMs, itemsPerPage });
    return result.data;
  } catch (err) {
    console.error('[locateUnreadPost]', err);
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
    await logAdminAction('post_deleted_by_admin', performerId, { targetId: post.id, topicId: post.topic_id, author_id: post.author_id });
  }

  try {
    // 1. Пробуем удалить пост из Firestore
    await deleteDoc(postRef);
  } catch (err) {
    // Если Firestore выдаёт "Missing or insufficient permissions" или "not-found",
    // значит поста в Firestore УЖЕ НЕТ (он остался только в кэше RTDB).
    const isPermissionOrNotFound =
      err?.code === 'permission-denied' ||
      err?.message?.includes('permissions') ||
      err?.code === 'not-found';

    if (isPermissionOrNotFound) {
      console.warn(`[deletePost] Post ${post.id} missing in Firestore. Requesting server to purge RTDB cache...`);

      // 2. Взываем серверную функцию, чтобы она от имени Admin SDK зачистила RTDB!
      try {
        const functions = getFunctions();
        const purgeGhost = httpsCallable(functions, 'deleteGhostPost');
        await purgeGhost({ topicId: post.topic_id, postId: post.id });
      } catch (purgeErr) {
        console.error('[deletePost] Failed to call deleteGhostPost:', purgeErr);
      }

      return { isGhost: true };
    }

    // Любую другую настоящую ошибку пробрасываем дальше
    throw err;
  }

  return { success: true };
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
          last_post_topic_posts_count: latestTopic.posts_count || null,
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

    // Recalculate last_post and counters for both categories and sync to RTDB
    const updateCatLastPost = async (catId) => {
      const q = query(collection(db, 'topics'), where('category_id', '==', catId), orderBy('last_post_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      const catDocRef = doc(db, 'categories', catId);
      const lastPostFields = {};
      if (!snap.empty) {
        const top = snap.docs[0].data();
        lastPostFields.last_post_at = top.last_post_at || null;
        lastPostFields.last_post_author = top.last_post_author || null;
        lastPostFields.last_post_author_id = top.last_post_author_id || null;
        lastPostFields.last_post_author_avatar = top.last_post_author_avatar || null;
        lastPostFields.last_post_topic_id = snap.docs[0].id || null;
        lastPostFields.last_post_topic_title = top.title || null;
        lastPostFields.last_post_topic_posts_count = top.posts_count || null;
        lastPostFields.last_post_is_character = top.last_post_is_character || false;
        lastPostFields.last_post_author_character_id = top.last_post_author_character_id || null;
      } else {
        lastPostFields.last_post_at = null;
        lastPostFields.last_post_author = null;
        lastPostFields.last_post_author_id = null;
        lastPostFields.last_post_author_avatar = null;
        lastPostFields.last_post_topic_id = null;
        lastPostFields.last_post_topic_title = null;
        lastPostFields.last_post_is_character = null;
        lastPostFields.last_post_author_character_id = null;
      }
      await updateDoc(catDocRef, lastPostFields);

      // Immediately patch RTDB main_page_cache
      if (rtdb) {
        try {
          const freshSnap = await getDoc(catDocRef);
          if (freshSnap.exists()) {
            const data = freshSnap.data();
            const rtdbPayload = {
              id: catId,
              ...data,
              created_at: data.created_at?.toDate ? data.created_at.toDate().toISOString() : data.created_at || null,
              updated_at: data.updated_at?.toDate ? data.updated_at.toDate().toISOString() : data.updated_at || null,
              last_post_at: data.last_post_at?.toDate ? data.last_post_at.toDate().toISOString() : data.last_post_at || null,
            };
            await rtdbUpdate(rtdbRef(rtdb, `main_page_cache/categories/${catId}`), rtdbPayload);
          }
        } catch (rtdbErr) {
          console.warn('[moveTopics RTDB sync err]', rtdbErr);
        }
      }
    };

    if (sourceCategoryId) await updateCatLastPost(sourceCategoryId);
    await updateCatLastPost(targetCategoryId);
  }
};

/**
 * Safely converts any Firestore timestamp representation to milliseconds.
 */
const getTimestampMs = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? 0 : parsed;
  }
  if (typeof ts.seconds === 'number') {
    return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1000000);
  }
  if (ts instanceof Date) return ts.getTime();
  return 0;
};

// Batch update topic fields (is_pinned, is_locked)
/**
 * Move a set of posts from their current topics to a target topic.
 * Posts keep their original content and metadata; only topic_id changes.
 * Counters for both source and target topics + their categories are updated.
 *
 * @param {string[]} postIds   IDs of posts to move
 * @param {string}   targetTopicId  Destination topic ID
 * @param {string}   performerId    UID of the moderator performing the action
 */
export const movePosts = async (postIds, targetTopicId, performerId) => {
  if (!postIds || postIds.length === 0) return;

  const targetTopicRef = doc(db, 'topics', targetTopicId);
  const targetTopicSnap = await getDoc(targetTopicRef);
  if (!targetTopicSnap.exists()) throw new Error('Target topic not found');
  const targetTopicData = targetTopicSnap.data();
  const targetCategoryId = targetTopicData.category_id;

  // Get the target topic's posts to prevent moved posts from preceding its first post
  const targetPostsQuery = query(
    collection(db, 'posts'),
    where('topic_id', '==', targetTopicId)
  );
  const targetPostsSnap = await getDocs(targetPostsQuery);
  let targetFirstPost = null;
  let targetLatestPost = null;
  if (!targetPostsSnap.empty) {
    const targetPostsList = targetPostsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    targetPostsList.sort((a, b) => {
      const aTime = getTimestampMs(a.created_at);
      const bTime = getTimestampMs(b.created_at);
      return aTime - bTime; // oldest first
    });
    targetFirstPost = targetPostsList[0];
    targetLatestPost = targetPostsList[targetPostsList.length - 1];
  }

  // Group posts by their source topic so we can update each source once
  const sourceMap = {}; // { topicId: [postData, ...] }

  for (const postId of postIds) {
    const postSnap = await getDoc(doc(db, 'posts', postId));
    if (!postSnap.exists()) continue;
    const postData = { id: postId, ...postSnap.data() };
    const srcId = postData.topic_id;
    if (!sourceMap[srcId]) sourceMap[srcId] = [];
    sourceMap[srcId].push(postData);
  }

  // For each source topic: move posts + update counters
  for (const [sourceTopicId, sourcePosts] of Object.entries(sourceMap)) {
    if (sourceTopicId === targetTopicId) continue; // already there

    const count = sourcePosts.length;
    const sourceTopicRef = doc(db, 'topics', sourceTopicId);
    const sourceTopicSnap = await getDoc(sourceTopicRef);
    const sourceCategoryId = sourceTopicSnap.exists() ? sourceTopicSnap.data().category_id : null;

    // Batch: update each post's topic_id and make sure they don't precede the target's first post
    const batch = writeBatch(db);

    const sortedSourcePosts = [...sourcePosts].sort((a, b) => {
      const aMs = getTimestampMs(a.created_at);
      const bMs = getTimestampMs(b.created_at);
      return aMs - bMs; // oldest first
    });

    const targetFirstPostMs = getTimestampMs(targetFirstPost?.created_at) || getTimestampMs(targetTopicData.created_at);
    const targetLatestPostMs = getTimestampMs(targetLatestPost?.created_at) || targetFirstPostMs;
    const baseTimestampMs = Math.max(targetFirstPostMs, targetLatestPostMs);

    // If target topic has posts, moved posts that were created prior to the target's posts
    // are shifted to start 1 minute (60,000 ms) after baseTimestampMs, spaced by at least 1 min.
    let nextAllowedMs = baseTimestampMs + 60 * 1000;

    for (let i = 0; i < sortedSourcePosts.length; i++) {
      const p = sortedSourcePosts[i];
      const postMs = getTimestampMs(p.created_at);
      const updates = { topic_id: targetTopicId };

      if (baseTimestampMs > 0 && (postMs <= baseTimestampMs || postMs < nextAllowedMs)) {
        // Assign adjusted timestamp
        updates.created_at = Timestamp.fromMillis(nextAllowedMs);

        // Next post will be at least 1 minute later, or preserve the original relative delta
        const nextP = sortedSourcePosts[i + 1];
        if (nextP) {
          const nextPMs = getTimestampMs(nextP.created_at);
          const originalDelta = (nextPMs > postMs && postMs > 0) ? (nextPMs - postMs) : 60 * 1000;
          nextAllowedMs += Math.max(60 * 1000, originalDelta);
        } else {
          nextAllowedMs += 60 * 1000;
        }
      } else {
        // Timestamp is already properly in the future
        nextAllowedMs = postMs + 60 * 1000;
      }

      batch.update(doc(db, 'posts', p.id), updates);
    }

    // Decrement source topic
    batch.update(sourceTopicRef, { posts_count: increment(-count), updated_at: serverTimestamp() });
    // Increment target topic
    batch.update(targetTopicRef, { posts_count: increment(count), updated_at: serverTimestamp() });

    // Update category posts counts if moved across different categories
    if (sourceCategoryId && targetCategoryId && sourceCategoryId !== targetCategoryId) {
      batch.update(doc(db, 'categories', sourceCategoryId), {
        posts_count: increment(-count)
      });
      batch.update(doc(db, 'categories', targetCategoryId), {
        posts_count: increment(count)
      });
    }

    await batch.commit();

    // Recalculate last_post for both topics (client-side sort to avoid composite index requirement)
    const recalcTopicLastPost = async (topicId) => {
      const q = query(
        collection(db, 'posts'),
        where('topic_id', '==', topicId)
      );
      const snap = await getDocs(q);
      const tRef = doc(db, 'topics', topicId);
      if (!snap.empty) {
        const postsList = snap.docs.map(d => d.data());
        postsList.sort((a, b) => {
          const aTime = a.created_at?.toMillis?.() ?? 0;
          const bTime = b.created_at?.toMillis?.() ?? 0;
          return bTime - aTime; // Sort descending (newest first)
        });
        const latest = postsList[0];
        await updateDoc(tRef, {
          last_post_at: latest.created_at || null,
          last_post_author: latest.author_name || null,
          last_post_author_id: latest.author_id || null,
          last_post_author_avatar: latest.author_avatar || null,
          last_post_is_character: latest.is_character || false,
          last_post_author_character_id: latest.author_character_id || null,
        });
      } else {
        await updateDoc(tRef, {
          last_post_at: null,
          last_post_author: null,
          last_post_author_id: null,
          last_post_author_avatar: null,
          last_post_is_character: null,
          last_post_author_character_id: null,
        });
      }
    };

    await recalcTopicLastPost(sourceTopicId);
    await recalcTopicLastPost(targetTopicId);

    // Recalculate last_post for affected categories and sync to RTDB
    const updateCatLastPost = async (catId) => {
      const q = query(collection(db, 'topics'), where('category_id', '==', catId), orderBy('last_post_at', 'desc'), limit(1));
      const snap = await getDocs(q);
      const catDocRef = doc(db, 'categories', catId);
      const lastPostFields = {};
      if (!snap.empty) {
        const top = snap.docs[0].data();
        lastPostFields.last_post_at = top.last_post_at || null;
        lastPostFields.last_post_author = top.last_post_author || null;
        lastPostFields.last_post_author_id = top.last_post_author_id || null;
        lastPostFields.last_post_author_avatar = top.last_post_author_avatar || null;
        lastPostFields.last_post_topic_id = snap.docs[0].id || null;
        lastPostFields.last_post_topic_title = top.title || null;
        lastPostFields.last_post_topic_posts_count = top.posts_count || null;
        lastPostFields.last_post_is_character = top.last_post_is_character || false;
        lastPostFields.last_post_author_character_id = top.last_post_author_character_id || null;
      } else {
        lastPostFields.last_post_at = null;
        lastPostFields.last_post_author = null;
        lastPostFields.last_post_author_id = null;
        lastPostFields.last_post_author_avatar = null;
        lastPostFields.last_post_topic_id = null;
        lastPostFields.last_post_topic_title = null;
        lastPostFields.last_post_is_character = null;
        lastPostFields.last_post_author_character_id = null;
      }
      await updateDoc(catDocRef, lastPostFields);

      // Immediately patch RTDB main_page_cache
      if (rtdb) {
        try {
          const freshSnap = await getDoc(catDocRef);
          if (freshSnap.exists()) {
            const data = freshSnap.data();
            const rtdbPayload = {
              id: catId,
              ...data,
              created_at: data.created_at?.toDate ? data.created_at.toDate().toISOString() : data.created_at || null,
              updated_at: data.updated_at?.toDate ? data.updated_at.toDate().toISOString() : data.updated_at || null,
              last_post_at: data.last_post_at?.toDate ? data.last_post_at.toDate().toISOString() : data.last_post_at || null,
            };
            await rtdbUpdate(rtdbRef(rtdb, `main_page_cache/categories/${catId}`), rtdbPayload);
          }
        } catch (rtdbErr) {
          console.warn('[movePosts RTDB sync err]', rtdbErr);
        }
      }
    };

    if (sourceCategoryId) await updateCatLastPost(sourceCategoryId);
    if (targetCategoryId && targetCategoryId !== sourceCategoryId) await updateCatLastPost(targetCategoryId);

    if (performerId) {
      await logAdminAction('posts_moved', performerId, {
        postIds: sourcePosts.map(p => p.id),
        sourceTopicId,
        targetTopicId,
        count,
      });
    }
  }
};

/**
 * Create a new topic from a set of existing posts.
 * The chronologically first post becomes the topic-starter; the rest become replies.
 * Posts are moved (topic_id updated) just like movePosts.
 *
 * @param {string[]} postIds      IDs of posts to move into the new topic
 * @param {{ title, description, category_id }} topicData  Metadata for the new topic
 * @param {string}   performerId  UID of the moderator performing the action
 * @returns {string} New topic ID
 */
export const createTopicFromPosts = async (postIds, topicData, performerId) => {
  if (!postIds || postIds.length === 0) throw new Error('No posts selected');

  // Fetch all posts and sort chronologically
  const postSnaps = await Promise.all(postIds.map(id => getDoc(doc(db, 'posts', id))));
  const validPosts = postSnaps
    .filter(s => s.exists())
    .map(s => ({ id: s.id, ...s.data() }))
    .sort((a, b) => {
      const aMs = getTimestampMs(a.created_at);
      const bMs = getTimestampMs(b.created_at);
      return aMs - bMs;
    });

  if (validPosts.length === 0) throw new Error('No valid posts found');

  const firstPost = validPosts[0];

  // Create the new topic (no first post yet — Cloud Function will handle counters)
  const newTopicRef = doc(collection(db, 'topics'));
  await setDoc(newTopicRef, {
    category_id: topicData.category_id,
    title: topicData.title,
    description: topicData.description || '',
    author_id: firstPost.author_id,
    author_name: firstPost.author_name,
    author_avatar: firstPost.author_avatar || '',
    is_character: firstPost.is_character || false,
    author_character_id: firstPost.author_character_id || null,
    is_pinned: false,
    is_locked: false,
    views: 0,
    reputation: 0,
    posts_count: 0, // will be updated below
    last_post_at: null,
    last_post_author: null,
    last_post_author_id: null,
    last_post_author_avatar: null,
    last_post_is_character: false,
    last_post_author_character_id: null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  // Move the posts into the new topic (reuse movePosts logic)
  await movePosts(validPosts.map(p => p.id), newTopicRef.id, performerId);

  if (performerId) {
    await logAdminAction('topic_created_from_posts', performerId, {
      newTopicId: newTopicRef.id,
      title: topicData.title,
      postIds: validPosts.map(p => p.id),
    });
  }

  return newTopicRef.id;
};

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

