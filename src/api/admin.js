import { db } from '../../firebase';
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
  await setDoc(docRef, settings, { merge: true });
  await logAdminAction('settings_updated', performerId);
};

// --- Invites section removed per user request ---

// --- User Management ---
export const approveUser = async (uid, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    status: 'active',
    updated_at: serverTimestamp()
  });
  await logAdminAction('user_approved', performerId, { targetId: uid });
};

export const deleteUser = async (uid, performerId) => {
  await deleteDoc(doc(db, 'users', uid));
  await logAdminAction('user_deleted', performerId, { targetId: uid });
};

export const rejectUser = async (uid, performerId) => {
  await deleteDoc(doc(db, 'users', uid));
  await logAdminAction('user_rejected', performerId, { targetId: uid });
};

export const banUser = async (uid, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    status: 'banned',
    updated_at: serverTimestamp()
  });
  await logAdminAction('user_banned', performerId, { targetId: uid });
};

export const unbanUser = async (uid, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    status: 'active',
    updated_at: serverTimestamp()
  });
  await logAdminAction('user_unbanned', performerId, { targetId: uid });
};

export const updateUserRole = async (uid, roleId, performerId) => {
  await updateDoc(doc(db, 'users', uid), {
    role_id: roleId,
    updated_at: serverTimestamp()
  });
  await logAdminAction('user_role_updated', performerId, { targetId: uid, roleId });
};

// --- Role Management ---
export const subscribeToRoles = (callback) => {
  const q = query(collection(db, 'roles'), orderBy('name', 'asc'));
  return onSnapshot(q, (snapshot) => {
    // id: d.id must come LAST so the real Firestore document ID always wins
    // over any stale `id` field that may have been stored inside the document data
    callback(snapshot.docs.map(d => ({ ...d.data(), id: d.id })));
  });
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
