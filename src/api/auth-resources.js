import { sendApi, pb } from './pocketbase';
// normalizeTopic is imported, not re-implemented: the topic lists here must
// render the same rows as the category page, and a second copy of this mapping
// is exactly how the two drifted apart in the first place.
import { normalizeTopic } from './forum';
import { recordAvatarUrl, resolveAvatarUrl } from './avatars';
import { sharedPoll } from './shared-poll';

// ── User profile normalisation ──────────────────────────────────────────────

/**
 * normalizeUserProfile maps a PocketBase `users` record onto the field names the
 * pages actually speak.
 *
 * WHY THIS EXISTS. The pages predate the backend and read the Firestore
 * vocabulary: `role_id`, `post_count`, `uid`. PocketBase spells the same facts
 * `role`, `posts_count` and (only) `id`, and nothing in between renames them.
 * Two independent mappers then read different fields and missed different ones:
 *
 *   - subscribeToUser spread the raw record, so every `role_id` read was
 *     undefined. `resolveUserRoleId(undefined)` falls back to 'player', which is
 *     why a member with a custom role was badged "Player"; `post_count` was
 *     undefined for the same reason, so the profile card read 0 posts.
 *   - AuthProvider built the signed-in user's profile from a hand-written
 *     whitelist that listed neither the profile block (bio, location, birthday,
 *     occupation, interests, contacts) nor the real counter names, so opening
 *     Settings on your OWN profile pre-filled every field empty even though the
 *     migrated database held the values.
 *
 * One mapper, used by both, is what stops them drifting apart a second time.
 * The `??` chains read the PocketBase name first and fall back to the legacy
 * one, so a row written before the rename keeps rendering.
 *
 * `status` is carried through unchanged: `banned` and `pending` are ACCOUNT
 * STATUSES, not roles (internal/auth), and a caller that tests them against the
 * role column is testing the wrong axis.
 */
export const normalizeUserProfile = (rec) => {
  if (!rec) return null;
  const settings = rec.settings || {};
  return {
    ...rec,
    uid: rec.uid || rec.id,
    displayName: rec.nickname || rec.displayName || '',
    // The join key on `users` is `role`; `role_id` only exists on `roles`.
    role_id: rec.role ?? rec.role_id ?? 'player',
    // `custom_role_id` is the derived-role companion column. Exposed under the
    // legacy name so a caller never has to know the pair.
    custom_role_id: rec.custom_role_id ?? '',
    avatar_url: recordAvatarUrl(rec) || resolveAvatarUrl(rec.avatar_url),
    post_count: rec.posts_count ?? rec.post_count ?? 0,
    topics_count: rec.topics_count ?? 0,
    reputation: rec.reputation ?? 0,
    status_line: rec.status_line || '',
    bio: rec.bio || '',
    location: rec.location || '',
    birthday: rec.birthday || '',
    occupation: rec.occupation || '',
    interests: rec.interests || '',
    contacts: rec.contacts || '',
    settings
  };
};

// ── Read Map (local / server-side "last visit" tracking) ─────────────────────────────

const getReadMapKey = (uid) => `aerun_readmap_${uid}`;

export const recordTopicVisit = async (uid, topicId, offset = null) => {
  if (!uid || !topicId) return;
  try {
    const key = getReadMapKey(uid);
    const raw = localStorage.getItem(key);
    const map = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    map[topicId] = offset !== null ? { timestamp: now, offset } : now;
    localStorage.setItem(key, JSON.stringify(map));
  } catch (err) {
    console.warn('[recordTopicVisit err]', err);
  }
};

export const subscribeToReadMap = (uid, callback) => {
  if (!uid) {
    callback({});
    return () => {};
  }
  try {
    const key = getReadMapKey(uid);
    const raw = localStorage.getItem(key);
    const map = raw ? JSON.parse(raw) : {};
    callback(map);
  } catch {
    callback({});
  }
  return () => {};
};

export const markAllTopicsRead = async (uid, topicIds) => {
  if (!uid || !topicIds?.length) return;
  try {
    const key = getReadMapKey(uid);
    const raw = localStorage.getItem(key);
    const map = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    topicIds.forEach(id => {
      map[id] = now;
    });
    localStorage.setItem(key, JSON.stringify(map));
  } catch (err) {
    console.warn('[markAllTopicsRead err]', err);
  }
};

// ── Latest Content ─────────────────────────────────────────────────────────

