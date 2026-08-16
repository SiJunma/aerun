import { rtdb } from '../../firebase';
import {
  ref,
  onValue,
  set,
  update,
  onDisconnect,
  serverTimestamp
} from 'firebase/database';

let activePresenceUnsub = null;
let activeDisconnectCancel = null; // stores cancel fn for current onDisconnect

/**
 * Initializes real-time presence tracking for an authenticated user.
 * Automatically sets status to 'online' on connect, and 'offline' on disconnect.
 */
export const initRtdbPresence = (uid, profile) => {
  if (activePresenceUnsub) {
    activePresenceUnsub();
    activePresenceUnsub = null;
    activeDisconnectCancel = null;
  }

  if (!uid || !rtdb) return () => {};

  try {
    const connectedRef = ref(rtdb, '.info/connected');
    const userStatusRef = ref(rtdb, `status/${uid}`);
    let disconnectHandler = null;

    const unsubConnected = onValue(connectedRef, (snap) => {
      if (snap.val() === true) {
        // Prepare server-side onDisconnect hook (fires even on tab crash/network loss)
        // Use update() so only state/last_seen are overwritten — nickname etc. are preserved.
        disconnectHandler = onDisconnect(userStatusRef);
        disconnectHandler
          .update({
            state: 'offline',
            last_seen: serverTimestamp()
          })
          .then(() => {
            activeDisconnectCancel = () => disconnectHandler.cancel().catch(() => {});
          })
          .catch((err) => console.warn('[RTDB onDisconnect err]', err));

        // Set online status
        set(userStatusRef, {
          state: 'online',
          uid,
          nickname: profile?.nickname || 'User',
          avatar_url: profile?.avatar_url || '',
          role_id: profile?.role_id || 'player',
          last_seen: serverTimestamp()
        }).catch((err) => console.warn('[RTDB set online err]', err));
      }
    });

    // Cleanup: ONLY unsubscribe the listener.
    // Do NOT write to RTDB here — React cleanup runs after signOut(),
    // at which point the auth token is gone and write → permission_denied.
    // The onDisconnect hook registered above fires on the server automatically.
    activePresenceUnsub = () => {
      unsubConnected();
    };

    return activePresenceUnsub;
  } catch (err) {
    console.warn('[initRtdbPresence err]', err);
    return () => {};
  }
};

/**
 * Sets user status to offline manually (called on logout, before signOut).
 * Cancels the server-side onDisconnect hook to prevent a double-write,
 * then explicitly writes offline while the token is still valid.
 * Returns a promise so the caller can await it before signOut().
 */
export const setRtdbOffline = async (uid) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    // Cancel any pending server-side onDisconnect (avoid double-write)
    if (activeDisconnectCancel) {
      activeDisconnectCancel();
      activeDisconnectCancel = null;
    }
    // Use update() — only changes state/last_seen, preserves nickname/role_id/avatar_url
    await update(userStatusRef, {
      state: 'offline',
      last_seen: serverTimestamp()
    });
  } catch (e) {
    console.warn('[setRtdbOffline err]', e);
  }
};

/**
 * Subscribes to the list of currently online users from RTDB (0 Firestore reads).
 */
export const subscribeToOnlineUsers = (callback) => {
  if (!rtdb) {
    callback([]);
    return () => {};
  }

  try {
    const statusRef = ref(rtdb, 'status');
    return onValue(statusRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        callback([]);
        return;
      }

      const onlineList = [];
      Object.keys(data).forEach((uid) => {
        const u = data[uid];
        if (u && u.state === 'online' && u.role_id !== 'banned') {
          onlineList.push({
            id: uid,
            nickname: u.nickname || 'User',
            avatar_url: u.avatar_url || '',
            role_id: u.role_id || 'player',
            last_seen: u.last_seen
          });
        }
      });

      onlineList.sort((a, b) => (a.nickname || '').localeCompare(b.nickname || ''));
      callback(onlineList);
    }, (err) => {
      console.warn('[subscribeToOnlineUsers error]', err);
      callback([]);
    });
  } catch (err) {
    console.warn('[subscribeToOnlineUsers caught]', err);
    callback([]);
    return () => {};
  }
};

/**
 * Real-time listener for a single user's online state from RTDB.
 */
export const subscribeToUserOnlineStatus = (uid, callback) => {
  if (!uid || !rtdb) {
    callback(false);
    return () => {};
  }

  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    return onValue(userStatusRef, (snapshot) => {
      const val = snapshot.val();
      callback(val?.state === 'online');
    }, (err) => {
      console.warn('[subscribeToUserOnlineStatus error]', err);
      callback(false);
    });
  } catch (err) {
    callback(false);
    return () => {};
  }
};

/**
 * Subscribes to the list of users active in the last 24 hours from RTDB.
 * Uses status/{uid}.last_seen — no Firestore reads needed.
 */
export const subscribeToDailyActiveUsers = (callback) => {
  if (!rtdb) {
    callback([]);
    return () => {};
  }

  try {
    const statusRef = ref(rtdb, 'status');
    return onValue(statusRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        callback([]);
        return;
      }

      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const dailyList = [];
      Object.keys(data).forEach((uid) => {
        const u = data[uid];
        if (!u || u.role_id === 'banned') return;
        // RTDB serverTimestamp() stores as number (epoch ms) on clients
        const lastSeenMs = typeof u.last_seen === 'number' ? u.last_seen : 0;
        if (lastSeenMs >= cutoff) {
          dailyList.push({
            id: uid,
            nickname: u.nickname || 'User',
            avatar_url: u.avatar_url || '',
            role_id: u.role_id || 'player',
            last_seen: u.last_seen
          });
        }
      });

      dailyList.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
      callback(dailyList);
    }, (err) => {
      console.warn('[subscribeToDailyActiveUsers error]', err);
      callback([]);
    });
  } catch (err) {
    console.warn('[subscribeToDailyActiveUsers caught]', err);
    callback([]);
    return () => {};
  }
};
