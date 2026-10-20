import { sendApi } from './pocketbase';
import { logAdminAction } from './audit';
import { DEFAULT_ROLES } from '../constants/permissions';

export const DEFAULT_GLOBAL_SETTINGS = {
  forumName: { en: 'Aerun Forum', ru: 'Aerun Forum' },
  registrationEnabled: true,
  requireApproval: true,
  whitelistMode: false,
  maintenanceMode: false,
  maxCharsPerPost: 15000,
  postsPerPage: 20,
  topicsPerPage: 20,
  maxPostsPerTopic: 1000,
  maxCharactersPerUser: 10,
  enableReputation: true,
  reputationStyle: 'both',
  enableCharacters: true,
  enableDice: true,
  allowGifAvatars: true,
  allowGifInPosts: true,
  allowUserCustomDesign: true,
  defaultDesignId: '',
  logoUrl: '',
  // Admin-uploaded identity placeholder images (plan I5/D2). Empty means "no
  // custom image", and the frontend falls back to its neutral default. Read by
  // every visitor from the public settings snapshot, so guests render a removed
  // account the same way a signed-in member does.
  deletedAvatar: '',
  guestAvatar: '',
  bgLight: '',
  bgDark: '',
  bgNeutral: '',
  bgOpacityLight: 0.5,
  bgOpacityDark: 0.5,
  bgOpacityNeutral: 0.5
};

let _settingsCache = null;
const _settingsSubscribers = new Set();

export const fetchGlobalSettings = async () => {
  try {
    const res = await sendApi('/api/aerun/settings');
    if (res?.settings) {
      _settingsCache = { ...DEFAULT_GLOBAL_SETTINGS, ...res.settings };
    }
  } catch (err) {
    console.warn('[fetchGlobalSettings err]', err);
    if (!_settingsCache) {
      _settingsCache = DEFAULT_GLOBAL_SETTINGS;
    }
  }
  const snapshot = _settingsCache;
  _settingsSubscribers.forEach(cb => {
    try { cb(snapshot); } catch (e) { console.error(e); }
  });
  return snapshot;
};

export const getGlobalSettings = (callback) => {
  _settingsSubscribers.add(callback);
  if (_settingsCache) {
    callback(_settingsCache);
  } else {
    fetchGlobalSettings();
  }
  return () => {
    _settingsSubscribers.delete(callback);
  };
};

export const updateGlobalSettings = async (settings, _performerId) => {
  try {
    const res = await sendApi('/api/aerun/admin/settings', {
      method: 'PATCH',
      body: settings
    });
    if (res?.settings) {
      _settingsCache = { ...DEFAULT_GLOBAL_SETTINGS, ...res.settings };
      _settingsSubscribers.forEach(cb => {
        try { cb(_settingsCache); } catch (e) { console.error(e); }
      });
    }
    return _settingsCache;
  } catch (err) {
    console.warn('[updateGlobalSettings err]', err);
    throw err;
  }
};

/**
 * uploadIdentityPlaceholder stores an admin-uploaded image as one of the two
 * identity placeholder avatars and returns the new reference.
 *
 * `kind` is 'deleted' (shown for a removed account) or 'guest' (shown for an
 * anonymous visitor). The bytes go to the server as multipart, exactly like a
 * user avatar: the reference column is a short /api/files path and can never
 * hold the bytes themselves, so a client-side data URL is never produced. The
 * command is a replace, so a retried upload converges on one stored file.
 */