// Both of these read the topic list, which the command layer serves under
// `items`. The `topics` key belongs to the retired Firestore callable and is
// never present, so "Most Active Topics" and the new-replies feed rendered
// empty for every member.
//
// `order_by` is gone from the URL too: listTopicsHandler orders by
// `pinned DESC, last_post_created DESC, id DESC` unconditionally, so the
// parameter never did anything except look like it did.
//
// NORMALISE BEFORE HANDING A ROW TO A RENDERER. This used to pass the raw
// `items` through, and normalizeTopic is what maps the server's own field names
// onto the ones TopicRow reads (`last_post_created` → `last_post_at`,
// `pinned` → `is_pinned`, `created` → `created_at`). Skipping it left every one
// of those undefined, so /active-topics rendered a literal "—" in the last-post
// column with no link at all — the row looked empty rather than wrong, which is
// why it survived review.
export const fetchLatestTopics = async (limitCount = 50) => {
  try {
    const res = await sendApi(`/api/aerun/topics?limit=${limitCount}`);
    return (res?.items || []).map(normalizeTopic);
  } catch (err) {
    console.error('[fetchLatestTopics]', err);
    return [];
  }
};

export const subscribeToLatestTopics = (callback, limitCount = 50) => {
  // The new-replies feed and the "most active" list read the SAME endpoint with
  // the same limit. They had separate loops (20s and 30s) over one resource, so a
  // member with both mounted issued two identical `GET /topics?limit=50` reads
  // on two unrelated clocks. Keyed by limit, the two now share one loop.
  const poll = sharedPoll(`latest-topics:${limitCount}`, {
    fetch: () => fetchLatestTopics(limitCount),
    intervalMs: 20000,
    initialValue: [],
    onError: (err) => console.error('[subscribeToTopTopics]', err),
  });

  return poll.subscribe((topics) => callback(topics));
};

// ── Guest Activity ──────────────────────────────────────────────────────────

export const recordGuestActivity = async (_guestId) => {};

export const deleteGuestActivity = async (_guestId) => {};

// ── Statistics & Global Content ─────────────────────────────────────────────

// subscribeToTopTopics backs the /active-topics list.
//
// It maps through `fetchLatestTopics`, not through its own request, so this page
// cannot drift from the new-replies feed: both render the SAME normalised rows,
// and a fix to one is a fix to both. The previous version issued its own
// `sendApi` and passed `res.items` through raw, which is how that page ended up
// showing "—" where every other topic list showed a timestamp and a link.
export const subscribeToTopTopics = (callback, limitCount = 50) => {
  // It maps through `fetchLatestTopics` rather than issuing its own request, so
  // this page cannot drift from the new-replies feed: both render the SAME
  // normalised rows, and a fix to one is a fix to both.
  //
  // Sharing the resource NAME is the other half of that. It reads exactly what
  // subscribeToLatestTopics reads, so two loops over one endpoint were the same
  // bug as everywhere else in this file — and /active-topics is reachable from
  // the index that also mounts the new-replies feed.
  const poll = sharedPoll(`latest-topics:${limitCount}`, {
    fetch: async () => {
      const topics = await fetchLatestTopics(limitCount);
      return topics;
    },
    intervalMs: 30000,
    initialValue: [],
    onError: (err) => console.error('[subscribeToTopTopics]', err),
  });

  return poll.subscribe((topics) => callback(topics));
};

// isAbortedRequest recognises the PocketBase SDK's auto-cancellation.
//
// Client.send keeps ONE in-flight request per request key (GET + url) and aborts
// the previous one, then rejects the loser with a ClientResponseError whose
// `isAbort` is set. That is the SDK working as designed, not a failed read: the
// caller has a newer request in flight, or has already applied a newer value.
// Reporting it as a failure is what filled the console with "The request was
// aborted" while the profile on screen was perfectly correct.
//
// Exported so a test can execute it: reading `err.name` alone misses the SDK's
// wrapper, and a swallowed request is indistinguishable from a real failure
// unless the predicate itself is run against the shape the SDK actually throws.
export const isAbortedRequest = (err) =>
  !!err && (
    err.isAbort === true ||
    err.name === 'AbortError' ||
    err.originalError?.name === 'AbortError'
  );

// One read of a user row, for every caller that needs one.
//
// It exists because two callers used to spell this out separately and read from
// DIFFERENT sources: `subscribeToUser` read the collection, while AuthProvider
// rebuilt the caller's profile from `pb.authStore.record` — a snapshot PocketBase
// restores from localStorage and never refreshes, because every profile command
// writes through /api/aerun rather than through PocketBase. A snapshot read and a
// server read disagree exactly when a profile has just been saved, which is how
// the profile card came to show the new nickname while the Settings inputs,
// seeded from the snapshot, showed the old one.
//
// A cancelled duplicate answers null rather than throwing: the request that
// cancelled this one is the answer the caller wants. Every OTHER failure still
// throws, because `subscribeToUser` renders nothing at all for a caller it could
// not answer.
export const fetchUserProfile = async (uid) => {
  if (!uid) return null;
  try {
    const record = await pb.collection('users').getOne(uid);
    return normalizeUserProfile({ ...record });
  } catch (err) {
    if (isAbortedRequest(err)) return null;
    throw err;
  }
};

