import { db, rtdb } from '../../firebase';
import { ref, remove, update } from 'firebase/database';
import { doc, setDoc, getDoc, onSnapshot, deleteDoc, updateDoc, serverTimestamp, collection, query, where, getDocs, writeBatch, orderBy } from 'firebase/firestore';
import { logAdminAction } from './audit';

const SETTINGS_DOC = 'settings/global';

export const getGlobalSettings = (callback) => {
  return onSnapshot(doc(db, SETTINGS_DOC), (doc) => {
    if (doc.exists()) {
      callback(doc.data());
    }
  });
};

export const updateGlobalSettings = async (settings, performerId) => {
  const docRef = doc(db, SETTINGS_DOC);

  // Compute a diff vs the current saved settings
  let changes = {};
  try {
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const old = snap.data();
      for (const key of Object.keys(settings)) {
        // Skip long URL fields — not useful in the log
        const v = settings[key];
        if (typeof v === 'string' && v.length > 120) continue;
        if (JSON.stringify(old[key]) !== JSON.stringify(v)) {
          changes[key] = { from: old[key] ?? null, to: v ?? null };
        }
      }
    }
  } catch {
    // If diff fails, still save — just log without details
  }

  await setDoc(docRef, settings, { merge: true });
  await logAdminAction('settings_updated', performerId, Object.keys(changes).length > 0 ? { changes } : {});

  // If "Require Admin Approval" was just turned OFF, automatically approve all currently pending users
  if (changes.requireApproval && changes.requireApproval.from === true && changes.requireApproval.to === false) {
    try {
      const pendingQuery = query(collection(db, 'users'), where('role_id', '==', 'pending'));
      const snap = await getDocs(pendingQuery);

      if (!snap.empty) {
        const batch = writeBatch(db);
        snap.forEach(userDoc => {
          batch.update(userDoc.ref, {
            role_id: 'player',
            updated_at: serverTimestamp()
          });
        });
        await batch.commit();
        await logAdminAction('bulk_user_approval', performerId, { count: snap.size });
      }
    } catch (err) {
      console.error('[Bulk Approval Error]', err);
    }
  }
};


// --- Invites section removed per user request ---

// --- User Management ---
export const approveUser = async (uid, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    role_id: 'player',
    updated_at: serverTimestamp()
  });
  await logAdminAction('user_approved', performerId, { targetId: uid });
};

export const deleteUser = async (uid, performerId) => {
  await deleteDoc(doc(db, 'users', uid));
  if (rtdb) {
    remove(ref(rtdb, `status/${uid}`)).catch(() => {});
  }
  await logAdminAction('user_deleted', performerId, { targetId: uid });
};

export const rejectUser = async (uid, performerId) => {
  await deleteDoc(doc(db, 'users', uid));
  if (rtdb) {
    remove(ref(rtdb, `status/${uid}`)).catch(() => {});
  }
  await logAdminAction('user_rejected', performerId, { targetId: uid });
};

export const banUser = async (uid, performerId) => {
  // Get current role to save it
  const userSnap = await getDoc(doc(db, 'users', uid));
  const currentRole = userSnap.exists() ? userSnap.data().role_id : 'player';

  await updateDoc(doc(db, 'users', uid), {
    role_id: 'banned',
    status: 'banned',
    previous_role_id: currentRole,
    updated_at: serverTimestamp()
  });
  if (rtdb) {
    update(ref(rtdb, `status/${uid}`), { role_id: 'banned', state: 'logged_out' }).catch(() => {});
  }
  await logAdminAction('user_banned', performerId, { targetId: uid });
};

export const unbanUser = async (uid, performerId) => {
  // Restore previous role
  const userSnap = await getDoc(doc(db, 'users', uid));
  const previousRole = userSnap.exists() ? (userSnap.data().previous_role_id || 'player') : 'player';

  await updateDoc(doc(db, 'users', uid), {
    role_id: previousRole,
    status: 'active',
    updated_at: serverTimestamp()
  });
  if (rtdb) {
    update(ref(rtdb, `status/${uid}`), { role_id: previousRole, state: 'offline' }).catch(() => {});
  }
  await logAdminAction('user_unbanned', performerId, { targetId: uid });
};

