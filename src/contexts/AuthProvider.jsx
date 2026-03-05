import React, { createContext, useContext, useEffect, useState } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  signOut 
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  serverTimestamp 
} from 'firebase/firestore';
import { auth, db, googleProvider } from '../../firebase';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const loginWithGoogle = () => {
    return signInWithPopup(auth, googleProvider);
  };

  const logout = () => {
    return signOut(auth);
  };

  const updateSettings = async (newSettings) => {
    if (!user) return;
    const userDocRef = doc(db, 'users', user.uid);
    const updatedSettings = {
      ...profile.settings,
      ...newSettings
    };
    await setDoc(userDocRef, { settings: updatedSettings }, { merge: true });
    setProfile(prev => ({
      ...prev,
      settings: updatedSettings
    }));
  };

  const updateProfile = async (newData) => {
    if (!user) return;
    const userDocRef = doc(db, 'users', user.uid);
    
    // If newData contains settings, we merge them with existing settings
    const updatedData = { ...newData };
    if (newData.settings && profile?.settings) {
      updatedData.settings = {
        ...profile.settings,
        ...newData.settings
      };
    }

    await setDoc(userDocRef, updatedData, { merge: true });
    setProfile(prev => ({
      ...prev,
      ...updatedData
    }));
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Get or create user profile in Firestore
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userDocRef);

        if (!userDoc.exists()) {
          const newUser = {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            nickname: firebaseUser.displayName || firebaseUser.email.split('@')[0],
            avatar_url: firebaseUser.photoURL || '',
            status: 'Hello, I am new here!',
            role_id: firebaseUser.email === import.meta.env.VITE_ADMIN_EMAIL ? 'admin' : 'player',
            status_id: 'pending',
            created_at: serverTimestamp(),
            last_seen: serverTimestamp(),
            settings: {
              theme: 'dark',
              language: 'en'
            }
          };
          await setDoc(userDocRef, newUser);
          setProfile(newUser);
        } else {
          const data = userDoc.data();
          const isAdmin = firebaseUser.email === import.meta.env.VITE_ADMIN_EMAIL;
          
          // Auto-promote if email matches admin but role/status is wrong
          if (isAdmin && (data.role_id !== 'admin' || data.status !== 'active')) {
            const updates = { 
              role_id: 'admin', 
              status: 'active',
              last_seen: serverTimestamp() 
            };
            await setDoc(userDocRef, updates, { merge: true });
            setProfile({ ...data, ...updates });
          } else {
            setProfile(data);
            await setDoc(userDocRef, { last_seen: serverTimestamp() }, { merge: true });
          }
        }
        setUser(firebaseUser);
      } else {
        setUser(null);
        setProfile(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const value = {
    user,
    profile,
    loading,
    loginWithGoogle,
    logout,
    updateSettings,
    updateProfile
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};