export const subscribeToUser = (uid, callback) => {
  if (!uid) {
    callback(null);
    return () => {};
  }

  let isSubscribed = true;
  fetchUserProfile(uid).then(record => {
    if (isSubscribed) {
      callback(record);
    }
  }).catch(() => {
    if (isSubscribed) callback(null);
  });

  let unsub = () => {};
  try {
    pb.collection('users').subscribe(uid, (e) => {
      if (isSubscribed) {
        callback(e.record ? normalizeUserProfile({ ...e.record }) : null);
      }
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the caller polls on its own interval, so a
    // failed subscription degrades to polling rather than breaking the view.
  }

  return () => {
    isSubscribed = false;
    unsub();
  };
};

// Presence subscriptions (active users / guest ids / daily actives) moved to
// ./rtdb-presence, which reads the consolidated heartbeat/status snapshots.

export const subscribeToAllUsers = (callback) => {
  let isSubscribed = true;

  // The pages still speak the legacy vocabulary: MembersPage renders its
  // JOINED column from `created_at`, and sorts by it. PocketBase names its
  // autodate columns `created`/`updated`, so both sources are normalized to the
  // legacy names here instead of teaching every consumer about the rename.
  //
  // PocketBase serializes a DateTime as "2006-01-02 15:04:05.999Z" — a space
  // where ISO 8601 wants "T". V8 parses it, but it is not a format every
  // browser guarantees to accept, so it is normalized on the way out. Only
  // `created_at` is mapped: `updated_at` is a record *edit* time, and on this
  // backend it moves whenever an import or a settings write touches the row,
  // which would make it actively misleading.
  //
  // `last_seen` is normalized for the same reason and is NOT the same thing as
  // `updated_at`: it is the durable last-visit clock (migration 1767300000),
  // written only by the heartbeat and by account creation. It is what the
  // members table falls back to once a member is no longer in the live
  // presence map.
  const isoFromPB = (value) => (typeof value === 'string' ? value.replace(' ', 'T') : value);
  const withLegacyDates = (u) => {
    const created = u.created_at ?? u.created;
    return {
      ...u,
      created_at: isoFromPB(created),
      last_seen: isoFromPB(u.last_seen),
    };
  };

  // toMembersRow is the single shape the members table and the admin user
  // table consume, and it is an explicit whitelist on purpose: neither source
  // row is spread into page state. The staff endpoint does not serve email at
  // all any more, and the public record carries columns (legacy_firebase_uid
  // is hidden, but settings and the profile block are not) that have no
  // business in a shared table.
  //
  // `created` is listed explicitly because withLegacyDates reads it from this
  // literal — drop it and the JOINED column silently empties.
  //
  // `last_seen` is the durable last-visit timestamp (backend migration
  // 1767300000). It is listed for the same reason as `created`: the staff DTO
  // must be naming it, or the members table loses its only offline answer and
  // degrades to "..." for everyone who is not currently connected.
  //
  // The counters are normalised to the legacy singular names the pages already
  // sort and render on (`post_count`), because the two sources spell them
  // differently: the admin DTO already emits post_count/topics_count, while a
  // public record carries the raw posts_count/topics_count columns.
  const toMembersRow = (u) => ({
    id: u.id,
    nickname: u.nickname,
    avatar_url: u.avatar_url,
    role_id: u.role_id ?? u.role,
    status: u.status,
    post_count: u.post_count ?? u.posts_count ?? 0,
    topics_count: u.topics_count ?? 0,
    reputation: u.reputation ?? 0,
    verified: u.verified,
    created: u.created,
    last_seen: u.last_seen
  });

  const load = async () => {
    try {
      // The staff endpoint caps a page at 30 (server-side: perPage above the
      // cap is clamped, not honoured). The members table sorts and filters the
      // WHOLE board client-side, so asking for one big page is not an option —
      // the pages are walked instead and the result is the same. The walk is
      // bounded by the server's own totalPages, so it cannot loop forever on a
      // board that grows mid-request.
      //
      // A null result means the subscription was cancelled mid-walk, not a
      // failure: only a real request error reaches the fallback below.
      const users = await fetchAllAdminUsers();
      if (users === null) return;
      callback(users);
    } catch {
      try {
        const list = await pb.collection('users').getFullList({ sort: 'nickname' });
        if (isSubscribed) callback(list.map(u => withLegacyDates(toMembersRow(u))));
      } catch {
        if (isSubscribed) callback([]);
      }
    }
  };

  // fetchAllAdminUsers walks every page of the staff endpoint and returns the
  // rows already mapped to the members-table shape, or null when the caller
  // unsubscribed part-way through (nothing should be delivered after that).
  const fetchAllAdminUsers = async () => {
    const rows = [];
    let page = 1;
    for (;;) {
      const res = await sendApi(`/api/aerun/admin/users?page=${page}`);
      if (!isSubscribed) return null;
      const items = res?.items || [];
      rows.push(...items.map(toMembersRow));
      const totalPages = res?.totalPages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page += 1;
    }
    return rows.map(withLegacyDates);
  };

  load();
  return () => { isSubscribed = false; };
};
