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

export const subscribeToActiveUsers = (callback) => {
  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/presence/online-users');
      if (!isSubscribed) return;
      const list = (res?.users || []).map(u => ({
        id: u.id,
        nickname: u.nickname || 'User',
        avatar_url: u.avatar_url || '',
        role_id: u.role || 'player',
        post_count: u.post_count || 0,
        status_line: u.status_line || '',
        signature: u.signature || '',
        active_character: u.active_character || null,
        last_seen: u.last_seen ? new Date(u.last_seen).getTime() : Date.now()
      }));
      callback(list);
    } catch {
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 20000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

export const subscribeToActiveUserIds = (callback) => {
  return subscribeToActiveUsers((users) => {
    callback(new Set(users.map(u => u.id)));
  });
};

export const fetchDailyActiveUsers = async () => {
  try {
    const res = await sendApi('/api/aerun/presence/online-users');
    return (res?.users || []).map(u => ({
      id: u.id,
      nickname: u.nickname || 'User',
      avatar_url: u.avatar_url || '',
      role_id: u.role || 'player',
      last_seen: u.last_seen ? new Date(u.last_seen).getTime() : Date.now()
    }));
  } catch {
    return [];
  }
};

export const subscribeToActiveGuests = (callback) => {
  callback([]);
  return () => {};
};

export const subscribeToAllUsers = (callback) => {
  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/admin/users?perPage=100');
      if (!isSubscribed) return;
      const users = (res?.items || []).map(u => ({
        id: u.id,
        nickname: u.nickname,
        avatar_url: u.avatar_url,
        role_id: u.role,
        status: u.status
      }));
      callback(users);
    } catch {
      try {
        const list = await pb.collection('users').getFullList({ sort: 'nickname' });
        if (isSubscribed) callback(list.map(u => ({ id: u.id, ...u })));
      } catch {
        if (isSubscribed) callback([]);
      }
    }
  };

  load();
  return () => { isSubscribed = false; };
};
