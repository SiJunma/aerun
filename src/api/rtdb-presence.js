import { sendApi, pb } from './pocketbase';
import { createSharedPoll } from './shared-poll';

let heartbeatTimer = null;
let currentActiveCharacter = null;
let cachedOnlineUsers = [];
let cachedGuests = [];
const onlineSubscribers = new Set();
const guestSubscribers = new Set();

const notifyOnlineSubscribers = (users) => {
  cachedOnlineUsers = users;
  onlineSubscribers.forEach(cb => {
    try { cb(users); } catch { /* one bad subscriber must not starve the rest */ }
  });
};

const notifyGuestSubscribers = (guests) => {
  cachedGuests = guests;
  guestSubscribers.forEach(cb => {
    try { cb(guests); } catch { /* one bad subscriber must not starve the rest */ }
  });
};

// parseLastSeen normalises the server's date string into milliseconds. The stats
// panel drops guests outside its own window, so a value it cannot parse must
// never look like "seen just now".
const parseLastSeen = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const handlePresenceSnapshot = (presence) => {
  if (!presence) return;
  if (Array.isArray(presence.users)) {
    const list = presence.users.map(u => ({
      id: u.id,
      nickname: u.nickname || 'User',
      avatar_url: u.avatar_url || '',
      role_id: u.role || 'player',
      post_count: u.post_count || 0,
      status_line: u.status_line || '',
      signature: u.signature || '',
      active_character: u.active_character || null,
      // The server sends the real time of the member's last heartbeat. It used
      // to omit the field, and this line then substituted Date.now() — so every
      // connected member was reported as "seen this exact second" regardless of
      // when they actually last beat, and a value nobody measured was presented
      // as a measurement. 0 now means "unknown", which is honest: the members
      // table falls through to the durable users.last_seen for an answer.
      last_seen: parseLastSeen(u.last_seen)
    }));
    notifyOnlineSubscribers(list);
  }
  if (Array.isArray(presence.guests)) {
    const list = presence.guests.map(guest => ({
      id: guest.id,
      last_seen: parseLastSeen(guest.last_seen)
    }));
    notifyGuestSubscribers(list);
  }
};

// Snapshot seeding: ONE shared GET /api/aerun/status loop serves every presence
// consumer, and heartbeat responses feed the same caches, so the poll only covers
// the gaps between beats and there is never more than one fetch in flight.
//
// The banner used to run a SECOND, independent 25-second loop against this same
// endpoint to decide whether to show its "connection lost" strip. Two clocks, one
// endpoint, for one piece of information — so the status snapshot is a shared
// resource now, and the banner is simply another subscriber. Its failure signal
// is delivered alongside the value, which is what lets it keep working.
const statusPoll = createSharedPoll({
  name: 'status',
  fetch: async () => {
    const res = await sendApi('/api/aerun/status');
    if (res?.presence) handlePresenceSnapshot(res.presence);
    return res;
  },
  intervalMs: 20000,
  initialValue: null,
});

// The loop is reference-counted by the shared resource itself: the first
// subscriber starts it, the last one to leave stops it.
const startStatusPolling = () => statusPoll.subscribe(() => {});

const stopStatusPollingIfIdle = () => {
  if (onlineSubscribers.size > 0 || guestSubscribers.size > 0) return;
  // Nothing is watching the status loop any more.
  statusPoll.stopIfIdle();
};

// Lets the connection banner ride the presence snapshot instead of polling
// `/api/aerun/status` a second time. `onStatus` receives (snapshot, error).
export const subscribeToStatus = (onStatus) => statusPoll.subscribe(onStatus);

// An out-of-band read of the same resource, for the browser's `online` event —
// "the network just came back" is worth a read now rather than at the next tick.
export const probeStatus = () => statusPoll.refresh();

