import { db } from '../../firebase';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';

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
