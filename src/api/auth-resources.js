// The PocketBase SDK is deliberately NOT imported here any more. Every read in
// this module went through it at some point, and each removal took a server
// route with it: accounts now come from `/api/aerun/users`, which narrows
// `settings` server-side, where the collection read could not. Re-adding the
// import is how that regression comes back, so its absence is asserted by
// scripts/check-forum-read-contract.mjs.
import { sendApi } from './pocketbase';
// normalizeTopic is imported, not re-implemented: the topic lists here must
// render the same rows as the category page, and a second copy of this mapping
// is exactly how the two drifted apart in the first place.
import { normalizeTopic } from './forum';
import { recordAvatarUrl, resolveAvatarUrl } from './avatars';
import { sharedPoll } from './shared-poll';

// ── User profile normalisation ──────────────────────────────────────────────

/**
 * normalizeUserProfile maps a PocketBase `users` record onto the field names
 * the pages speak.
 *
 * WHY THIS EXISTS. The pages predate the backend and read the Firestore
 * vocabulary for the facts PocketBase spells differently: `uid` and
 * `post_count` here mean `id` and `posts_count` on the wire. Two independent
 * mappers once read different fields and missed different ones:
 *
 *   - subscribeToUser spread the raw record, so every `uid` read was
 *     undefined and the profile card read 0 posts; a member with a custom
 *     role was badged "Player" for the same shape reason.
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
 * THE ROLE AXIS NEEDS NO MAPPING. The `users` column is `role`, the staff
 * DTO, `/me`, the profile route and the presence snapshot all spell it
 * `role`, and the pages do too. The old client-side rename into the Firestore
 * `role_id` is gone: that name survives only where the SERVER uses it — the
 * key of the `roles` collection (`roles.role_id`, `base_role_id`) and the
 * users companion column `custom_role_id`. A reader that asks a user row for
 * `role_id` is reading a field that does not exist.
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
    // `deleted` is the soft-delete flag the backend sets when an account is
    // removed (see backend soft-delete). A deleted account keeps its baked
    // nickname/avatar/counters so its profile and posts keep rendering.
    deleted: rec.deleted ?? false,
    // The join key on `users` is `role`; `role_id` only exists on the
    // `roles` collection. No legacy fallback: the server always names it.
    role: rec.role || 'player',
    // `custom_role_id` is the derived-role companion column, under its own
    // server name — that IS the column, not a rename of it.
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

// ── Read Map ───────────────────────────────────────────────────────────────────
//
// The local map is now a RENDERING CACHE, not the source of truth: the unread
// count is server state (`unread_topics` on /me/unread-counts), because it has to
// agree across devices and cannot be capped by a page size — a browser map
// derived from a 50-row list can be neither. What survives locally is the
// per-row highlight on /new-replies, which must respond the instant the member
// clicks, and the scroll offset they left a topic at.
//
// Keeping both is deliberate rather than redundant: the local map answers "what
// has THIS screen marked, right now", the server answers "what has this ACCOUNT
// read". Collapsing them into one would put a network round trip in front of a
// button that must feel instant, or keep the count wrong on the second device.

const getReadMapKey = (uid) => `aerun_readmap_${uid}`;

export const recordTopicVisit = async (uid, topicId, offset = null, lastVisiblePostId = null) => {
  if (!uid || !topicId) return;
  try {
    // Server first: this is the write that makes the badge correct elsewhere. It is
    // awaited but not allowed to block the caller — a failed read-state write must
    // never stop a member from opening a topic.
    //
    // last_visible_post_id pins the server-side read cursor to the post this
    // screen actually rendered (ADR ReadCursor). Without it the server falls
    // back to a timestamp bound, which can mark a post read that no one saw.
    await sendApi(`/api/aerun/topics/${topicId}/read`, {
      method: 'POST',
      body: { last_visible_post_id: lastVisiblePostId || '' },
    });
  } catch (err) {
    console.warn('[recordTopicVisit] server read state failed', err);
  }
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

// apiMarkAllTopicsRead moves the caller's read position server-side.
//
// It sends `all:true` and lets the SERVER resolve the set from the same
// predicate that drives the unread feed and the counter. A client-supplied id
// list can only ever be a stale, paginated snapshot of that set — the feed it is
// drawn from is polled — so "mark all read" that trusted the client left real
// unread topics behind: the badge dropped, the page the client sent emptied, and
// the topics on page two (or posted after the last poll) stayed unread and kept
// their row indicator. The server owns the read states, so it decides what
// "all" means.
//
// The response is returned, not discarded: the server echoes back the FULL list
// of ids it marked, which is what the local row-indicator map must move on.
export const apiMarkAllTopicsRead = async (uid) => {
  if (!uid) return { marked: 0, ids: [] };
  try {
    return await sendApi('/api/aerun/me/topics/read-all', {
      method: 'POST',
      body: { all: true },
    });
  } catch (err) {
    // Reported, not swallowed: the badge will keep showing the old number and the
    // member deserves to know why rather than watching a button that appears to do
    // nothing.
    console.warn('[markAllTopicsRead] server read state failed', err);
    throw err;
  }
};

// apiRecordAllTopicVisits mirrors the bulk write into the local rendering cache.
// Best effort by design — see the note on recordTopicVisit above.
export const apiRecordAllTopicVisits = (uid, topicIds) => {
  if (!uid || !topicIds?.length) return;
  try {
    const key = getReadMapKey(uid);
    const raw = localStorage.getItem(key);
    const map = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    topicIds.forEach(id => { map[id] = now; });
    localStorage.setItem(key, JSON.stringify(map));
  } catch (err) {
    console.warn('[apiRecordAllTopicVisits err]', err);
  }
};

// ── Latest Content ─────────────────────────────────────────────────────────

// Both of these read the topic list, which the command layer serves under
// `items`. The `topics` key belongs to the retired Firestore callable and is
// never present, so "Most Active Topics" and the new-replies feed rendered
// empty for every member.
//
// `order_by` is gone from the URL too: listTopicsHandler picks the ordering
// itself — `pinned DESC, last_post_created DESC, id DESC` inside a category
// (this request carries no category_id) — so the parameter never did anything
// except look like it did.
//
// NORMALISE BEFORE HANDING A ROW TO A RENDERER. This used to pass the raw
// `items` through, and normalizeTopic is what maps the server's own field names
// onto the ones TopicRow reads (`last_post_created` → `last_post_at`,
// `pinned` → `is_pinned`, `created` → `created_at`). Skipping it left every one
// of those undefined, so /active-topics rendered a literal "—" in the last-post
// column with no link at all — the row looked empty rather than wrong, which is
// why it survived review.
export const fetchLatestTopics = async (page = 1, pageSize = 20) => {
  try {
    const res = await sendApi(`/api/aerun/topics?page=${page}&limit=${pageSize}`);
    return {
      topics: (res?.items || []).map(normalizeTopic),
      // The server's count over the WHOLE list, not this page — it is what the
      // pager divides by. Falling back to this page's length would make the pager
      // claim one page whenever the first page happened to be full, which is how a
      // truncated list ends up looking complete.
      total: res?.total ?? 0,
      perPage: res?.per_page || pageSize,
    };
  } catch (err) {
    console.error('[fetchLatestTopics]', err);
    return { topics: [], total: 0, perPage: pageSize };
  }
};

// The /active-topics ("Most Discussed") feed ranks topics by posts_count DESC
// (most replies first), with id DESC as tiebreak. Server enforces the ordering
// via sort_by=replies; we only normalise and paginate the same way as every
// other topic list so the two feeds cannot drift apart.
export const fetchTopDiscussedTopics = async (page = 1, pageSize = 20) => {
  try {
    const res = await sendApi(`/api/aerun/topics?sort_by=replies&page=${page}&limit=${pageSize}`);
    return {
      topics: (res?.items || []).map(normalizeTopic),
      total: res?.total ?? 0,
      perPage: res?.per_page || pageSize,
    };
  } catch (err) {
    console.error('[fetchTopDiscussedTopics]', err);
    return { topics: [], total: 0, perPage: pageSize };
  }
};

// The unread feed, paged on the server.
//
// It is a separate read rather than a client-side filter of the general feed,
// because a client filter can only see what it fetched. Filtering fifty topics
// locally meant any topic with unread replies beyond that window was invisible —
// the member saw "no new replies" while the tab title counted them. The server
// owns that set because it owns the read states.
export const fetchUnreadTopics = async (page = 1, pageSize = 20) => {
  try {
    const res = await sendApi(`/api/aerun/topics?unread=1&page=${page}&limit=${pageSize}`);
    return {
      topics: (res?.items || []).map(normalizeTopic),
      total: res?.total ?? 0,
      perPage: res?.per_page || pageSize,
    };
  } catch (err) {
    console.error('[fetchUnreadTopics]', err);
    return { topics: [], total: 0, perPage: pageSize };
  }
};

// Polls one page of the UNREAD feed, on the same shape as the general feed.
//
// It exists because dropping the poll from /new-replies would have silently made
// the screen stop updating: it used to re-read every 20s, and a member watching
// for replies would simply have seen a frozen list. Paging does not justify
// losing that.
const unreadTopicsPolls = new Map();

export const subscribeToUnreadTopics = (callback, page = 1, pageSize = 20) => {
  const poll = sharedPoll(`unread-topics:${page}:${pageSize}`, {
    fetch: () => fetchUnreadTopics(page, pageSize),
    intervalMs: 20000,
    initialValue: { topics: [], total: 0, perPage: pageSize },
    onError: (err) => console.error('[subscribeToUnreadTopics]', err),
  });
  unreadTopicsPolls.set(`unread-topics:${page}:${pageSize}`, poll);

  return poll.subscribe((data) => callback(data));
};

// refreshUnreadTopics re-reads every live page of the unread feed. The feed is
// server-filtered by read state, so after a mark-read the just-read row is
// already gone server-side — but the page renders the last POLLED value, which
// is why a topic just opened from the main page lingered in /new-replies until
// the next 20s tick.
export const refreshUnreadTopics = () => {
  try {
    unreadTopicsPolls.forEach((poll) => poll?.refresh());
  } catch {
    // Same contract as the counters refresh: best effort, never throws.
  }
};

// Polls one page of the general topic feed.
//
// The PAGE IS PART OF THE POLL KEY. Pages are different resources — page 2 is
// not a fresher page 1 — so keying them together would make a member on page 2
// receive page 1's rows, and the two pages' data would overwrite each other in
// one shared slot.
export const subscribeToLatestTopics = (callback, page = 1, pageSize = 20) => {
  const poll = sharedPoll(`latest-topics:${page}:${pageSize}`, {
    fetch: () => fetchLatestTopics(page, pageSize),
    intervalMs: 20000,
    initialValue: { topics: [], total: 0, perPage: pageSize },
    onError: (err) => console.error('[subscribeToLatestTopics]', err),
  });

  return poll.subscribe((data) => callback(data));
};

// Polls one page of the "most discussed" feed (sorted by posts_count DESC).
//
// Its poll key is separate from latest-topics so page N of each feed stays
// isolated, and separate from unread-topics because that feed carries a
// server-side read-state filter this one does not.
const topDiscussedPolls = new Map();

export const subscribeToTopDiscussedTopics = (callback, page = 1, pageSize = 20) => {
  const key = `top-discussed:${page}:${pageSize}`;
  let poll = topDiscussedPolls.get(key);
  if (!poll) {
    poll = sharedPoll(key, {
      fetch: () => fetchTopDiscussedTopics(page, pageSize),
      intervalMs: 20000,
      initialValue: { topics: [], total: 0, perPage: pageSize },
      onError: (err) => console.error('[subscribeToTopDiscussedTopics]', err),
    });
    topDiscussedPolls.set(key, poll);
  }

  return poll.subscribe((data) => callback(data));
};

// ── Guest Activity ──────────────────────────────────────────────────────────

export const recordGuestActivity = async (_guestId) => {};

export const deleteGuestActivity = async (_guestId) => {};

// ── Statistics & Global Content ─────────────────────────────────────────────

// subscribeToTopTopics backs the /active-topics list.
//
// It now ranks topics by posts_count DESC (most replies first) via the
// sort_by=replies server path, matching the page's own description:
// "Top 50 forum topics, sorted by number of replies."
//
// It maps through `fetchTopDiscussedTopics`, not through its own request, so
// this page cannot drift from the other topic lists: both render the SAME
// normalised rows, and a fix to one is a fix to both. The previous version
// issued its own `sendApi` and passed `res.items` through raw, which is how
// that page ended up showing "—" where every other topic list showed a
// timestamp and a link.
export const subscribeToTopTopics = (callback, page = 1, pageSize = 20) => {
  // One resource, one loop, one interval — subscribes to the top-discussed
  // feed (sorted by replies), not the recency feed.
  return subscribeToTopDiscussedTopics(callback, page, pageSize);
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

// ONE read of a user row, for every caller that needs one.
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
// THIS USED TO READ `pb.collection('users').getOne(uid)`, and that was the last
// place the browser read a table directly. It handed a signed-OUT visitor the
// whole auth record: `settings` — every member's sound volume, muted
// notification types, mail preferences, theme and language — plus `email`
// scaffolding, `collectionId`, `nickname_normalized` and the rest. It is served
// by `GET /api/aerun/users/{id}` now, which assembles a whitelist server-side
// and sends the owner their full settings while a stranger gets only the two
// reputation-visibility flags the profile page actually reads off another
// account. Same pattern `/users/{id}/posts` and `/admin/users` already use.
//
// A cancelled duplicate answers null rather than throwing: the request that
// cancelled this one is the answer the caller wants. Every OTHER failure still
// throws, because `subscribeToUser` renders nothing at all for a caller it could
// not answer.
// Single-flight per uid: two callers reaching for the same row while a read
// is still in the air join one GET instead of doubling it. The shared promise
// is stored until it settles; a caller joining a live request shares its
// outcome instead of issuing a rival one. A settled request is NOT cached: the
// next caller after it settles reads fresh, which is what keeps a mutation
// from being shadowed by the pre-write answer. In practice the two callers
// here are AuthProvider's own-profile refresh and ProfilePage's subscribeToUser
// when they happen to read the SAME account.
const _profileFlights = new Map();

// A settled profile snapshot is kept for a short window so a remount that
// happens moments later (ProfilePage's effect re-running because `t` changed
// identity after AuthProvider's own-profile write) reuses the last answer
// instead of paying a second identical GET. The window is intentionally
// short — a mutation is never responsible for the STALENESS here, because a
// caller that WRITES and then needs the row re-reads through a fresh flight
// once this cache expires.
const _profileCache = new Map();
const PROFILE_CACHE_MS = 30_000;

export const fetchUserProfile = async (uid) => {
  if (!uid) return null;
  // Short-TTL hit: a remount that arrives right after a successful read gets
  // the cached snapshot instead of a second identical GET.
  const cached = _profileCache.get(uid);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_MS) return cached.value;
  const live = _profileFlights.get(uid);
  if (live) return live;
  const flight = (async () => {
    try {
      const record = await sendApi(`/api/aerun/users/${uid}`);
      const value = normalizeUserProfile({ ...record });
      _profileCache.set(uid, { value, at: Date.now() });
      return value;
    } catch (err) {
      if (isAbortedRequest(err)) return null;
      throw err;
    }
  })();
  _profileFlights.set(uid, flight);
  flight.finally(() => {
    if (_profileFlights.get(uid) === flight) _profileFlights.delete(uid);
  });
  return flight;
};

// A single read of one account, delivered once.
//
// THE REALTIME HOOK THAT WAS HERE IS GONE, and it was not a working refresh:
// forum content collections are locked (ListRule nil — see
// markdowns/DONE_REALTIME_TRANSPORT_DESIGN.md and backend/README.md), so
// `pb.collection('users').subscribe(uid, …)` completed the SSE handshake and then
// never delivered an event. The two `realtime` entries in a profile page's
// network log were exactly that: open connections carrying nothing.
//
// It was also a SECOND DOOR onto the payload this change exists to close: an
// event delivers the whole auth record, so `e.record` would have pushed every
// member's private `settings` straight back into page state even after the read
// above was narrowed.
//
// Nothing is lost by removing it, because nothing ever arrived: the page has
// always rendered from this one read. If the profile ever gets a signal-based
// refresh, this is the place the subscription comes back — carrying the same
// DTO as the read, never the record.
// The profile page's subscribe and AuthProvider's own-profile refresh for the
// SAME account share one read through fetchUserProfile's single-flight above
// only when they happen to read the same uid. When they do not — the normal
// case, a member viewing somebody else's profile — this fires its own GET and
// stays independent of the viewer's own uid. The promise is joined, not
// cached: after it settles the next caller reads fresh, so a rename elsewhere
// is never masked by a prior answer.
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

  return () => {
    isSubscribed = false;
  };
};

// ── Effective permissions ─────────────────────────────────────────────────────
//
// WHAT THE CALLER MAY DO, asked of the server rather than re-derived here.
//
// `GET /api/aerun/me` answers it with `permissions: PermissionValues(acc.Permissions)`,
// where acc is already narrowed by role AND by account status. It is the only
// read of that question, and it answers it for a guest too — the guest branch of
// profilePayload returns the guest identity with its real permission set, which is
// what `fetchUserProfile` cannot do (it needs a uid, and a signed-out visitor has
// none).
//
// This is what lets the permission MATRIX stop being public. The gate previously
// resolved the caller's role in the registry and read that role's list, so every
// caller had to be told every role's permissions to render one screen's worth of
// controls. Reading the answer instead means `GET /roles` only has to serve what a
// badge actually paints — id, name, color, rank.
//
// Keyed by uid (and the literal `guest`), so switching accounts or signing out is a
// different resource with its own value rather than a stale answer from the
// previous one — permissions change on exactly those transitions, and with them the
// whole UI.
//
// It is polled rather than subscribed because /me is a projection: it changes when
// the role registry or the account's status changes, which is a moderator's action
// in another session, not a row write this tab can observe.
// It is polled rather than subscribed because /me is a projection: it changes when
// the role registry or the account's status changes, which is a moderator's action
// in another session, not a row write this tab can observe.
//
// The poll carries the whole /me answer the client needs — the effective
// permission set AND the stored role beside it — so a consumer of either
// never pays a second read for the other half: the admin panel ranks its
// role gates off the same answer that feeds `hasPermission`.
export const subscribeToEffectivePermissions = (uid, callback) => {
  const key = uid || 'guest';
  const poll = sharedPoll(`me-projection:${key}`, {
    fetch: async () => {
      const me = await sendApi('/api/aerun/me');
      return {
        permissions: Array.isArray(me?.permissions) ? me.permissions : [],
        role: me?.role || '',
        status: me?.status || '',
      };
    },
    // Slow on purpose: this is a moderator's action in another browser, and a
    // 30s stale window is invisible next to a 20s presence poll.
    intervalMs: 30000,
    // null is NOT the same as "no permissions", and the two must not look
    // alike: it is the honest "we have not asked yet" value. Consumers keep
    // their previous value until the first answer lands; hasPermission then
    // falls back to the compiled matrix rather than locking every control.
    initialValue: null,
    onError: (err) => console.warn('[effective permissions]', err),
  });

  return poll.subscribe((me) => callback(me));
};

// Presence subscriptions (active users / guest ids / daily actives) moved to
// ./rtdb-presence, which reads the consolidated heartbeat/status snapshots.

/**
 * Reads the member list for a screen that renders it.
 *
 * `staff` selects the source, and the default is the PUBLIC one because the
 * members page is a public page.
 *
 * THE FAILURE THIS REMOVES. This used to try `GET /api/aerun/admin/users` FIRST
 * and fall back to a direct `pb.collection('users').getFullList()` when it threw.
 * `/admin/users` is gated by `admin_access` (run.go binds it to
 * `RequirePermission(auth.PermAdminAccess)`), so for a signed-out visitor — and
 * for every ordinary member, since `admin_access` is root+admin only — that first
 * call could not succeed under any circumstances. Opening /members as a guest
 * logged a guaranteed `401 Authentication is required for this action` in the
 * network tab and the console on every visit, and the list still rendered from
 * the fallback. A request whose failure is decided before it is sent is not a
 * retry: it is a request that should not exist.
 *
 * The fallback was never a degradation, either. It is the ONLY path a guest has,
 * because there is no public `/api/aerun/users` list — the members page is
 * served by the open `users.ListRule` that migration 1768100000 introduced.
 * So the ordering made the public path pay for the staff path on every visit,
 * and the console error was the visible half of a design that reaches around the
 * command layer for this screen entirely.
 *
 * No current caller passes `{ staff: true }`: AdminPage — the only consumer
 * entitled to the staff DTO (`status` and `verified` are on that route and
 * nowhere else) — reads the paged list through `fetchAdminUsers` (src/api/
 * admin.js) instead, normalising each row through the SAME `toMembersRow`
 * the walk uses. The staff branch stays because scripts/check-forum-read-
 * contract.mjs pins the explicit-staff contract: the next staff consumer
 * must opt into it visibly rather than inherit it silently.
 */

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

