import { sendApi, pb } from './pocketbase';

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

export const fetchLatestTopics = async (limitCount = 50) => {
  try {
    const res = await sendApi(`/api/aerun/topics?order_by=last_post_at&limit=${limitCount}`);
    return res?.topics || [];
  } catch (err) {
    console.error('[fetchLatestTopics]', err);
    return [];
  }
};

export const subscribeToLatestTopics = (callback, limitCount = 50) => {
  let isSubscribed = true;

  const load = () => {
    fetchLatestTopics(limitCount).then(topics => {
      if (isSubscribed) callback(topics);
    });
  };

  load();
  const interval = setInterval(load, 20000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

// ── Guest Activity ──────────────────────────────────────────────────────────

export const recordGuestActivity = async (guestId) => {};

export const deleteGuestActivity = async (guestId) => {};

// ── Statistics & Global Content ─────────────────────────────────────────────

export const subscribeToTopTopics = (callback, limitCount = 50) => {
  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/topics?order_by=posts_count&limit=${limitCount}`);
      if (isSubscribed) callback(res?.topics || []);
    } catch (err) {
      console.error('[subscribeToTopTopics]', err);
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 30000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

export const subscribeToUser = (uid, callback) => {
  if (!uid) {
    callback(null);
    return () => {};
  }

  let isSubscribed = true;
  pb.collection('users').getOne(uid).then(record => {
    if (isSubscribed) {
      callback({ id: record.id, ...record });
    }
  }).catch(() => {
    if (isSubscribed) callback(null);
  });

  let unsub = () => {};
  try {
    pb.collection('users').subscribe(uid, (e) => {
      if (isSubscribed) {
        callback(e.record ? { id: e.record.id, ...e.record } : null);
      }
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {}

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
  const withLegacyDates = (u) => {
    const created = u.created_at ?? u.created;
    return {
      ...u,
      created_at: typeof created === 'string' ? created.replace(' ', 'T') : created,
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
    created: u.created
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
