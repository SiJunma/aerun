import { sendApi } from './pocketbase';
import { getOrCreateSessionId } from '../utils/telemetrySession';
import { sharedPoll } from './shared-poll';
import { subscribeToRealtimeSignals, canReceiveSignals } from './realtime-signals';
import { toMillis } from '../utils/dates';

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
    posts_count: t.posts_count || 1,
    is_pinned: !!(t.pinned || t.is_pinned),
    is_locked: !!(t.locked || t.is_locked),
    created_at: createdDate,
    last_post_at: lastPostDate,
    created_at_ms: createdDate ? toMillis(createdDate) : 0,
    last_post_at_ms: lastPostDate ? toMillis(lastPostDate) : 0,
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
    guest_nickname: p.guest_nickname || '',
    content: p.content || '',
    created_at: p.created,
    updated_at: p.updated,
    edited_at: p.edited_at || p.edited || null,
    editor_id: p.editor_id || null,
    created_at_ms: p.created ? new Date(p.created).getTime() : 0,
  };
};

// ── Topics ───────────────────────────────────────────────────────────────────

export const subscribeToTopics = (categoryId, callback) => {
  if (!categoryId) {
    callback([]);
    return () => {};
  }

  // Keyed per category: the index and the category page both read this, and a
  // member bouncing between them was paying for two loops over one endpoint.
  const poll = sharedPoll(`topics:${categoryId}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&limit=100`);
      // The command layer answers `items` (forum_topics.go listTopicsHandler).
      // Reading `topics`/`pinned` — the retired Firestore callable's shape —
      // always yielded undefined, so this subscription reported "no topics"
      // for every category no matter what was stored.
      return (res?.items || []).map(normalizeTopic);
    },
    intervalMs: 15000,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToTopics err]', err),
  });

  return poll.subscribe((topics) => callback(topics));
};

export const subscribeToTopic = (topicId, callback) => {
  if (!topicId) {
    callback(null, null);
    return () => {};
  }

  const poll = sharedPoll(`topic:${topicId}`, {
    fetch: async () => normalizeTopic((await sendApi(`/api/aerun/topics/${topicId}`))?.topic),
    intervalMs: 15000,
    initialValue: null,
  });

  // The (data, err) SHAPE is TopicPage's access contract and is preserved exactly:
  // a 404/403 means "not visible to you" and renders the not-found card, while any
  // other failure is a real error. Only the TIMER changed.
  return poll.subscribe((topic, err) => {
    if (!err) {
      callback(topic, null);
    } else if (err?.status === 404 || err?.status === 403) {
      callback(null, null);
    } else {
      callback(null, err);
    }
  });
};

// fetchTopic is the ONE-SHOT full-topic read: title, decoration, pins —
// everything the page renders but never re-polls.
//
// WHY IT EXISTS. subscribeToTopic above still owns a 15s loop, and TopicPage
// used to live on it. Freshness now lives on subscribeToTopicStats (six
// fields), so the full payload must be read ONCE per topic open — not on a
// timer. Keeping the loop subscribed "just in case" would bill the member
// for the ~1.2 KB this whole step exists to stop paying for.
//
// The (data, err) SHAPE matches subscribeToTopic exactly: null data means
// "not visible to you" (404/403), a thrown error means a real failure — so
// the page's access contract does not change with the transport.
export const fetchTopic = async (topicId) => {
  if (!topicId) return null;
  try {
    const res = await sendApi(`/api/aerun/topics/${topicId}`);
    if (res?.deleted) return null;
    return normalizeTopic(res?.topic);
  } catch (err) {
    if (err?.status === 404 || err?.status === 403) return null;
    throw err;
  }
};

