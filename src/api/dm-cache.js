/**
 * DM Local Cache Management (localStorage)
 * 
 * Features:
 * - Caches up to 50 messages per conversation per user.
 * - Delta synchronization (immutable messages).
 * - Hard wipe on logout (prevents data leakage across accounts).
 */

const DM_CACHE_PREFIX = 'aerun_dm_';
const MAX_CACHED_MESSAGES = 50;

/**
 * Generates the cache key for a specific user and conversation.
 */
const getCacheKey = (uid, convId) => `${DM_CACHE_PREFIX}${uid}_${convId}`;

/**
 * Loads cached messages for a conversation.
 * Returns array of message objects or empty array.
 */
export const getCachedDmMessages = (uid, convId) => {
  if (!uid || !convId) return [];
  try {
    const raw = localStorage.getItem(getCacheKey(uid, convId));
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
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

    // Add existing
    current.forEach(m => {
      if (m.id) map.set(m.id, m);
    });

    // Merge new
    newMessages.forEach(m => {
      if (m.id) map.set(m.id, m);
    });

    const merged = Array.from(map.values());

    // Sort chronologically (oldest to newest)
    merged.sort((a, b) => {
      const aTime = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
      const bTime = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
      return aTime - bTime;
    });

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
