import { sendApi, pb } from './pocketbase';
import { processDiceRolls } from '../utils/dice';

// normalizeTopic maps a server topic row onto the field names the renderers
// read. EXPORTED because three different topic lists exist (the category page,
// /active-topics and the new-replies feed) and each one used to hand its rows to
// a renderer raw — `res.items.map(...)` in two places and no mapping at all in
// the third. Any list that skips this renders `—` for its timestamp and loses
// its pin icon, so the mapping lives here once and every list must go through it.
export const normalizeTopic = (t) => {
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
      // The command layer answers `items` (forum_topics.go listTopicsHandler).
      // Reading `topics`/`pinned` — the retired Firestore callable's shape —
      // always yielded undefined, so this subscription reported "no topics"
      // for every category no matter what was stored.
      callback((res?.items || []).map(normalizeTopic));
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

// fetchSecuredTopics reads one page of a category's topics.
//
// The server returns a single `items` list already ordered pinned-first
// (listTopicsHandler: `pinned DESC, last_post_created DESC, id DESC`). Pinned
// topics are therefore split out HERE rather than asked for separately: the
// page component renders them in their own section, and the ordering guarantee
// is the server's, so re-sorting on the client would only risk disagreeing
// with it.
//
// `total` is the count over the whole filter, not this page — it is what the
// pager divides by. Reading `res.topics` (the retired callable's key) made both
// arrays empty and the total zero, so the category page rendered as empty and
// the pager rendered as a single page.
export const fetchSecuredTopics = async (categoryId, page = 1, pageSize = 20) => {
  const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&page=${page}&limit=${pageSize}`);
  const items = (res?.items || []).map(normalizeTopic);
  return {
    pinned: items.filter(t => t.is_pinned),
    topics: items.filter(t => !t.is_pinned),
    total: res?.total ?? items.length,
    page: res?.page || page,
    limit: res?.per_page || pageSize
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
      const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&limit=1`);
      if (!isSubscribed) return;
      const topic = res?.items?.[0] || null;
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

// createTopic posts a new topic together with its opening message.
//
// The command layer answers `{ topic, first_post, post, topic_id }`. This
// function normalises that into the shape the form consumes and — importantly —
// THROWS when the server did not return an id.
//
// It used to return `{ id, topic, post }` while the form read `topicId`, so
// `navigate` received undefined and the member landed on /topic/undefined,
// where the topic-not-found card greeted a topic that had in fact been created
// successfully. A missing id is now an error the caller shows, not a URL.
export const createTopic = async (topicData, firstPostData) => {
  const { content: processedContent } = processDiceRolls(firstPostData.content);

  const res = await sendApi('/api/aerun/topics', {
    method: 'POST',
    body: {
      category_id: topicData.category_id,
      title: topicData.title,
      content: processedContent.trim(),
      // Both of these used to be dropped on the floor. The form held
      // `selectedCharacterId` and `pinFirstPost` in state and sent neither, so
      // the server had nothing to record: every message came out under the
      // account's own name no matter which mask the author had picked, and the
      // "Pin first post" checkbox was decorative.
      //
      // `character_id` travels as the PICKED mask and the server decides what to
      // honour (resolveAuthorCharacter), so the browser cannot post as somebody
      // else's character by editing this request.
      character_id: topicData.character_id || '',
      pin_first_post: !!topicData.pin_first_post,
    }
  });

  const id = res?.topic?.id || res?.topic_id || '';
  if (!id) {
    // The write already happened; only the response was unusable. Saying so
    // matters: a plain "failed" would send the member off to retry and create
    // the topic twice.
    const err = new Error('The topic was created but the server did not return its id.');
    err.code = 'missing_topic_id';
    throw err;
  }

  return {
    id,
    topic: normalizeTopic(res?.topic),
    post: normalizePost(res?.first_post || res?.post)
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
      // `items`, per forum_posts.go listPostsHandler — the same key the topic
      // list uses. `posts` was the retired callable's name and is always absent.
      callback((res?.items || []).map(normalizePost));
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

// fetchSecuredPosts reads one page of a topic's posts.
//
// `posts_count` (not `total`) is the server's own name for the window size, and
// `per_page` for the page size. The old `res.posts` read is why an existing
// topic rendered with no messages: the key is never present, so every page came
// back as an empty array regardless of what the topic held.
export const fetchSecuredPosts = async (topicId, page = 1, pageSize = 20, _lastVisit = null) => {
  const res = await sendApi(`/api/aerun/topics/${topicId}/posts?page=${page}&limit=${pageSize}`);
  const items = (res?.items || []).map(normalizePost);
  return {
    posts: items,
    total: res?.posts_count ?? items.length,
    page: res?.page || page,
    limit: res?.per_page || pageSize
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
      content: processedContent.trim(),
      // The reply composer's mask picker, sent for the same reason the topic
      // form's is. Empty falls back to the mask stored on the profile, which is
      // what the picker writes when the author selects one.
      character_id: postData.character_id || '',
    }
  });

  // The reply path navigates to the new post by id, and it used to read
  // `postId` — a camelCase key no route has ever sent. The reply therefore
  // created correctly and the page then refused to scroll to it, because the
  // target it remembered was undefined. The server sends the id twice, as
  // `post_id` and inside the post object; accept either.
  const post = normalizePost(res?.post);
  return { ...post, postId: res?.post_id || post?.id || '' };
};

// ── Draft Posts ─────────────────────────────────────────────────────────────
//
// These used to be localStorage under `aerun_draft_${topicId}_${uid}`, a
// leftover from before the drafts migration. Three defects came from that, all
// reported together:
//
//   - createDraftPost wrote the key and notified nobody, while
//     subscribeToTopicDraft read it ONCE on mount, so a draft saved from the
//     page never appeared until a reload, and an edit never appeared at all;
//   - updateDraftPost stored a COMPLETELY different shape ({uid, topicId,
//     content, metadata}) than createDraftPost had stored, so the first edit
//     discarded every author_* field. The card then rendered its fallback
//     author: "Guest", no avatar, 0 posts.
//   - buildPostData never set `is_draft`, so `deletingPost.is_draft` was falsy
//     and Delete took the real-post branch, calling deletePost on an id that
//     was never a post.
//
// None of that is fixable by patching the localStorage helpers. The server
// already owns drafts — one per author per topic, enforced by a unique index —
// and nothing in the browser ever called it.

// getTopicDraft reads the caller's draft in a topic, or null.
export const getTopicDraft = async (topicId) => {
  if (!topicId) return null;
  const res = await sendApi(`/api/aerun/topics/${topicId}/draft`);
  return res?.draft || null;
};

// saveTopicDraft creates or replaces the caller's draft in a topic.
//
// `characterId` is the picked mask and is NOT optional in spirit: the server
// stores it on the draft row (ownership-checked there) and publish promotes the
// row verbatim. Sending the text alone filed every draft under the account, so
// publishing it produced a post with no mask — the reported "маска слетела".
export const saveTopicDraft = async (topicId, content, characterId = '') => {
  const res = await sendApi(`/api/aerun/topics/${topicId}/draft`, {
    method: 'PUT',
    body: { content: (content || '').trim(), character_id: characterId || '' },
  });
  return res?.draft || null;
};

export const deleteDraft = async (draftId) => {
  if (!draftId) return;
  await sendApi(`/api/aerun/drafts/${draftId}`, { method: 'DELETE' });
};

// publishDraft promotes a draft to a real post. The server owns the whole
// transition — sequence, counters, projections, notifications — so this must
// not be faked by calling createPost and dropping the row: that would publish
// under whatever identity the client sent and leave the topic counters to be
// corrected by hand afterwards.
export const publishDraft = async (draftId) => {
  if (!draftId) return null;
  const res = await sendApi(`/api/aerun/drafts/${draftId}/publish`, { method: 'POST' });
  // Same contract as createPost: the decorated post under `post`, the bare id
  // under both `post_id` and `postId`. The page calls navigateToCreatedPost
  // with whatever it finds, and the decorated fields are what the fresh post
  // renders from — reading a raw payload here is what made the published draft
  // come out under the account name instead of the mask.
  const post = normalizePost(res?.post);
  return { ...post, postId: res?.post_id || post?.id || '' };
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
export const updatePost = async (postId, content, metadata = {}, _performerId, _authorId, _topicUpdates = null) => {
  const { content: processedContent } = processDiceRolls(content);
  const body = { content: processedContent.trim() };

  // The edit form's mask picker used to be dropped here: `metadata` was named
  // `_metadata` and never read, so the server received only `content` and the
  // picker repainted the card optimistically and then reverted on the next
  // reload. `character_id` is sent ONLY when the metadata actually carries a
  // changed mask — an always-present key would ask the server to re-file every
  // edited post, including edits that never touched the picker.
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'author_character_id')) {
    body.character_id = metadata.author_character_id || '';
  }

  const res = await sendApi(`/api/aerun/posts/${postId}`, {
    method: 'PATCH',
    body
  });
  // Decorated post + bare id, matching createPost/publishDraft.
  const post = normalizePost(res?.post);
  return { ...post, postId: res?.post_id || post?.id || postId };
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

// The uniqueness key must be the SAME one the server stores.
//
// The server derives `users.nickname_normalized` with Unicode NFKC, lowercasing
// and whitespace COLLAPSING (internal/auth/nickname.go, NormalizeNickname).
// This used to use `.trim().toLowerCase()`, which disagrees in two ways that
// matter:
//
//   - NFKC folds presentation variants, so a fullwidth "Ａ" collides with "a"
//     server-side but not here.
//   - The server COLLAPSES runs of whitespace and the client did not, so
//     "Player  One" was free to the client and taken by the server.
//
// The pre-check is only a convenience — the UNIQUE index stays the real
// enforcement — so a mismatch showed up as a nickname passing this check and
// then being refused by the server, which reads as the form lying to the user.
export const nicknameKey = (value) =>
  (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export const checkNicknameExists = async (nickname, excludeUid = null) => {
  if (!nickname) return false;
  try {
    const key = nicknameKey(nickname);
    const records = await pb.collection('users').getList(1, 1, {
      filter: `nickname_normalized = "${key.replace(/"/g, '\\"')}"`
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