// fetchTopicStats reads GET /api/aerun/topics/{id}/stats — the topic page's
// freshness read ("did this topic change while I was reading it").
//
// WHY IT EXISTS. The 15s poll used to re-read the WHOLE topic (~1.2 KB of
// author decoration TopicPage never reads) just to compare posts_count,
// last_post_id and last_post_at. This answers only that, plus `locked`:
// the is_locked reply gate is refreshed by the same poll, and without the
// flag a moderator closing the topic leaves readers at a live form.
//
// The wire shape is normalised onto the SAME field names the page compares
// and renders (title, category_id, is_locked, is_pinned, created_at, etc.),
// so TopicPage can render and maintain freshness without the ~1.2 KB full topic read.
export const fetchTopicStats = async (topicId) => {
  if (!topicId) return null;
  const res = await sendApi(`/api/aerun/topics/${topicId}/stats`);
  if (!res) return null;
  // Deleted / missing topic answers 200 {deleted: true} instead of a cascade
  // of 404s. Fold into null so the page renders the "Topic Not Found" card
  // via the existing !stats branch in TopicPage. A restricted topic also
  // answers 200 {deleted: true, restricted: true} — that is folded into a
  // stats object carrying the restricted flag so the client can show
  // "Access denied" instead of "Topic not found".
  if (res.deleted && !res.restricted) return null;
  const createdDate = res.created || res.created_at || null;
  const lastPostDate = res.last_post_at || res.last_post_created || createdDate;
  return {
    ...res,
    id: res.topic_id || topicId,
    category_id: res.category_id,
    title: res.title,
    posts_count: res.posts_count ?? 0,
    is_pinned: !!(res.pinned || res.is_pinned),
    is_locked: !!(res.locked || res.is_locked),
    first_post_pinned: !!res.first_post_pinned,
    created: createdDate,
    created_at: createdDate,
    last_post_id: res.last_post_id || null,
    last_post_at: lastPostDate,
    created_at_ms: createdDate ? new Date(createdDate).getTime() : 0,
    last_post_at_ms: lastPostDate ? new Date(lastPostDate).getTime() : 0,
  };
};

// subscribeToTopicStats is the 15s freshness LOOP over fetchTopicStats.
//
// Realtime-driven with polling as the fallback (owner ruling, F5): the
// server publishes a `topic.post` signal on every post write
// (realtime_signals.go publishTopicSignal), shared-poll drops the interval
// the moment the stream connects, and a member with a healthy stream pays no
// polling. Restricted categories publish NO signal, so their readers keep
// the 15s interval — the correct degradation: slower, never wrong.
//
// The resource name carries the topic id: two open topics are two loops,
// and leaving a thread releases its loop when the last subscriber goes.
export const subscribeToTopicStats = (topicId, callback) => {
  if (!topicId) {
    callback(null, null);
    return () => {};
  }

  const poll = sharedPoll(`topic-stats:${topicId}`, {
    fetch: () => fetchTopicStats(topicId),
    intervalMs: 15000,
    initialValue: null,
    // 403 is a truthful server answer (restricted category), not a failure —
    // no point flooding the console with it on every 15s poll.
    onError: (err) => {
      if (err?.status !== 403) {
        console.warn('[subscribeToTopicStats err]', err);
      }
    },
    realtime: canReceiveSignals()
      ? (onDelivered, onDead, onStateChange) => subscribeToRealtimeSignals(
        (signalTopic, entityId) => {
          // Discard DM events or post events specifically targeted at other topics
          if (signalTopic === 'topic.post' && entityId && entityId !== topicId) return;
          if (signalTopic === 'dm.post') return;
          // A read receipt is counters-only: somebody catching up on their inbox
          // changes no topic, so the stats re-read it would trigger is pure waste.
          // Listed beside the dm.post guard — the two DM topics live and die together.
          if (signalTopic === 'dm.read') return;
          onDelivered();
        },
        () => onDead(),
        onStateChange,
      )
      : null,
  });

  // Same (data, err) SHAPE as subscribeToTopic: 404/403 means "not visible
  // to you". 404 keeps the topic-not-found card (topic is gone). 403 means
  // the topic exists but the caller's role is not in the category's
  // allowed_roles — the caller must see "access denied", not "not found",
  // so the raw error is passed through with its status intact.
  return poll.subscribe((stats, err) => {
    if (!err) {
      callback(stats, null);
    } else if (err?.status === 404) {
      callback(null, null);
    } else {
      callback(null, err);
    }
  });
};

