import { db } from '../../firebase';
import { doc, setDoc, getDoc, onSnapshot, deleteDoc, updateDoc, serverTimestamp, collection, query, where, getDocs, writeBatch, orderBy } from 'firebase/firestore';

const SETTINGS_DOC = 'settings/global';

export const getGlobalSettings = (callback) => {
  return onSnapshot(doc(db, SETTINGS_DOC), (doc) => {
    if (doc.exists()) {
      callback(doc.data());
    }
  });
};

export const updateGlobalSettings = async (settings) => {
  const docRef = doc(db, SETTINGS_DOC);
  await setDoc(docRef, settings, { merge: true });
};

// --- Invites section removed per user request ---

// --- User Management ---
export const approveUser = async (uid) => {
  await updateDoc(doc(db, 'users', uid), {
    status: 'active',
    updated_at: serverTimestamp()
  });
};

export const rejectUser = async (uid) => {
  await deleteDoc(doc(db, 'users', uid));
};

export const banUser = async (uid) => {
  await updateDoc(doc(db, 'users', uid), {
    status: 'banned',
    updated_at: serverTimestamp()
  });
};

export const updateUserRole = async (uid, roleId) => {
  await updateDoc(doc(db, 'users', uid), {
    role_id: roleId,
    updated_at: serverTimestamp()
  });
};

// --- Role Management ---
export const subscribeToRoles = (callback) => {
  const q = query(collection(db, 'roles'), orderBy('name', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};

export const addRole = async (roleData) => {
  const roleRef = doc(collection(db, 'roles'));
  await setDoc(roleRef, {
    ...roleData,
    is_system: false,
    created_at: serverTimestamp()
  });
  return roleRef.id;
};

export const updateRole = async (id, roleData) => {
  await setDoc(doc(db, 'roles', id), {
    ...roleData,
    updated_at: serverTimestamp()
  }, { merge: true });
};

export const deleteRole = async (id, isSystem) => {
  if (isSystem) {
    throw new Error('System roles cannot be deleted');
  }

  // Find the role to get its base_role_id
  const roleSnap = await getDoc(doc(db, 'roles', id));
  if (!roleSnap.exists()) return;
  
  const roleData = roleSnap.data();
  const baseRoleId = roleData.base_role_id || 'player'; // Fallback to player if no base_role_id

  // Update all users who have this role to the base role
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
};