// Exported for the paged admin read: one mapper for both routes is what
// stops the row shapes drifting apart.
export const withLegacyDates = (u) => {
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
//
// `role` is NOT normalised: both sources spell it `role` (the `users` column
// and the staff DTO agree), so the row carries the server name verbatim.
export const toMembersRow = (u) => ({
  id: u.id,
  nickname: u.nickname,
  avatar_url: u.avatar_url,
  role: u.role,
  status: u.status,
  // The one-line status under the nickname. MembersPage renders it
  // (`u.status_line && <small>…`), and this mapper did not carry it, so the
  // column was permanently empty for every member on a public page — the
  // server sent the value and the client threw it away one line above where it
  // is read. It is a public profile field (it is already denormalised onto
  // every post as `author_status_line`), so serving it here exposes nothing new.
  status_line: u.status_line,
  post_count: u.post_count ?? u.posts_count ?? 0,
  topics_count: u.topics_count ?? 0,
  reputation: u.reputation ?? 0,
  verified: u.verified,
  created: u.created,
  last_seen: u.last_seen
});

export const subscribeToAllUsers = (callback, { staff = false } = {}) => {
  let isSubscribed = true;

  // THE PUBLIC READ, AND WHY THE SERVER OWNS THE WHITELIST.
  //
  // This used to be `getFullList({ sort: 'nickname', fields: [...] })`. Naming
  // the columns stopped the leak but left the browser reading the `users` TABLE
  // directly, which is the thing this whole layer exists to end: a whitelist
  // written in JavaScript is a whitelist nobody can audit against the server,
  // and PocketBase's `fields` cannot narrow a JSON column — so `settings` could
  // only ever be dropped by dropping the entire object.
  //
  // `/api/aerun/users` assembles the list server-side and sends no `settings` at
  // all, which is correct here: `toMembersRow` reads none of it.
  //
  // The staff path is untouched: it goes through `/admin/users`, which assembles
  // its own whitelist and additionally serves the moderation columns. Both
  // routes answer with the same envelope, so ONE loop walks both — two paginators
  // would be two things to keep in step.
  //
  // `fetchPage` is a CALLBACK rather than a path string, and that is not
  // stylistic. scripts/audit-endpoints.mjs resolves routes by reading the string
  // literal inside each sendApi call, so passing the path in as an argument
  // reduced both routes to an opaque placeholder and the audit reported them as
  // calls with no backend route — exactly the signal it exists to raise. The URLs
  // therefore stay literal at their call sites below.
  const collectEveryPage = async (fetchPage) => {
    const rows = [];
    let page = 1;
    for (;;) {
      const res = await fetchPage(page);
      if (!isSubscribed) return null;
      const items = res?.items || [];
      rows.push(...items.map(toMembersRow));
      const totalPages = res?.totalPages ?? 1;
      if (page >= totalPages || items.length === 0) break;
      page += 1;
    }
    return rows.map(withLegacyDates);
  };

  const readPublicMembers = async () => {
    const rows = await collectEveryPage(
      (page) => sendApi(`/api/aerun/users?page=${page}`)
    );
    if (rows !== null && isSubscribed) callback(rows);
  };

  const load = async () => {
    // A guest, and every member without `admin_access`, must not issue the staff
    // call at all: it is refused before it is sent, so trying it only to catch
    // the rejection is a guaranteed red entry in the network tab.
    if (!staff) {
      try {
        await readPublicMembers();
      } catch {
        if (isSubscribed) callback([]);
      }
      return;
    }

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
      const users = await collectEveryPage(
        (page) => sendApi(`/api/aerun/admin/users?page=${page}`)
      );
      if (users === null) return;
      callback(users);
    } catch {
      // Staff only, and a genuine transport failure: an admin whose staff call
      // fails should still see a populated table rather than an empty one.
      try {
        await readPublicMembers();
      } catch {
        if (isSubscribed) callback([]);
      }
    }
  };

  load();

  // `.refresh` rides on the unsubscribe function rather than on a second
  // exported symbol, because there is exactly ONE way to re-read this resource —
  // through the `load` closure that owns `staff`, the pagination walk and the
  // public/staff fallback. A standalone `refreshAllUsers()` would have to either
  // duplicate that logic or guess which of the two branches is in play, and
  // MembersPage asks for a refresh exactly when a member wonders whether the
  // board is current: a refresh that silently lost the staff flag would answer
  // the admin's question with the public list.
  const unsubscribe = () => { isSubscribed = false; };
  unsubscribe.refresh = () => { load(); };
  return unsubscribe;
};
