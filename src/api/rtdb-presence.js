import { sendApi, pb } from './pocketbase';

let heartbeatTimer = null;
let currentActiveCharacter = null;

const sendHeartbeat = async (character = null) => {
  if (!pb.authStore.isValid) return;
  try {
    await sendApi('/api/aerun/presence/heartbeat', {
      method: 'POST',
      body: {
        active_character: character || currentActiveCharacter || null
      }
    });
  } catch (err) {
    // Non-fatal presence heartbeat failure
  }
};

/**
 * Initializes presence tracking for an authenticated user.
 */
export const initRtdbPresence = (uid, profile, activeCharacter = null) => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (!uid || !pb.authStore.isValid) return () => {};

  currentActiveCharacter = activeCharacter;
  sendHeartbeat(activeCharacter);

  heartbeatTimer = setInterval(() => {
    sendHeartbeat(currentActiveCharacter);
  }, 30000);

  return () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
};

/**
 * Updates the active mask/character in presence tracking.
 */
export const updateRtdbActiveCharacter = async (uid, characterData) => {
  currentActiveCharacter = characterData ? {
    id: characterData.id || characterData._id,
    name: characterData.name || '',
    avatar_url: characterData.avatar_url || ''
  } : null;
  await sendHeartbeat(currentActiveCharacter);
};

export const setRtdbOnline = async (uid, profile, activeCharacter = null) => {
  currentActiveCharacter = activeCharacter;
  await sendHeartbeat(activeCharacter);
};

export const setRtdbOffline = async (uid, isLogout = false) => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

/**
 * Subscribes to the list of currently online users.
 */
export const subscribeToOnlineUsers = (callback) => {
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

export const subscribeToUserOnlineStatus = (uid, callback) => {
  if (!uid) {
    callback(false);
    return () => {};
  }

  let isSubscribed = true;
  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/presence/online-users');
      if (!isSubscribed) return;
      const found = (res?.users || []).some(u => u.id === uid);
      callback(found);
    } catch {
      if (isSubscribed) callback(false);
    }
  };

  load();
  const interval = setInterval(load, 25000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

export const subscribeToRtdbStatuses = (callback) => {
  let isSubscribed = true;
  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/presence/online-users');
      if (!isSubscribed) return;
      const map = {};
      (res?.users || []).forEach(u => {
        map[u.id] = {
          state: 'online',
          nickname: u.nickname,
          last_seen: u.last_seen
        };
      });
      callback(map);
    } catch {
      if (isSubscribed) callback({});
    }
  };

  load();
  const interval = setInterval(load, 25000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

export const subscribeToDailyActiveUsers = (callback) => {
  return subscribeToOnlineUsers(callback);
};

/**
 * Subscribes to the list of currently active *guests* (unauthenticated visitors).
 *
 * Guests are not a tracked presence in the PocketBase backend: they have no
 * auth record, so there is no id to heartbeat with and nothing to count in
 * `GET /presence/online-users` (which returns accounts only). The Firebase RTDB
 * implementation counted `/status/*` rows, and that data source is gone with the
 * RTDB removal, so this reports an empty list instead of leaving the import
 * dangling in ForumStats.
 *
 * The counter therefore reads 0 until anonymous presence is reintroduced. That
 * needs a product decision, not a shim: either a `guest_presence` collection
 * keyed by a client-generated visitor id, or dropping the counter from the
 * stats panel. Tracked in the migration plan's open tails.
 */
export const subscribeToActiveGuestsRtdb = (callback) => {
  callback([]);
  return () => {};
};

export const initRtdbGuestPresence = (guestId) => {
  return () => {};
};

export const removeRtdbGuestPresence = (guestId) => {
  return Promise.resolve();
};

export const recordActivity = async (uid) => {
  await sendHeartbeat();
};
