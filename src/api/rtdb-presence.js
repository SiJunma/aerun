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
 * RTDB status/{uid} field semantics:
 *
 * last_seen     — online presence timestamp. Updated on every activity push and on
 *                 connect/disconnect. Used ONLY for the "Online now" (15-min) list.
 *                 On logout: state='logged_out' is set so the user leaves the online
 *                 list instantly, but last_seen is left at the real logout time.
 *
 * last_activity — real, persistent "last visited" timestamp. Updated on every
 *                 meaningful activity (recordActivity). NOT touched on logout/disconnect.
 *                 Used for:  "Visited today" list  +  synced to Firestore users.last_seen.
 */

/**
 * Initializes real-time presence tracking for an authenticated user.
 * Automatically sets status to 'online' on connect, and 'offline' on disconnect.
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
        // Server-side onDisconnect: only update state to 'offline', do NOT overwrite last_seen or last_activity
        disconnectHandler = onDisconnect(userStatusRef);
        disconnectHandler
          .update({
            state: 'offline'
          })
          .then(() => {
            activeDisconnectCancel = () => disconnectHandler.cancel().catch(() => {});
          })
          .catch((err) => console.warn('[RTDB onDisconnect err]', err));

        // Set online status. last_activity is set here on fresh login (first connect),
        // and will be updated again on every recordActivity call.
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
          last_seen: serverTimestamp(),
          last_activity: serverTimestamp()  // initialize on login
        }).catch((err) => console.warn('[RTDB set online err]', err));
      }
    });

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
 * Updates BOTH last_seen (online presence) and last_activity (persistent visit timestamp).
 */
export const setRtdbOnline = async (uid, profile, activeCharacter = null) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    await update(userStatusRef, {
      state: 'online',
      last_seen: serverTimestamp(),
      last_activity: serverTimestamp(),  // persistent — used for "visited today" + Firestore sync
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
 * On logout: sets state='logged_out' and updates last_seen, but does NOT touch
 * last_activity so "visited today" and Firestore last_seen remain accurate.
 * On idle:   sets state='offline' without refreshing last_seen, so last_seen remains
 *            the timestamp of the user's last actual interaction.
 *
 * @param {string} uid
 * @param {boolean} isLogout - If true, cancels the server-side onDisconnect hook.
 */
export const setRtdbOffline = async (uid, isLogout = false) => {
  if (!uid || !rtdb) return;
  try {
    const userStatusRef = ref(rtdb, `status/${uid}`);
    if (isLogout && activeDisconnectCancel) {
      activeDisconnectCancel();
      activeDisconnectCancel = null;
    }
    // On logout: set state='logged_out' and record last_seen as the logout time.
    // On idle:   set state='offline' without refreshing last_seen, so last_seen remains
    //            the timestamp of the user's last actual interaction.
    const updates = {
      state: isLogout ? 'logged_out' : 'offline'
    };
    if (isLogout) {
      updates.last_seen = serverTimestamp();
    }
    await update(userStatusRef, updates);
  } catch (e) {
    console.warn('[setRtdbOffline err]', e);
  }
};

/**
 * Subscribes to the list of currently online users from RTDB (0 Firestore reads).
 * A user is considered online if last activity was within 15 minutes and they haven't explicitly logged out.
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

      const ONLINE_WINDOW_MS = 15 * 60 * 1000;
      const now = Date.now();
      const onlineList = [];

      Object.keys(data).forEach((uid) => {
        const u = data[uid];
        if (!u || u.role_id === 'banned') return;
        // User must not have explicitly logged out
        if (u.state === 'logged_out') return;

        const lastSeenMs = typeof u.last_seen === 'number'
          ? u.last_seen
          : (typeof u.last_activity === 'number'
              ? u.last_activity
              : (u.last_seen ? new Date(u.last_seen).getTime() : (u.last_activity ? new Date(u.last_activity).getTime() : 0))
            );
        const isWithin15Min = lastSeenMs > 0 && (now - lastSeenMs < ONLINE_WINDOW_MS);

        if (isWithin15Min) {
          onlineList.push({
            id: uid,
            nickname: u.nickname || 'User',
            avatar_url: u.avatar_url || '',
            role_id: u.role_id || 'player',
            post_count: u.post_count || 0,
            status_line: u.status_line || '',
            signature: u.signature || '',
            active_character: u.active_character || null,
            last_seen: lastSeenMs
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
 * A user is online if last activity was within 15 minutes and they haven't explicitly logged out.
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
      if (!val || val.role_id === 'banned' || val.state === 'logged_out') {
        callback(false);
        return;
      }
      const ONLINE_WINDOW_MS = 15 * 60 * 1000;
      const lastSeenMs = typeof val.last_seen === 'number'
        ? val.last_seen
        : (typeof val.last_activity === 'number'
            ? val.last_activity
            : (val.last_seen ? new Date(val.last_seen).getTime() : (val.last_activity ? new Date(val.last_activity).getTime() : 0))
          );
      const isWithin15Min = lastSeenMs > 0 && (Date.now() - lastSeenMs < ONLINE_WINDOW_MS);
      callback(isWithin15Min);
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
 * Subscribes to the raw status map for all users from RTDB (0 Firestore reads).
 * Useful for components like MembersPage to get real-time activity timestamps.
 */
export const subscribeToRtdbStatuses = (callback) => {
  if (!rtdb) {
    callback({});
    return () => {};
  }

  try {
    const statusRef = ref(rtdb, 'status');
    return onValue(statusRef, (snapshot) => {
      callback(snapshot.val() || {});
    }, (err) => {
      console.warn('[subscribeToRtdbStatuses error]', err);
      callback({});
    });
  } catch (err) {
    console.warn('[subscribeToRtdbStatuses caught]', err);
    callback({});
    return () => {};
  }
};

/**
 * Subscribes to the list of users active in the last 24 hours from RTDB.
 * Uses last_activity (NOT last_seen) so logout/disconnect never removes users.
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
        // Use last_activity for persistent daily tracking (unaffected by logout), with fallback to last_seen
        const lastActivityMs = typeof u.last_activity === 'number'
          ? u.last_activity
          : (typeof u.last_seen === 'number'
              ? u.last_seen
              : (u.last_activity ? new Date(u.last_activity).getTime() : (u.last_seen ? new Date(u.last_seen).getTime() : 0))
            );
        if (lastActivityMs >= cutoff) {
          dailyList.push({
            id: uid,
            nickname: u.nickname || 'User',
            avatar_url: u.avatar_url || '',
            role_id: u.role_id || 'player',
            post_count: u.post_count || 0,
            status_line: u.status_line || '',
            signature: u.signature || '',
            active_character: u.active_character || null,
            last_seen: lastActivityMs  // expose as last_seen for downstream compatibility
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