const sendHeartbeat = async (character = null) => {
  if (!pb.authStore.isValid) return;
  try {
    const res = await sendApi('/api/aerun/presence/heartbeat', {
      method: 'POST',
      body: {
        active_character: character || currentActiveCharacter || null
      }
    });
    if (res?.presence) {
      handlePresenceSnapshot(res.presence);
    }
  } catch {
    // Non-fatal presence heartbeat failure: the caller keeps its optimistic
    // local state and the next 30s tick retries.
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

/**
 * Stops the heartbeat, and on an explicit logout LEAVES.
 *
 * The two arguments were both ignored (`_uid`, `_isLogout`), which is why the
 * legacy contract "the last action is what counts" only appeared to hold: the
 * final beat happened to be close enough to the sign-out click that the durable
 * `last_seen` was roughly right. It was right by luck, not by design.
 *
 * It used to send a final HEARTBEAT, which is exactly backwards. The heartbeat
 * handler writes `onlineMembers[e.Auth.Id]` with LastSeen=now, so signing out
 * re-REGISTERED the account as online: it stayed in "Online now" for the whole
 * presenceTTL (75s), and every other browser polling /status counted a
 * signed-OUT member as present, because the server genuinely still listed them.
 * Guests never had this bug — they leave through /presence/guest/leave, which
 * removes the row instead of refreshing it. Members needed the same call, so
 * they have one now: /presence/leave deletes the presence row AND writes the
 * durable users.last_seen, in one request, while the token is still valid.
 *
 * `isLogout` distinguishes the two callers on purpose. Idle timeout is not a
 * departure: the user is still there, just inactive, and the next interaction
 * re-establishes presence through `recordActivity`. Announcing a departure there
 * would drop a member who is merely thinking out of the online list, and would
 * stamp their durable `last_seen` at a moment they are demonstrably still here.
 */
export const setRtdbOffline = async (uid, isLogout = false) => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Deliberately BEFORE the authStore is cleared by the caller: this is the only
  // moment the request is still authenticated, so a leave sent later would 401.
  // A failure here must not block the sign-out itself, so it is swallowed —
  // the cost of skipping it is a presence row that ages out on its own in 75s,
  // not a stuck session.
  if (isLogout && uid) {
    try {
      await sendApi('/api/aerun/presence/leave', { method: 'POST', body: {} });
    } catch {
      // Best-effort, like every other presence write: the cost of skipping
      // it is a presence row that ages out on its own, never a stuck session.
    }
  }
};

/**
 * Subscribes to the list of currently online users.
 *
 * Reads the shared presence cache instead of opening its own listener: the
 * current cache is delivered immediately, and the shared /api/aerun/status poll
 * starts (or is already running) so the first snapshot lands right away. Every
 * later snapshot — poll tick or heartbeat response — re-delivers through
 * notifyOnlineSubscribers.
 */
export const subscribeToOnlineUsers = (callback) => {
  onlineSubscribers.add(callback);
  startStatusPolling();
  // Immediate delivery of the last snapshot; a throwing subscriber is isolated.
  try { callback(cachedOnlineUsers); } catch { /* reported, not fatal */ }

  return () => {
    onlineSubscribers.delete(callback);
    stopStatusPollingIfIdle();
  };
};

export const subscribeToUserOnlineStatus = (uid, callback) => {
  if (!uid) {
    callback(false);
    return () => {};
  }

  // Derived from the online-user cache: false until the first snapshot lands,
  // then re-evaluated on every snapshot.
  return subscribeToOnlineUsers((users) => {
    callback(users.some(u => u.id === uid));
  });
};

export const subscribeToRtdbStatuses = (callback) =>
  subscribeToOnlineUsers((users) => {
    const map = {};
    users.forEach(u => {
      map[u.id] = {
        state: 'online',
        nickname: u.nickname,
        last_seen: u.last_seen
      };
    });
    callback(map);
  });

/**
 * "Visited today" is NOT this subscription.
 *
 * This used to exist as `subscribeToDailyActiveUsers`, a one-line alias of
 * subscribeToOnlineUsers, and the stats panel called it for the "Visited today"
 * row. That made the panel print the connected-now members twice under two
 * different labels, and it made the number change meaning with the label: the
 * "today" row could never show anybody who had already left, which is most of
 * the people a day is made of.
 *
 * The daily list is a different clock with a different source — the durable
 * users.last_seen column over a 24h window — so it is served by
 * GET /api/aerun/forum-stats as stats.dailyActiveUsers and read through the
 * forum state, not through live presence. Presence cannot answer it at all:
 * this map is windowed to presenceTTL and is empty after a restart.
 */

// Guest presence (anonymous visitors).
//
// A guest has no account to heartbeat with, so the browser generates an opaque
// per-browser id (kept in localStorage by AuthProvider) and the backend stores
// one `guest_presence` row per id. The contract mirrors the legacy RTDB node:
// a beat refreshes `last_seen`, a leave removes the row, and the counter reads
// the rows seen inside the last 15 minutes.
//
// Two deliberate differences from the RTDB implementation:
//   - a 60s heartbeat replaces the one-shot write plus `onDisconnect()`, because
//     HTTP has no server-side disconnect event to hook;
//   - unsubscribing only stops the timer and the listeners. It does not delete
//     the row: the unsubscribe runs again on every effect re-run (twice under
//     React StrictMode in dev), and a delete racing the next beat would drop a
//     live visitor for a whole interval. Only pagehide and login remove it.
const GUEST_HEARTBEAT_MS = 60 * 1000;

let guestHeartbeatTimer = null;
let guestDetachListeners = null;

const sendGuestHeartbeat = async (guestId) => {
  try {
    const res = await sendApi('/api/aerun/presence/heartbeat', {
      method: 'POST',
      body: { guest_id: guestId }
    });
    if (res?.presence) {
      handlePresenceSnapshot(res.presence);
    }
  } catch {
    // Non-fatal: presence is best effort and the next beat retries.
  }
};

const sendGuestLeaveBeacon = (guestId) => {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    // sendBeacon can only POST and cannot set headers; a string body also keeps
    // the request CORS-simple, so pagehide never waits on a preflight.
    navigator.sendBeacon(
      `${pb.baseURL}/api/aerun/presence/guest/leave`,
      JSON.stringify({ guest_id: guestId })
    );
  } catch {
    // A tab that is going away has nobody left to report to.
  }
};

