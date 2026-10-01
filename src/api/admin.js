import { sendApi } from './pocketbase';
import { logAdminAction } from './audit';
import { DEFAULT_ROLES } from '../constants/permissions';

const SETTINGS_KEY = 'aerun_global_settings';

const DEFAULT_GLOBAL_SETTINGS = {
  forumName: 'Aerun Forum',
  registrationEnabled: true,
  requireApproval: false,
  maintenanceMode: false
};

export const getGlobalSettings = (callback) => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const data = raw ? JSON.parse(raw) : DEFAULT_GLOBAL_SETTINGS;
    callback(data);
  } catch {
    callback(DEFAULT_GLOBAL_SETTINGS);
  }
  // Settings are read from localStorage and delivered once, so there is
  // nothing to unsubscribe from. The no-op is kept because callers treat the
  // return value as a cleanup handle.
  return () => {};
};

export const updateGlobalSettings = async (settings, performerId) => {
  try {
    const currentRaw = localStorage.getItem(SETTINGS_KEY);
    const current = currentRaw ? JSON.parse(currentRaw) : DEFAULT_GLOBAL_SETTINGS;
    const merged = { ...current, ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    await logAdminAction('settings_updated', performerId, { changes: settings });
  } catch (err) {
    console.warn('[updateGlobalSettings err]', err);
  }
};

// --- User Management ---
export const approveUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { role: 'player', status: 'active' }
  });
  await logAdminAction('user_approved', performerId, { targetId: uid });
};

export const deleteUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'DELETE'
  });
  await logAdminAction('user_deleted', performerId, { targetId: uid });
};

export const rejectUser = async (uid, performerId) => {
  await deleteUser(uid, performerId);
};

export const banUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { role: 'banned', status: 'banned' }
  });
  await logAdminAction('user_banned', performerId, { targetId: uid });
};

export const unbanUser = async (uid, performerId) => {
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { role: 'player', status: 'active' }
  });
  await logAdminAction('user_unbanned', performerId, { targetId: uid });
};

export const updateUserRole = async (uid, roleId, performerId) => {
  const status = roleId === 'banned' ? 'banned' : (roleId === 'pending' ? 'pending' : 'active');
  await sendApi(`/api/aerun/admin/users/${uid}`, {
    method: 'PATCH',
    body: { role: roleId, status }
  });
  await logAdminAction('user_role_updated', performerId, { targetId: uid, roleId });
};

let _rolesCache = null;

export const invalidateRolesCache = () => {
  _rolesCache = null;
};

export const subscribeToRoles = (callback) => {
  let isSubscribed = true;

  const fetchRoles = async () => {
    if (_rolesCache) {
      if (isSubscribed) callback(_rolesCache);
      return;
    }

    try {
      const res = await sendApi('/api/aerun/roles');
      const records = res?.items || [];
      const rolesData = records.map(d => ({
        id: d.role_id || d.id,
        name: d.name,
        color: d.color,
        rank: d.rank,
        is_system: d.is_system,
        permissions: d.permissions || []
      }));
      _rolesCache = rolesData.length > 0 ? rolesData : DEFAULT_ROLES;
      if (isSubscribed) callback(_rolesCache);
    } catch {
      _rolesCache = DEFAULT_ROLES;
      if (isSubscribed) callback(_rolesCache);
    }
  };

  fetchRoles();

  return () => {
    isSubscribed = false;
  };
};

export const addRole = async (roleData, performerId) => {
  try {
    const res = await sendApi('/api/aerun/roles', {
      method: 'POST',
      body: {
        ...roleData,
        role_id: roleData.name.toLowerCase().replace(/[^a-z0-9]/g, '_')
      }
    });
    invalidateRolesCache();
    await logAdminAction('role_created', performerId, { targetId: res?.id, roleName: roleData.name });
    return res?.id;
  } catch (err) {
    console.warn('[addRole err]', err);
  }
};

export const updateRole = async (id, roleData, performerId) => {
  try {
    await sendApi(`/api/aerun/roles/${id}`, {
      method: 'PATCH',
      body: roleData
    });
    invalidateRolesCache();
    await logAdminAction('role_updated', performerId, { targetId: id, roleName: roleData.name });
  } catch (err) {
    console.warn('[updateRole err]', err);
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
    invalidateRolesCache();
    await logAdminAction('role_deleted', performerId, { targetId: id });
  } catch (err) {
    console.warn('[deleteRole err]', err);
  }
};

export const seedSystemRoles = async (_defaultRoles) => {
  // System roles are already seeded by Go backend migration
};
