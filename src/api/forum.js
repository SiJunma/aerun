import { db } from '../../firebase';
import { logAdminAction } from './audit';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  collection,
  setDoc,
  doc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDocs,
  limit,
  getDoc
} from 'firebase/firestore';

import { processDiceRolls } from '../utils/dice';

// RTDB forum caches (main_page_cache, topic_posts_cache) are server-only:
// they contain records from every category, so only Cloud Functions with
// admin credentials may read or write them. Firestore stays the source of
// truth; triggers denormalise into RTDB after each mutation.


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
      if (err?.code === 'permission-denied') {
        // Document was deleted or access revoked gracefully
        callback(null, null);
        return;
      }
      console.error('[subscribeToTopic]', err);
      callback(null, err);
    }
  );

  return unsub; // Возвращаем функцию отписки напрямую
};

export const fetchSecuredTopics = async (categoryId, page = 1, pageSize = 20) => {
  const functions = getFunctions();
  const getSecured = httpsCallable(functions, 'getSecuredTopics');
  const result = await getSecured({ categoryId, page, pageSize });
  return result.data; // { pinned: [], topics: [] }
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

// Create new topic + first post atomically via the server callable
export const createTopic = async (topicData, firstPostData) => {
  const { content: processedContent, rolls } = processDiceRolls(firstPostData.content);
  const functions = getFunctions();
  const callCreateTopic = httpsCallable(functions, 'createTopic');
  const result = await callCreateTopic({
    topicData,
    firstPostData: { ...firstPostData, content: processedContent, rolls }
  });
  // { success, topicId, postId, converged, forum? }
  return result.data;
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
  // Deliberately disabled: the cache is private to Cloud Functions. The page
  // refreshes through fetchSecuredPosts, which performs the permission check.
  void topicId;
  void sinceTimestamp;
  void callback;
  return () => {};
};

export const subscribeToPostRemovalsRtdb = (topicId, callback) => {
  void topicId;
  void callback;
  return () => {};
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
  const { content: processedContent, rolls } = processDiceRolls(postData.content);
  const functions = getFunctions();
  const callCreatePost = httpsCallable(functions, 'createPost');
  const result = await callCreatePost({ ...postData, content: processedContent, rolls });
  // { success, postId, converged, forum? } — the converged main-page projection
  // lets the caller update state without any background polling.
  return result.data;
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

  // 3. Create the post using the standard (server) path — identical to a normal reply.
  const result = await createPost(postData);

  // 4. Delete the draft now that the post is live (separate operation — simpler rules)
  await deleteDoc(draftRef);

  return result; // { success, postId, converged, forum? }
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

export const updatePost = async (postId, content, metadata = {}, performerId, authorId, topicUpdates = null) => {
  const functions = getFunctions();
  const callUpdatePost = httpsCallable(functions, 'updatePost');
  const result = await callUpdatePost({ postId, content, metadata, topicUpdates });
  if (performerId && authorId && performerId !== authorId) {
    await logAdminAction('post_edited_by_admin', performerId, { targetId: postId, authorId });
  }
  // { success, converged, forum? }
  return result.data;
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
  if (performerId && performerId !== post.author_id) {
    await logAdminAction('post_deleted_by_admin', performerId, { targetId: post.id, topicId: post.topic_id, author_id: post.author_id });
  }

  const functions = getFunctions();
  const callDeletePost = httpsCallable(functions, 'deletePost');
  const result = await callDeletePost({ postId: post.id, topicId: post.topic_id });
  // { success, isGhost, converged, forum? } — the server purges ghost RTDB cache
  // entries itself, so the old deleteGhostPost fallback is no longer needed here.
  return result.data;
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
  if (!topicIds || topicIds.length === 0) return { success: true, deleted: [], forum: null };

  const functions = getFunctions();
  const callDeleteTopics = httpsCallable(functions, 'deleteTopics');
  const result = await callDeleteTopics({ topicIds });

  // Audit log stays client-side (actor_uid is pinned to the caller by rules).
  if (performerId) {
    for (const topic of (result.data?.deleted || [])) {
      await logAdminAction('topic_deleted', performerId, { targetId: topic.id, title: topic.title });
    }
  }

  // { success, deleted, converged, forum? } — counters/cascade/RTDB are handled
  // server-side by onTopicDeleted; the callable waits for the cache to converge.
  return result.data;
};

export const moveTopics = async (topicIds, targetCategoryId, performerId) => {
  const functions = getFunctions();
  const callMoveTopics = httpsCallable(functions, 'moveTopics');
  const result = await callMoveTopics({ topicIds, targetCategoryId });

  if (performerId) {
    for (const topic of (result.data?.moved || [])) {
      await logAdminAction('topic_moved', performerId, {
        targetId: topic.id,
        title: topic.title,
        sourceCategoryId: topic.sourceCategoryId,
        targetCategoryId
      });
    }
  }

  // { success, moved, converged, forum? }
  return result.data;
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
  if (!postIds || postIds.length === 0) return { success: true, forum: null };

  const functions = getFunctions();
  const callMovePosts = httpsCallable(functions, 'movePosts');
  const result = await callMovePosts({ postIds, targetTopicId });

  // Audit log stays client-side (actor_uid is pinned to the caller by rules),
  // one entry per source topic — the same shape the pre-callable implementation
  // logged. The callable returns the grouping as `moved`.
  if (performerId) {
    for (const group of (result.data?.moved || [])) {
      await logAdminAction('posts_moved', performerId, {
        postIds: group.postIds,
        sourceTopicId: group.sourceTopicId,
        targetTopicId,
        count: group.count,
      });
    }
  }

  // { success, converged, moved, forum? } — topic/category metadata
  // recomputation and RTDB cache convergence are handled server-side by the
  // callable + triggers.
  return result.data;
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

