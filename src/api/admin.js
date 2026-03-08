import { db } from '../../firebase';
import { doc, setDoc, onSnapshot, deleteDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

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