// fetchTopicContext reads GET /api/aerun/topics/{id}/context — the topic
// page's ONE caller-scoped read (draft, subscription, and votes).
//
// Replaces three separate mount calls: GET /topics/:id/draft,
// GET /topics/:id/subscription, and GET /me/votes?topic_id=.
// Normalises `votes` into a { [post_id]: voteObj } map, matching the
// getVotesInTopic contract so TopicPage's state setter and renderers stay untouched.
export const fetchTopicContext = async (topicId) => {
  if (!topicId) return { draft: null, subscribed: false, votes: {} };
  const res = await sendApi(`/api/aerun/topics/${topicId}/context`);
  if (res?.deleted) {
    return {
      draft: null,
      subscribed: false,
      votes: {},
      deleted: true,
    };
  }
  const votesMap = {};
  (res?.votes || []).forEach((r) => {
    if (r.post_id) {
      votesMap[r.post_id] = {
        id: r.id,
        ...r,
      };
    }
  });
  return {
    draft: res?.draft || null,
    subscribed: !!res?.subscribed,
    votes: votesMap,
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
  // `pinned_first=1` is what makes the server rank pinned topics above the rest
  // for THIS screen, and it is a deliberate, explicit request. The same endpoint
  // also backs subscribeToTopics (the index's per-category cards) and the global
  // feeds, which must stay in pure recency order — so the pin is never inferred
  // from the category_id alone. Here it IS the category page's topic table, so
  // the flag belongs. Paging stays offset-based on the server (page + limit).
  const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&pinned_first=1&page=${page}&limit=${pageSize}`);
  const items = (res?.items || []).map(normalizeTopic);
  return {
    pinned: items.filter(t => t.is_pinned),
    topics: items.filter(t => !t.is_pinned),
    total: res?.total ?? items.length,
    page: res?.page || page,
    limit: res?.per_page || pageSize,
    restricted: res?.restricted || false,
    message: res?.message || ''
  };
};

export const subscribeToLastTopicInCategory = (categoryId, callback) => {
  if (!categoryId) {
    callback(null);
    return () => {};
  }

  // This exists only to keep the category card's last-post cell fresh, which is
  // the slowest-changing fact on the page — hence the long interval.
  const poll = sharedPoll(`last-topic:${categoryId}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/topics?category_id=${categoryId}&limit=1`);
      return normalizeTopic(res?.items?.[0] || null);
    },
    intervalMs: 25000,
    initialValue: null,
  });

  return poll.subscribe((topic) => callback(topic));
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
  // SEC-08: raw body only; the server throws [dice=N] with crypto/rand.

  const res = await sendApi('/api/aerun/topics', {
    method: 'POST',
    body: {
      category_id: topicData.category_id,
      title: topicData.title,
      // The topic's short subtitle ("Краткое описание"). Dropped here before:
      // the create form held it in state and sent it, but this body never
      // forwarded it, so the server stored an empty description and the
      // header/category list lost it on every reload.
      description: topicData.description || '',
      content: firstPostData.content.trim(),
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
      // A guest posts without an account, so their chosen display name travels
      // here for the server to store on the topic and opening post. Empty for
      // authenticated users.
      guest_nickname: topicData.guest_nickname || '',
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

  // Keyed per topic, so leaving a thread releases its loop immediately instead of
  // leaving a 10-second timer reading a topic nobody is looking at.
  const poll = sharedPoll(`posts:${topicId}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/topics/${topicId}/posts?limit=100`);
      // `items`, per forum_posts.go listPostsHandler — the same key the topic
      // list uses. `posts` was the retired callable's name and is always absent.
      return (res?.items || []).map(normalizePost);
    },
    intervalMs: 10000,
    initialValue: [],
  });

  return poll.subscribe((posts) => callback(posts));
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
//
// If `targetPostId` is provided, the server resolves the exact page holding that
// post using an index-backed SQL COUNT and immediately returns that page's items,
// avoiding client-side loops or separate locate round-trips.
export const fetchSecuredPosts = async (topicId, page = 1, pageSize = 20, lastVisit = null, targetPostId = null) => {
  let qs = `limit=${pageSize}`;
  if (targetPostId) {
    qs += `&post=${encodeURIComponent(targetPostId)}`;
    if (page && !['last', 'latest', 'unread'].includes(String(page))) {
      qs += `&page=${encodeURIComponent(page)}`;
    }
  } else {
    qs += `&page=${encodeURIComponent(page || 1)}`;
  }
  if (lastVisit && ['last', 'latest', 'unread'].includes(String(page))) {
    qs += `&last_visit=${encodeURIComponent(lastVisit)}`;
  }
  const sid = getOrCreateSessionId();
  if (sid) {
    qs += `&session_id=${encodeURIComponent(sid)}`;
  }
  const res = await sendApi(`/api/aerun/topics/${topicId}/posts?${qs}`);
  if (res?.deleted) {
    return {
      posts: [],
      total: 0,
      page: 1,
      limit: pageSize,
      deleted: true,
      readCutoff: null,
      targetPostId: null,
      targetFound: null,
      movedToTopicId: null,
      pinnedPost: null,
    };
  }
  const items = (res?.items || []).map(normalizePost);
  return {
    posts: items,
    total: res?.posts_count ?? items.length,
    page: res?.page || page || 1,
    limit: res?.per_page || pageSize,
    // Present only in the goLast modes: the read cutoff the SERVER resolved the
    // page against (its own topic_read_states row, not our localStorage map).
    readCutoff: res?.read_cutoff || null,
    targetPostId: res?.target_post_id || null,
    targetFound: res?.target_found ?? null,
    movedToTopicId: res?.moved_to_topic_id || null,
    pinnedPost: res?.pinned_post ? normalizePost(res.pinned_post) : null
  };
};

// The Posts tab of a profile.
//
// It used to read the posts collection straight from the browser SDK. Migration
// 1766100000 locked the forum collections to superusers (lockBrowserRules), so
// that call failed with 403 "Only superusers can perform this action" for every
// ordinary member AND every guest — and the catch below turned the failure into
// an empty list, which the page renders as "this person has written nothing".
// The 403 was in the console and the UI claimed the opposite.
//
// The read goes through the command layer like every other forum read now, which
// is also why the previews resolve their dice: the endpoint returns the same
// decorated post shape the topic feed serves, `rolls` included.
// `postFilter` is 'all' (default), 'account' for posts written without a mask,
// or 'char_<id>' for one mask — the dropdown's own keys.
//
// This used to be `_postFilter`: the parameter was named as deliberately unused
// and the filter never left the browser, so picking a mask relabelled the same
// list. It has to be a QUERY parameter, not a post-hoc filter of the returned
// rows, because this endpoint is paginated: the server owns `total` and the page
// numbering, so a client-side filter would page through already-filtered results
// against an unfiltered total and silently skip posts.
export const fetchUserPosts = async (targetUid, page = 1, pageSize = 20, postFilter = 'all') => {
  if (!targetUid) {
    return { posts: [], total: 0, page: 1, totalPages: 0 };
  }
  // A key the dropdown cannot produce would be a silent no-op again, so only the
  // two non-default axes are sent; 'all' stays absent to keep the URL clean.
  const filter = postFilter === 'account' || /^char_[A-Za-z0-9_-]+$/.test(postFilter)
    ? `&filter=${encodeURIComponent(postFilter)}`
    : '';
  try {
    const res = await sendApi(`/api/aerun/users/${targetUid}/posts?page=${page}&limit=${pageSize}${filter}`);
    const items = (res?.items || []).map(normalizePost);
    return {
      posts: items,
      total: res?.total ?? items.length,
      page: res?.page || page,
      totalPages: res?.total_pages ?? 0
    };
  } catch (err) {
    // The empty shape keeps the page renderable, but the message must survive:
    // a swallowed 403 is exactly what made this look like "no posts" instead of
    // "the request was refused", which is the harder bug to notice.
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
  // SEC-08: the server decides the dice values (crypto/rand).
  //
  // The old path ran processDiceRolls here and sent the map it produced —
  // the browser decided the outcome and the server merely range-checked
  // it. That is the forgery this step removed: a client could submit any
  // value in 1..sides and have it rendered to every reader.
  //
  // The body is therefore sent UNSCANнed: the reply path (useTopicMutations)
  // sent already-processed content with an optimistic map, and re-scanning
  // here finds no [dice] tags, yields an empty map, and wipes the throws
  // again. When the caller passes rolls, we DROP them — the server has no
  // map from them. We send only the body; the server parses [dice=N] and
  // builds the real map with crypto/rand.
  //
  // The optimistic card keeps its placeholder: src/utils/dice.js still
  // rewrites [dice] into [roll=id] for the card to paint, but its `rolls`
  // map is provisional and never becomes the form body.
  const res = await sendApi(`/api/aerun/topics/${postData.topic_id}/posts`, {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: {
      content: postData.content.trim(),
      // The reply composer's mask picker, sent for the same reason the topic
      // form's is. Empty falls back to the mask stored on the profile, which is
      // what the picker writes when the author selects one.
      character_id: postData.character_id || '',
      // Guests post without an account; their display name travels here so the
      // server can store it on the post row (guest_nickname column).
      guest_nickname: postData.guest_nickname || '',
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
export const saveTopicDraft = async (topicId, content, characterId = '', rolls = null) => {
  const res = await sendApi(`/api/aerun/topics/${topicId}/draft`, {
    method: 'PUT',
    body: {
      content: (content || '').trim(),
      character_id: characterId || '',
      // Publishing promotes the draft row verbatim, so the throws have to be on
      // it — a draft saved with dice and published without them produced a post
      // carrying `[roll=…]` tags nobody could resolve.
      ...(rolls && Object.keys(rolls).length > 0 ? { rolls } : {})
    },
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
// Powered by the unified server endpoint `GET /api/aerun/topics/:id/posts?post=:postId`,
// which computes the page server-side via SQL COUNT in a single fast query rather than
// walking pages from the browser.
export const locatePost = async (postId, itemsPerPage = 20, knownTopicId = null) => {
  try {
    let topicId = knownTopicId;
    if (!topicId) {
      const res = await sendApi(`/api/aerun/posts/${postId}`);
      const postRecord = res?.post;
      if (!postRecord) return null;
      topicId = postRecord.topic_id;
      if (!topicId) return null;
    }

    const res = await fetchSecuredPosts(topicId, 1, itemsPerPage, null, postId);
    if (!res || res.targetFound === false) {
      if (res?.movedToTopicId) {
        return locatePost(postId, itemsPerPage, res.movedToTopicId);
      }
      return null;
    }
    const page = res.page;
    return { topicId, page, postId };
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
  // SEC-08: edit sends the RAW body (with [dice=N] tags intact), exactly
  // as on create. The server:
  //   - freezes the values of already-stored rolls (an incoming roll id
  //     whose entry differs from what's stored is rejected), and
  //   - throws each fresh [dice=N] tag with crypto/rand.
  // Merging client-side (existing + fresh) built a map from optimistic
  // client values and sent them to the server to be validated — the
  // forgery the freeze exists to catch. No client map is sent at all
  // now; the server has the stored map and re-rolls the fresh tags.
  const body = { content: content.trim() };

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
  // The in-topic pin of the OPENING post (`first_post_pinned`) is a first-class
  // key of the server's updateTopicForm (a *bool: absent = untouched). This
  // whitelist used to carry only title/locked/pinned, so the hook's flag was
  // dropped HERE — PATCH /topics arrived as {title} and the edit form's
  // checkbox silently did nothing, no matter what the hook above it sent.
  if (data.first_post_pinned !== undefined) body.first_post_pinned = data.first_post_pinned;
  // The topic's short subtitle ("Краткое описание"): the first-post editor
  // edits it together with the title. The server validates and stores it
  // (topics.description, max 200); dropped by the whitelist until Session 37.
  if (data.description !== undefined) body.description = data.description;

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

// A yes/no question, answered by a boolean.
//
// THIS USED TO BE `pb.collection('users').getList(1, 1, { filter: … })`, which
// answered it with a WHOLE auth record: a guest typing a nickname into the
// registration form received a stranger's `settings` and email as the price of a
// boolean. The server now normalises the name itself — see
// GET /api/aerun/nicknames/check — which also removes the client/server
// normaliser skew described above `nicknameKey`, since the check and the UNIQUE
// index now use one implementation.
//
// The pre-check is still only a convenience: the index remains the enforcement,
// so a race between the check and the rename still ends in a server refusal.
export const checkNicknameExists = async (nickname, excludeUid = null) => {
  if (!nickname) return false;
  try {
    const query = new URLSearchParams({ nickname });
    if (excludeUid) query.set('exclude', excludeUid);
    const res = await sendApi(`/api/aerun/nicknames/check?${query.toString()}`);
    return res?.available === false;
  } catch {
    // Unreachable answers "free", which is what the pre-check is for: the
    // server refuses the duplicate anyway. Failing closed here would block a
    // perfectly legal name whenever the route is unreachable.
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

// The route is /topics/{SOURCE}/posts/move: the path carries the topic the
// posts LEAVE, the body carries the topic they arrive at. Swapping them made
// the server see source == target and refuse every move.
export const movePosts = async (postIds, sourceTopicId, targetTopicId, _performerId) => {
  return await sendApi(`/api/aerun/topics/${sourceTopicId}/posts/move`, {
    method: 'POST',
    body: {
      target_topic_id: targetTopicId,
      post_ids: postIds
    }
  });
};

export const createTopicFromPosts = async (postIds, sourceTopicId, topicData, performerId) => {
  const newTopic = await sendApi('/api/aerun/topics', {
    method: 'POST',
    body: {
      category_id: topicData.category_id,
      title: topicData.title,
      content: 'Topic created from moved posts'
    }
  });

  const newTopicId = newTopic?.topic?.id || newTopic?.id;
  await movePosts(postIds, sourceTopicId, newTopicId, performerId);
  return newTopicId;
};

export const batchUpdateTopics = async (topicIds, data, performerId) => {
  for (const id of topicIds) {
    await updateTopic(id, data, performerId);
  }
};

// ── The drafts feed ──────────────────────────────────────────────────────────
//
// listMyDrafts is the drafts page's own read: this caller's drafts, orphans
// first.
//
// The server already partitions them — an `orphan` flag per item, orphans sorted
// ahead of the live ones — so this normalises rather than re-derives. A second
// sort here would be a second ordering rule to keep in step with the server's,
// and the two would disagree the first time either changed.
export const listMyDrafts = async () => {
  const res = await sendApi('/api/aerun/me/drafts');
  return (res?.items || []).map(normalizePost);
};