export const updateUserRole = async (uid, roleId, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    role_id: roleId,
    status: roleId === 'banned' ? 'banned' : (roleId === 'pending' ? 'pending' : 'active'),
    updated_at: serverTimestamp()
  });
  if (rtdb) {
    update(ref(rtdb, `status/${uid}`), { role_id: roleId }).catch(() => {});
  }
  await logAdminAction('user_role_updated', performerId, { targetId: uid, roleId });
};

// In-memory кэш ролей для текущей сессии.
// Роли меняются крайне редко (только через AdminPage), поэтому кэш безопасен.
let _rolesCache = null;

/** Принудительно сбросить кэш ролей (вызывать после addRole/updateRole/deleteRole). */
export const invalidateRolesCache = () => {
  _rolesCache = null;
};

// Оптимизированная версия с in-memory кэшем сессии:
export const subscribeToRoles = (callback) => {
  let isSubscribed = true;

  const fetchRoles = async () => {
    // Если кэш заполнен — немедленно отдаём его, без сетевого запроса
    if (_rolesCache) {
      if (isSubscribed) callback(_rolesCache);
      return;
    }

    try {
      const q = query(collection(db, 'roles'), orderBy('name', 'asc'));
      const snapshot = await getDocs(q);

      if (!isSubscribed) return;

      const rolesData = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
      _rolesCache = rolesData;
      callback(rolesData);
    } catch (err) {
      console.error('[subscribeToRoles]', err);
    }
  };

  fetchRoles();

  return () => {
    isSubscribed = false;
  };
};

export const addRole = async (roleData, performerId) => {
  const roleRef = doc(collection(db, 'roles'));
  await setDoc(roleRef, {
    ...roleData,
    is_system: false,
    created_at: serverTimestamp()
  });
  await logAdminAction('role_created', performerId, { targetId: roleRef.id, roleName: roleData.name });
  return roleRef.id;
};

export const updateRole = async (id, roleData, performerId) => {
  // Use updateDoc (not setDoc) to preserve is_system, created_at and other existing fields
  await updateDoc(doc(db, 'roles', id), {
    ...roleData,
    updated_at: serverTimestamp()
  });
  await logAdminAction('role_updated', performerId, { targetId: id, roleName: roleData.name });
};

export const deleteRole = async (id, isSystem, performerId) => {
  if (isSystem) {
    throw new Error('System roles cannot be deleted');
  }

  // Find the role to get its base_role_id
  const roleSnap = await getDoc(doc(db, 'roles', id));
  if (!roleSnap.exists()) return;

  const roleData = roleSnap.data();
  const baseRoleId = roleData.base_role_id || 'player';
  const roleName = roleData.name;

  // Move all users with this role to the base role
  const usersQuery = query(collection(db, 'users'), where('role_id', '==', id));
  const usersSnapshot = await getDocs(usersQuery);

  const batch = writeBatch(db);
  usersSnapshot.forEach((userDoc) => {
    batch.update(userDoc.ref, {
      role_id: baseRoleId,
      updated_at: serverTimestamp()
    });
  });
  await batch.commit();

  // Finally delete the role
  await deleteDoc(doc(db, 'roles', id));
  await logAdminAction('role_deleted', performerId, { targetId: id, roleName });
};

/**
 * Seed the system roles into Firestore using their canonical string IDs.
 * Only creates roles that don't yet exist — never overwrites existing data.
 * Pass DEFAULT_ROLES from constants/permissions.js.
 */
export const seedSystemRoles = async (defaultRoles) => {
  for (const role of defaultRoles) {
    const ref = doc(db, 'roles', role.id); // fixed ID: 'admin', 'moderator', 'player', 'spectator'
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        name: role.name,
        color: role.color,
        permissions: role.permissions,
        is_system: true,
        created_at: serverTimestamp()
      });
    }
  }
};
