/* global __APP_BUILD_TIME__ */
/**
 * DM Local Cache Management (localStorage)
 * 
 * Features:
 * - Caches up to 50 messages per conversation per user.
 * - Delta synchronization (immutable messages).
 * - Hard wipe on logout (prevents data leakage across accounts).
 * - Build versioning: the whole DM cache is dropped when the app build
 *   changes, so stale/malformed entries never survive a deploy.
 */

/**
 * Timestamps serialize to a plain { seconds, nanoseconds } object
 * or ISO string via JSON.stringify and lose methods.
 * Revives values so .toMillis() and .toDate() work consistently.
 */
const reviveTimestamp = (value) => {
  if (value == null) return value;
  if (typeof value.toMillis === 'function') return value;
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    const millis = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    return {
      seconds: value.seconds,
      nanoseconds: value.nanoseconds || 0,
      toMillis: () => millis,
      toDate: () => new Date(millis),
      toISOString: () => new Date(millis).toISOString()
    };
  }
  const date = new Date(value);
  const millis = date.getTime();
  if (Number.isNaN(millis)) return value;
  return {
    seconds: Math.floor(millis / 1000),
    nanoseconds: (millis % 1000) * 1e6,
    toMillis: () => millis,
    toDate: () => date,
    toISOString: () => date.toISOString()
  };
};

/**
 * Chronological comparator (oldest -> newest), NaN-safe.
 */
const byTimestamp = (a, b) => {
  const aTime = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
  const bTime = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
  return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
};

let buildVerified = false;

/**
 * Verifies that cached data was written by the current build.
 * On mismatch the entire DM cache is dropped; the next Firestore
 * snapshot re-populates it with actual data.
 */
const ensureBuildVersion = () => {
  if (buildVerified) return;
  buildVerified = true;
  try {
    const savedBuild = localStorage.getItem(DM_CACHE_BUILD_KEY);
    if (savedBuild === CURRENT_BUILD) return;
    clearAllDmCache();
    localStorage.setItem(DM_CACHE_BUILD_KEY, CURRENT_BUILD);
    console.info('[dm-cache] build changed, cache reset', { savedBuild, current: CURRENT_BUILD });
  } catch (err) {
    console.warn('[dm-cache ensureBuildVersion err]', err);
  }
};

/**
 * Loads cached messages for a conversation.
 * Revives serialized Timestamps and returns messages in chronological order.
 * Returns array of message objects or empty array.
 */
export const getCachedDmMessages = (uid, convId) => {
  if (!uid || !convId) return [];
  ensureBuildVersion();
  try {
    const raw = localStorage.getItem(getCacheKey(uid, convId));
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter(m => m && m.id)
      .map(m => (m.timestamp ? { ...m, timestamp: reviveTimestamp(m.timestamp) } : m))
      .sort(byTimestamp);
  } catch (err) {
    console.warn('[getCachedDmMessages parse err]', err);
    return [];
  }
};

/**
 * Saves or merges messages into the local cache for a conversation.
 * Keeps at most MAX_CACHED_MESSAGES (newest first / oldest pruned).
 */
export const setCachedDmMessages = (uid, convId, newMessages) => {
  if (!uid || !convId || !Array.isArray(newMessages)) return;
  try {
    const current = getCachedDmMessages(uid, convId);
    const map = new Map();

    // Add existing (already revived by getCachedDmMessages)
    current.forEach(m => {
      if (m.id) map.set(m.id, m);
    });

    // Merge new (revive any plain-object timestamps defensively)
    newMessages.forEach(m => {
      if (m.id) map.set(m.id, m.timestamp ? { ...m, timestamp: reviveTimestamp(m.timestamp) } : m);
    });

    const merged = Array.from(map.values());

    // Sort chronologically (oldest to newest)
    merged.sort(byTimestamp);

    // Keep only the last MAX_CACHED_MESSAGES
    const trimmed = merged.length > MAX_CACHED_MESSAGES 
      ? merged.slice(merged.length - MAX_CACHED_MESSAGES) 
      : merged;

    localStorage.setItem(getCacheKey(uid, convId), JSON.stringify(trimmed));
  } catch (err) {
    console.warn('[setCachedDmMessages err]', err);
  }
};

/**
 * Returns the latest timestamp from cached messages to enable delta fetching.
 */
export const getLatestCachedTimestamp = (uid, convId) => {
  const cached = getCachedDmMessages(uid, convId);
  if (cached.length === 0) return null;
  const lastMsg = cached[cached.length - 1];
  return lastMsg.timestamp || null;
};

/**
 * Hard wipe of all DM caches in the browser.
 * Must be called during AuthProvider signOut().
 */
export const clearAllDmCache = () => {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(DM_CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (err) {
    console.warn('[clearAllDmCache err]', err);
  }
};