export const uploadIdentityPlaceholder = async (kind, blob, filename = `${kind}.png`) => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/admin/settings/placeholder/${kind}`, {
    method: 'PUT',
    body: form
    // No Content-Type: the browser sets it with the multipart boundary.
  });
  // Refresh the shared cache so every subscriber (including the forum chrome)
  // sees the new placeholder without a second round trip.
  if (res?.avatar_url) {
    _settingsCache = { ...DEFAULT_GLOBAL_SETTINGS, ...(_settingsCache || {}), [kind === 'guest' ? 'guestAvatar' : 'deletedAvatar']: res.avatar_url };
    _settingsSubscribers.forEach(cb => {
      try { cb(_settingsCache); } catch (e) { console.error(e); }
    });
  }
  return res?.avatar_url || '';
};

// --- Root handover ---

/**
 * The exact phrase the server requires to confirm a root handover.
 *
 * Exported so the modal asks for the same string the backend demands. A second
 * hardcoded copy would be free to drift, and the failure would be a dialog that
 * says "confirmed" while the server answers 400 — which is precisely the kind
 * of false success this command is meant to prevent.
 */
export const TRANSFER_PHRASE = 'TRANSFER ROOT';

/**
 * Hand the chief-admin role to another account. ONE-WAY and irreversible: the
 * caller becomes an admin and cannot take the role back, because
 * `PATCH /admin/users/{id}` refuses to write `root` for anybody.
 *
 * @param {{successorId: string, password: string, confirmPhrase: string}} input
 */
export const transferRoot = async ({ successorId, password, confirmPhrase }) => {
  return await sendApi('/api/aerun/admin/transfer-root', {
    method: 'POST',
    body: {
      successor_id: successorId,
      password,
      confirm_phrase: confirmPhrase
    }
  });
};

// --- User Management ---
// Approving clears the STATUS only. The account was already created with the
// player role (register.go), so naming a role here would also overwrite it —
// which is invisible in the common case and destructive for an admin who
// happens to approve an account that was manually re-roled meanwhile.
export const approveUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { status: 'active' }
  });
  await logAdminAction('user_approved', performerId, { targetId: uid });
};

export const deleteUser = async (uid, performerId, { deletePosts = false } = {}) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'DELETE',
    body: { delete_posts: deletePosts }
  });
  await logAdminAction('user_deleted', performerId, { targetId: uid, delete_posts: deletePosts });
};

export const rejectUser = async (uid, performerId) => {
  await deleteUser(uid, performerId);
};

// `banned` and `pending` are ACCOUNT STATUSES, not roles (see the Role/Status
// split in internal/auth: the legacy pseudo-roles are deliberately absent from
// the role vocabulary). Sending role:'banned' made every ban fail with 400
// "invalid role value", because the role column validates against the roles
// registry, where no such row exists.
//
// The role is left untouched. NarrowForStatus strips EVERY permission for a
// banned account, so the role never decides what a ban grants; keeping it is
// what lets Unban restore the account to where it actually was instead of
// flattening everyone to Player.
export const banUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { status: 'banned' }
  });
  await logAdminAction('user_banned', performerId, { targetId: uid });
};

export const unbanUser = async (uid, performerId) => {
  // status only, for the same reason: the role was never changed by the ban.
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { status: 'active' }
  });
  await logAdminAction('user_unbanned', performerId, { targetId: uid });
};

// The role and the status are separate axes. Only a change to the ROLE implies
// a status flip; assigning a real role never implies banning anyone.
// notifyRoleChange defaults to true (the AdminPage checkbox is checked by
// default); omitting the flag still notifies the member.
export const updateUserRole = async (uid, roleId, performerId, notifyRoleChange = true) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { role: roleId, notify_role_change: notifyRoleChange }
  });
  await logAdminAction('user_role_updated', performerId, { targetId: uid, roleId });
};

let _rolesCache = null;

// The role registry is mutable, so this is not a load-once subscription: the
// admin panel creates, edits and deletes roles, and AuthProvider holds the
// single copy every consumer renders from. Keeping the fetch fire-and-forget
// meant a mutation cleared _rolesCache and nothing re-read it, so the table
// kept painting the pre-mutation list until a full page reload.
//
// Subscribers are kept in a set rather than in per-subscription closures so
// refreshRoles() can push to all of them. Without that, each caller would need
// its own timer and they would drift.
const _roleSubscribers = new Set();

const normalizeRole = d => ({
  id: d.role_id || d.id,
  name: d.name,
  color: d.color,
  rank: d.rank,
  is_system: d.is_system,
  // The base role is what the admin panel pre-fills a derived role from and
  // what the delete-revert falls back to. Dropping it here made both read
  // undefined for every role that had one.
  base_role_id: d.base_role_id || '',
  max_characters_limit: d.max_characters_limit,
  permissions: d.permissions || []
});

// The role EDITOR's list: GET /admin/roles, behind `manage_roles`.
//
// The public `/roles` route now serves badge fields only (role_id, name, rank,
// color) because it is ungated — a badge must render for a signed-out visitor.
// Everything the editor needs beyond that (permissions, is_system, base_role_id,
// max_characters_limit, and the record `id` the mutation routes address) lives
// here.
//
// It is a separate read rather than a wider public one because those fields ARE
// the security model: publishing them to everyone let a guest read exactly what
// each role may do and which roles are privileged, before choosing an account to
// target. A member's own effective permission set comes from `/me` instead, which
// is the answer to a different question — see subscribeToEffectivePermissions.
export const fetchAdminRoles = async () => {
  const res = await sendApi('/api/aerun/admin/roles');
  const records = res?.items || [];
  return records.map(normalizeRole);
};

const fetchRoles = async () => {
  try {
    const res = await sendApi('/api/aerun/roles');
    const records = res?.items || [];
    // An empty registry is a real state (every role deleted is impossible —
    // system roles cannot be deleted — but a failed read is not), so the
    // fallback only guards the error path and a genuinely empty response.
    _rolesCache = records.length > 0 ? records.map(normalizeRole) : DEFAULT_ROLES;
  } catch {
    _rolesCache = DEFAULT_ROLES;
  }
  // One call per subscriber with the whole list, matching what
  // subscribeToRoles delivers on first paint. Iterating the roles instead would
  // fire N callbacks each carrying the full array, so a five-role registry
  // would re-render AuthProvider five times per mutation.
  const snapshot = _rolesCache;
  _roleSubscribers.forEach(cb => cb(snapshot));
  return snapshot;
};

// Forces a re-read and notifies every subscriber. Called after each mutation so
// the panel reflects the change without a reload.
export const refreshRoles = async () => {
  _rolesCache = null;
  return fetchRoles();
};

export const subscribeToRoles = (callback) => {
  _roleSubscribers.add(callback);

  if (_rolesCache) {
    callback(_rolesCache);
  } else {
    fetchRoles();
  }

  return () => {
    _roleSubscribers.delete(callback);
  };
};

// Each mutation re-reads the registry rather than just clearing the cache.
// These functions used to swallow the error into console.warn and fall through,
// which hid two failures at once: a rejected request still resolved, so the
// caller showed a success toast, and nothing re-read the cache, so the table
// kept the stale list. The error is re-thrown for the caller to surface.
export const addRole = async (roleData, performerId) => {
  try {
    const res = await sendApi('/api/aerun/roles', {
      method: 'POST',
      body: {
        ...roleData,
        role_id: roleData.name.toLowerCase().replace(/[^a-z0-9]/g, '_')
      }
    });
    await logAdminAction('role_created', performerId, { targetId: res?.id, roleName: roleData.name });
    await refreshRoles();
    return res?.id;
  } catch (err) {
    console.warn('[addRole err]', err);
    throw err;
  }
};

export const updateRole = async (id, roleData, performerId) => {
  try {
    await sendApi(`/api/aerun/roles/${id}`, {
      method: 'PATCH',
      body: roleData
    });
    await logAdminAction('role_updated', performerId, { targetId: id, roleName: roleData.name });
    await refreshRoles();
  } catch (err) {
    console.warn('[updateRole err]', err);
    throw err;
  }
};

export const deleteRole = async (id, isSystem, performerId) => {
  if (isSystem) {
    throw new Error('System roles cannot be deleted');
  }
  try {
    await sendApi(`/api/aerun/roles/${id}`, {
      method: 'DELETE'
    });
    await logAdminAction('role_deleted', performerId, { targetId: id });
    await refreshRoles();
  } catch (err) {
    console.warn('[deleteRole err]', err);
    // A refusal (a category still grants this role, or holders have no base
    // to fall back to) is an expected outcome the admin needs to read, not a
    // warning to swallow.
    throw err;
  }
};

export const seedSystemRoles = async (_defaultRoles) => {
  // System roles are already seeded by Go backend migration
};

// --- Email Template Management ---

/**
 * Fetches the current email wrapper, whether it's custom, and the default wrapper.
 * @returns {{ wrapper: string, is_custom: boolean, default_wrapper: string }}
 */
export const fetchEmailTemplates = async () => {
  try {
    return await sendApi('/api/aerun/admin/email-templates');
  } catch (err) {
    console.warn('[fetchEmailTemplates err]', err);
    throw err;
  }
};

/**
 * Saves a new global email wrapper. The wrapper must contain {CONTENT}.
 * Sending an empty string resets to the built-in default.
 * @param {string} wrapper - The HTML wrapper string.
 * @returns {{ wrapper: string, is_custom: boolean }}
 */
export const updateEmailWrapper = async (wrapper) => {
  try {
    return await sendApi('/api/aerun/admin/email-templates', {
      method: 'PUT',
      body: { wrapper }
    });
  } catch (err) {
    console.warn('[updateEmailWrapper err]', err);
    throw err;
  }
};

/**
 * Sends a test email to the current admin's address using the active wrapper.
 * @returns {{ sent_to: string }}
 */
export const sendTestEmail = async () => {
  try {
    return await sendApi('/api/aerun/admin/email-templates/test', {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[sendTestEmail err]', err);
    throw err;
  }
};
