import { sendApi, pb } from './pocketbase';
import { processDiceRolls } from '../utils/dice';

const normalizeTopic = (t) => {
  if (!t) return null;
  const createdDate = t.created || t.created_at;
  const lastPostDate = t.last_post_created || t.last_post_at || createdDate;
  return {
    ...t,
    id: t.id,
    category_id: t.category_id,
    title: t.title,
    author_id: t.author_id,
    posts_count: t.posts_count || 1,
    is_pinned: !!(t.pinned || t.is_pinned),
    is_locked: !!(t.locked || t.is_locked),
    created_at: createdDate,
    last_post_at: lastPostDate,
    created_at_ms: createdDate ? new Date(createdDate).getTime() : 0,
    last_post_at_ms: lastPostDate ? new Date(lastPostDate).getTime() : 0,
  };
};

// No `sequence`: the per-post ordinal the backend used to invent is gone, and
// the forum orders by `created` then id. Nothing client-side may depend on a
// number that shifts whenever an earlier post is deleted.
const normalizePost = (p) => {
  if (!p) return null;
  return {
    ...p,
    id: p.id,
    topic_id: p.topic_id,
    author_id: p.author_id,
    content: p.content || '',
    created_at: p.created,
    updated_at: p.updated,
    created_at_ms: p.created ? new Date(p.created).getTime() : 0,
  };
};

// ── Topics ───────────────────────────────────────────────────────────────────

