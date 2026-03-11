import { db } from '../../firebase';
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp
} from 'firebase/firestore';

export const subscribeToCharacters = (uid, callback) => {
  const colRef = collection(db, 'users', uid, 'characters');
  return onSnapshot(colRef, (snapshot) => {
    const chars = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    callback(chars);
  });
};

export const subscribeToCharacter = (uid, charId, callback) => {
  const docRef = doc(db, 'users', uid, 'characters', charId);
  return onSnapshot(docRef, (snapshot) => {
    if (snapshot.exists()) {
      callback({ id: snapshot.id, ...snapshot.data() });
    } else {
      callback(null);
    }
  });
};

export const addCharacter = async (uid, characterData) => {
  const colRef = collection(db, 'users', uid, 'characters');
  await addDoc(colRef, {
    ...characterData,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });
};

export const updateCharacter = async (uid, charId, characterData) => {
  const docRef = doc(db, 'users', uid, 'characters', charId);
  await updateDoc(docRef, {
    ...characterData,
    updated_at: serverTimestamp()
  });
};

export const deleteCharacter = async (uid, charId) => {
  const docRef = doc(db, 'users', uid, 'characters', charId);
  await deleteDoc(docRef);
};