const stopGuestHeartbeat = () => {
  if (guestHeartbeatTimer) {
    clearInterval(guestHeartbeatTimer);
    guestHeartbeatTimer = null;
  }
  if (guestDetachListeners) {
    guestDetachListeners();
    guestDetachListeners = null;
  }
};

/**
 * Subscribes to the active guests as [{ id, last_seen }] with last_seen in
 * milliseconds — the shape the stats panel filters on. Same cache + shared
 * status poll as subscribeToOnlineUsers, through the guest subscriber set.
 */
export const subscribeToActiveGuestsRtdb = (callback) => {
  guestSubscribers.add(callback);
  startStatusPolling();
  // Immediate delivery of the last snapshot; a throwing subscriber is isolated.
  try { callback(cachedGuests); } catch { /* reported, not fatal */ }

  return () => {
    guestSubscribers.delete(callback);
    stopStatusPollingIfIdle();
  };
};

/**
 * Starts presence tracking for an anonymous visitor and returns its unsubscribe.
 * Idempotent: a second call replaces the previous registration.
 */
export const initRtdbGuestPresence = (guestId) => {
  stopGuestHeartbeat();
  if (!guestId) return () => {};

  const beat = () => { sendGuestHeartbeat(guestId); };
  const onVisibilityChange = () => {
    // Coming back to a tab is the most likely moment for the row to be stale.
    if (document.visibilityState === 'visible') beat();
  };
  const onPageHide = () => sendGuestLeaveBeacon(guestId);

  beat();
  guestHeartbeatTimer = setInterval(beat, GUEST_HEARTBEAT_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  guestDetachListeners = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  };

  return () => {
    stopGuestHeartbeat();
  };
};

/**
 * Removes guest presence: called when a visitor logs in (they are a member from
 * then on) and when a tab is closed for good.
 */
export const removeRtdbGuestPresence = async (guestId) => {
  stopGuestHeartbeat();
  if (!guestId) return;
  try {
    await sendApi('/api/aerun/presence/guest/leave', {
      method: 'POST',
      body: { guest_id: guestId }
    });
  } catch {
    // If this never lands, the row ages out of the server window by itself.
  }
};

export const recordActivity = async (_uid) => {
  await sendHeartbeat();
};