export const subscribeToTopics = (categoryId, callback) => {
  if (!categoryId) {
    callback([]);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&limit=100`);
      if (!isSubscribed) return;
      const all = [...(res?.pinned || []), ...(res?.topics || [])].map(normalizeTopic);
      callback(all);
    } catch (err) {
      console.warn('[subscribeToTopics err]', err);
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 15000);

  let unsub = () => {};
  try {
    pb.collection('topics').subscribe('*', () => {
      load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

export const subscribeToTopic = (topicId, callback) => {
  if (!topicId) {
    callback(null, null);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/topics/${topicId}`);
      if (!isSubscribed) return;
      callback(normalizeTopic(res?.topic), null);
    } catch (err) {
      if (err?.status === 404 || err?.status === 403) {
        if (isSubscribed) callback(null, null);
      } else {
        if (isSubscribed) callback(null, err);
      }
    }
  };

  load();
  const interval = setInterval(load, 15000);

  let unsub = () => {};
  try {
    pb.collection('topics').subscribe(topicId, () => {
      load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

export const fetchSecuredTopics = async (categoryId, page = 1, pageSize = 20) => {
  const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&page=${page}&limit=${pageSize}`);
  return {
    pinned: (res?.pinned || []).map(normalizeTopic),
    topics: (res?.topics || []).map(normalizeTopic),
    total: res?.total || 0,
    page: res?.page || page,
    limit: res?.limit || pageSize
  };
};

export const subscribeToLastTopicInCategory = (categoryId, callback) => {
  if (!categoryId) {
    callback(null);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&limit=1&order_by=last_post_at`);
      if (!isSubscribed) return;
      const topic = res?.topics?.[0] || res?.pinned?.[0] || null;
      callback(normalizeTopic(topic));
    } catch {
      if (isSubscribed) callback(null);
    }
  };

  load();
  const interval = setInterval(load, 25000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

export const createTopic = async (topicData, firstPostData) => {
  const { content: processedContent } = processDiceRolls(firstPostData.content);

  const res = await sendApi('/api/aerun/topics', {
    method: 'POST',
    body: {
      category_id: topicData.category_id,
      title: topicData.title,
      content: processedContent.trim()
    }
  });

  return {
    id: res?.topic?.id || res?.id,
    topic: normalizeTopic(res?.topic),
    post: normalizePost(res?.post)
  };
};

export const subscribeToPosts = (topicId, callback) => {
  if (!topicId) {
    callback([]);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/topics/${topicId}/posts?limit=100`);
      if (!isSubscribed) return;
      callback((res?.posts || []).map(normalizePost));
    } catch {
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 10000);

  let unsub = () => {};
  try {
    pb.collection('posts').subscribe('*', (e) => {
      if (e.record?.topic_id === topicId) load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

// RTDB realtime subscriptions are gone: every mutation now goes through the
// Go backend, and the row writes that used to fire the realtime events are
// gone with them. These signatures keep their parameters so existing call
// sites do not have to change — they are documented above each function, and
// the parameters are prefixed `_` to say "accepted, not read".
export const subscribeToNewPostsRtdb = (_topicId, _sinceTimestamp, _callback) => {
  return () => {};
};

export const subscribeToPostRemovalsRtdb = (_topicId, _callback) => {
  return () => {};
};

export const fetchSecuredPosts = async (topicId, page = 1, pageSize = 20, _lastVisit = null) => {
  const res = await sendApi(`/api/aerun/topics/${topicId}/posts?page=${page}&limit=${pageSize}`);
  return {
    posts: (res?.posts || []).map(normalizePost),
    total: res?.total || 0,
    page: res?.page || page,
    limit: res?.limit || pageSize
  };
};

export const fetchUserPosts = async (targetUid, page = 1, pageSize = 20, _postFilter = 'all') => {
  try {
    const list = await pb.collection('posts').getList(page, pageSize, {
      filter: `author_id = "${targetUid}"`,
      sort: '-created'
    });
    return {
      posts: list.items.map(normalizePost),
      total: list.totalItems,
      page: list.page,
      totalPages: list.totalPages
    };
  } catch (err) {
    console.warn('[fetchUserPosts err]', err);
    return { posts: [], total: 0, page: 1, totalPages: 0 };
  }
};

export const subscribeToUserPosts = (uid, limitCount, callback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }
  let isSubscribed = true;
  fetchUserPosts(uid, 1, limitCount).then(res => {
    if (isSubscribed) callback(res.posts);
  });
  return () => { isSubscribed = false; };
};

// `idempotencyKey` is OPTIONAL but should be supplied by the caller for anything
// a person can double-click. Without it sendApi mints a fresh random key per
// request, so a duplicate that slips past a client-side guard is treated by the
// server as a genuinely new command — and the member gets two posts. Passing
// the SAME key for every request of one logical submit makes the server replay
// the first response instead. See utils/inflight.js.
export const createPost = async (postData, idempotencyKey) => {
  const { content: processedContent } = processDiceRolls(postData.content);

  const res = await sendApi(`/api/aerun/topics/${postData.topic_id}/posts`, {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: {
      content: processedContent.trim()
    }
  });

  return normalizePost(res?.post || res);
};

// ── Draft Posts (Local Storage) ──────────────────────────────────────────────

const getDraftKey = (uid, topicId) => `aerun_draft_${topicId}_${uid}`;

export const createDraftPost = async (postData) => {
  const key = getDraftKey(postData.author_id, postData.topic_id);
  localStorage.setItem(key, JSON.stringify(postData));
};

export const subscribeToTopicDraft = (topicId, uid, callback) => {
  if (!topicId || !uid) {
    callback(null);
    return () => {};
  }
  try {
    const key = getDraftKey(uid, topicId);
    const raw = localStorage.getItem(key);
    callback(raw ? JSON.parse(raw) : null);
  } catch {
    callback(null);
  }
  return () => {};
};

export const updateDraftPost = async (uid, topicId, content, metadata = {}) => {
  const key = getDraftKey(uid, topicId);
  const data = { uid, topicId, content, metadata, updated_at: Date.now() };
  localStorage.setItem(key, JSON.stringify(data));
};

export const deleteDraftPost = async (uid, topicId) => {
  const key = getDraftKey(uid, topicId);
  localStorage.removeItem(key);
};

export const publishDraft = async (uid, topicId) => {
  const key = getDraftKey(uid, topicId);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const draft = JSON.parse(raw);
  const post = await createPost({
    topic_id: topicId,
    content: draft.content,
    author_id: uid
  });
  localStorage.removeItem(key);
  return post;
};

// ── Navigation & Post Locating ───────────────────────────────────────────────

// locatePost finds which page holds a post, so a deep link can open the exact
// topic, page and post.
//
// It CANNOT be an arithmetic lookup any more. The old version read the post's
// `sequence` and divided it by the page size, which was only correct while
// every post had a stable ordinal — and a hard delete destroys that property:
// removing one post shifts every later ordinal, so a link built before a delete
// would open the wrong page afterwards.
//
// So the page is DISCOVERED by walking the topic's pages and looking for the
// id. `startPage` is the page the reader is already on, and it is searched
// first: the common case is a link to a post in the thread being read, and
// starting there makes it one request instead of a walk from page 1.
//
// The walk is bounded by `maxPages` so a stale link to a deleted post cannot
// page through an entire 5000-post topic before giving up.
export const locatePost = async (postId, itemsPerPage = 20, startPage = 1, maxPages = 40) => {
  try {
    const postRecord = await pb.collection('posts').getOne(postId);
    if (!postRecord) return null;

    const topicId = postRecord.topic_id;
    if (!topicId) return null;

    const first = Math.max(1, startPage || 1);
    for (let page = first; page < first + maxPages; page += 1) {
      const res = await sendApi(
        `/api/aerun/topics/${topicId}/posts?limit=${itemsPerPage}&page=${page}`
      );
      // The Go command layer answers with `items` (forum_posts.go
      // listPostsHandler). Read that, not the PocketBase SDK shape.
      const items = res?.items || [];
      if (items.length === 0) break;
      if (items.some((p) => p && p.id === postId)) {
        return { topicId, page, postId };
      }
    }
    return null;
  } catch (err) {
    console.error('[locatePost error]', err);
    return null;
  }
};

export const locateUnreadPost = async (_topicId, _lastVisitMs, _itemsPerPage = 20) => {
  return 1;
};

// ── Mutations ────────────────────────────────────────────────────────────────

// `performerId` / `authorId` / `topicUpdates` are no longer read: the Go
// backend derives the actor from the auth token and writes the audit row
// inside the same transaction (see forum_posts.go / forum_topics.go). The
// parameters stay so call sites do not change.
export const updatePost = async (postId, content, _metadata = {}, _performerId, _authorId, _topicUpdates = null) => {
  const { content: processedContent } = processDiceRolls(content);
  return await sendApi(`/api/aerun/posts/${postId}`, {
    method: 'PATCH',
    body: {
      content: processedContent.trim()
    }
  });
};

export const updateTopic = async (topicId, data, _performerId, _authorId) => {
  const body = {};
  if (data.title !== undefined) body.title = data.title;
  if (data.is_locked !== undefined) body.locked = data.is_locked;
  if (data.is_pinned !== undefined) body.pinned = data.is_pinned;

  return await sendApi(`/api/aerun/topics/${topicId}`, {
    method: 'PATCH',
    body
  });
};

export const deletePost = async (post, _performerId) => {
  return await sendApi(`/api/aerun/posts/${post.id}`, {
    method: 'DELETE'
  });
};

export const updateUser = async (uid, userData, _performerId) => {
  // `last_selected_character_id` used to be saved HERE, and that was the wrong
  // route: this targets PATCH /admin/users/{id}, which requires admin_access and
  // carries only role and status. Picking a character to post as answered 403
  // for every ordinary member — and it sits in the reply and topic forms, so it
  // was broken in the core posting flow, not an edge case.
  //
  // Choosing a mask is the author's own business, so it goes to /me/profile,
  // which accepts it on the self path only.
  if (userData && Object.keys(userData).length === 1 && 'last_selected_character_id' in userData) {
    return await sendApi(`/api/aerun/me/profile`, {
      method: 'PATCH',
      body: { last_selected_character_id: userData.last_selected_character_id }
    });
  }

  return await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: userData
  });
};

export const checkNicknameExists = async (nickname, excludeUid = null) => {
  if (!nickname) return false;
  try {
    const cleanNick = nickname.trim().toLowerCase();
    const records = await pb.collection('users').getList(1, 1, {
      filter: `nickname_normalized = "${cleanNick}"`
    });
    if (records.items.length === 0) return false;
    if (excludeUid && records.items[0].id === excludeUid) return false;
    return true;
  } catch {
    return false;
  }
};

export const deleteTopics = async (topicIds, _performerId) => {
  for (const id of topicIds) {
    await sendApi(`/api/aerun/topics/${id}`, {
      method: 'DELETE'
    });
  }
};

export const moveTopics = async (topicIds, targetCategoryId, _performerId) => {
  for (const id of topicIds) {
    await sendApi(`/api/aerun/topics/${id}/move`, {
      method: 'POST',
      body: {
        category_id: targetCategoryId
      }
    });
  }
};

export const movePosts = async (postIds, targetTopicId, _performerId) => {
  return await sendApi(`/api/aerun/topics/${targetTopicId}/posts/move`, {
    method: 'POST',
    body: {
      target_topic_id: targetTopicId,
      post_ids: postIds
    }
  });
};

export const createTopicFromPosts = async (postIds, topicData, performerId) => {
  const newTopic = await sendApi('/api/aerun/topics', {
    method: 'POST',
    body: {
      category_id: topicData.category_id,
      title: topicData.title,
      content: 'Topic created from moved posts'
    }
  });

  const newTopicId = newTopic?.topic?.id || newTopic?.id;
  await movePosts(postIds, newTopicId, performerId);
  return newTopicId;
};

export const batchUpdateTopics = async (topicIds, data, performerId) => {
  for (const id of topicIds) {
    await updateTopic(id, data, performerId);
  }
};
