// Computes a storage scope from the current page origin so that localStorage /
// sessionStorage keys never collide between:
//   - a local dev instance and the release instance (different host:port)
//   - two different forums served from the same engine on the same origin
//   - different accounts on the same forum (when a uid is supplied)
export const getStorageScope = () => {
  try {
    const url = new URL(window.location.origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname}_${port}`.replace(/[^a-zA-Z0-9_]/g, '_');
  } catch {
    return 'default';
  }
};

// Builds a storage key prefixed with the forum scope and optionally an account id.
// Usage:
//   makeStorageKey('cat_groups')                       -> aerun_<scope>_cat_groups
//   makeStorageKey('language', user?.uid || 'guest')   -> aerun_<scope>_language_<uid>
//   makeStorageKey('guest_nickname', 'guest')          -> aerun_<scope>_guest_nickname_guest
export const makeStorageKey = (prefix, uid = null) => {
  const scope = getStorageScope();
  const account = uid == null ? '' : `_${String(uid)}`;
  return `aerun_${scope}_${prefix}${account}`;
};

// One-off migration: copies values left under the old unscoped keys onto the
// new scoped keys (`aerun_<scope>_<prefix>[_<uid>]`), then removes the old keys.
// Runs once per page load; safe to call repeatedly — missing keys are simply
// skipped, and overwriting an already-scoped key with itself is a no-op.
export const migrateLegacyGuestStorage = () => {
  if (typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined') return;

  const legacyLocalKeys = [
    'guest_id',
    'guest_theme',
    'language',
    'preferred_language',
    'aerun_guest_nickname',
  ];

  const legacySessionKeys = [
    'auth_error',
    'pending_nickname',
    'is_registering',
    'pending_theme',
    'pending_language',
    'language',
    'preferred_language',
    'pending_message',
    'maintenance_logout',
    'banned_logout',
    'deleted_logout',
  ];

  try {
    for (const key of legacyLocalKeys) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const isScoped = key.startsWith(`aerun_${getStorageScope()}_`);
      // If the key is already scoped under the current forum, leave it alone.
      if (isScoped) continue;
      localStorage.setItem(makeStorageKey(key, 'guest'), value);
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn('[migrateLegacyGuestStorage localStorage] failed', err);
  }

  try {
    for (const key of legacySessionKeys) {
      const value = sessionStorage.getItem(key);
      if (value === null) continue;
      const isScoped = key.startsWith(`aerun_${getStorageScope()}_`);
      if (isScoped) continue;
      sessionStorage.setItem(makeStorageKey(key, 'guest'), value);
      sessionStorage.removeItem(key);
    }
  } catch (err) {
    console.warn('[migrateLegacyGuestStorage sessionStorage] failed', err);
  }
};
