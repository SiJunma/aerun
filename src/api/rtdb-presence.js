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
 * Enriches status with post_count, status_line, signature, and active_character.
 */
export const initRtdbPresence = (uid, profile, activeCharacter = null) => {
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

        // Set online status with enriched fields
        set(userStatusRef, {
          state: 'online',
          uid,
          nickname: profile?.nickname || 'User',
          avatar_url: profile?.avatar_url || '',
          role_id: profile?.role_id || 'player',
          post_count: profile?.post_count || 0,
          status_line: profile?.status_line || '',
          signature: profile?.signature || '',
          active_character: activeCharacter ? {
            id: activeCharacter.id || activeCharacter._id,
            name: activeCharacter.name || '',
            avatar_url: activeCharacter.avatar_url || ''
          } : null,
          last_seen: serverTimestamp()
        }).catch((err) => console.warn('[RTDB set online err]', err));
      }
    });

    // Cleanup: ONLY unsubscribe the listener.
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
 * Updates the active mask/character in RTDB immediately when user switches character.
 */
export const updateRtdbActiveCharacter = async (uid, characterData) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    await update(userStatusRef, {
      active_character: characterData ? {
        id: characterData.id || characterData._id,
        name: characterData.name || '',
        avatar_url: characterData.avatar_url || ''
      } : null
    });
  } catch (err) {
    console.warn('[updateRtdbActiveCharacter err]', err);
  }
};

/**
 * Sets user status to online in RTDB when user resumes activity.
 */
export const setRtdbOnline = async (uid, profile, activeCharacter = null) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    await update(userStatusRef, {
      state: 'online',
      last_seen: serverTimestamp(),
      ...(profile?.nickname ? { nickname: profile.nickname } : {}),
      ...(profile?.avatar_url !== undefined ? { avatar_url: profile.avatar_url } : {}),
      ...(profile?.role_id ? { role_id: profile.role_id } : {}),
      ...(profile?.post_count !== undefined ? { post_count: profile.post_count } : {}),
      ...(profile?.status_line !== undefined ? { status_line: profile.status_line } : {}),
      ...(profile?.signature !== undefined ? { signature: profile.signature } : {})
    });
  } catch (err) {
    console.warn('[setRtdbOnline err]', err);
  }
};

/**
 * Sets user status to offline manually (called on idle timeout or logout).
 * @param {string} uid
 * @param {boolean} isLogout - If true, cancels the server-side onDisconnect hook before sign out.
 */
export const setRtdbOffline = async (uid, isLogout = false) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    // Cancel any pending server-side onDisconnect if explicit logout (avoid double-write)
    if (isLogout && activeDisconnectCancel) {
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
            post_count: u.post_count || 0,
            status_line: u.status_line || '',
            signature: u.signature || '',
            active_character: u.active_character || null,
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
            post_count: u.post_count || 0,
            status_line: u.status_line || '',
            signature: u.signature || '',
            active_character: u.active_character || null,
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
