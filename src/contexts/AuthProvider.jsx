/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  limit
} from 'firebase/firestore';
import { auth, db, googleProvider } from '../../firebase';
import LoadingPreloader from '../components/common/LoadingPreloader';
import { createNotification } from '../api/notifications';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

// How long without any activity before we stop updating last_seen (15 min)
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// How often we check & potentially push last_seen (2 min)
const TICK_MS = 2 * 60 * 1000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  // Ref holding the timestamp of the last recorded activity
  const lastActivityRef = useRef(Date.now());

  /**
   * recordActivity — call this whenever the user does something meaningful
   * (page navigation, posting a reply, creating a topic, etc.)
   * It does NOT trigger a Firestore write by itself — the interval handles that.
   */
  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

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
    // Global Settings Listener
    const unsubGlobalSettings = onSnapshot(doc(db, 'settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        setSettings(docSnap.data());
      }
    }, (err) => console.error('[GlobalSettings Listener]', err));

    let profileUnsub;
    let lastSeenInterval;

    const pushLastSeen = (uid) => {
      setDoc(doc(db, 'users', uid), { last_seen: serverTimestamp() }, { merge: true })
        .catch((e) => console.warn('[last_seen update]', e));
    };

    // Buffer to prevent preloader "flash" on fast loads
    const startLoadTime = Date.now();
    const minDisplayTime = 800;

    const finishLoading = () => {
      const elapsed = Date.now() - startLoadTime;
      const remaining = Math.max(0, minDisplayTime - elapsed);
      setTimeout(() => setLoading(false), remaining);
    };

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true); // Ensure we're in loading state while processing auth change
      if (firebaseUser) {
        setUser(firebaseUser);
        const userDocRef = doc(db, 'users', firebaseUser.uid);

        try {
          const userDoc = await getDoc(userDocRef);
          const isAdmin = firebaseUser.email === import.meta.env.VITE_ADMIN_EMAIL;

          if (!userDoc.exists()) {
            // Fetch fresh global settings specifically for the registration check
            const globalSettingsSnap = await getDoc(doc(db, 'settings', 'global'));
            const globalSettings = globalSettingsSnap.exists() ? globalSettingsSnap.data() : null;
            
            const registrationEnabled = globalSettings?.registrationEnabled !== false;
            
            // 1. Check if registration is allowed (admin is always allowed)
            if (!registrationEnabled && !isAdmin) {
              console.warn('[Registration] Blocked: registration is disabled.');
              sessionStorage.setItem('auth_error', 'registration_disabled');
              await signOut(auth);
              finishLoading();
              return;
            }

            // 2. Prevent Bypass: Check if user came from /register (admin is always allowed)
            const isRegistering = sessionStorage.getItem('is_registering') === 'true';
            if (!isRegistering && !isAdmin) {
              console.warn('[Registration] Blocked: attempt to bypass registration page.');
              sessionStorage.setItem('auth_error', 'need_registration');
              await signOut(auth);
              finishLoading();
              return;
            }

            const pendingNickname = sessionStorage.getItem('pending_nickname');
            const pendingMessage = sessionStorage.getItem('pending_message');
            const defaultNickname = firebaseUser.displayName || firebaseUser.email.split('@')[0];
            const chosenNickname = pendingNickname || defaultNickname;

            // 3. Final Nickname Uniqueness Check (Data Level)
            const q = query(
              collection(db, 'users'), 
              where('nickname', '==', chosenNickname.trim()),
              limit(1)
            );
            const querySnapshot = await getDocs(q);
            if (!querySnapshot.empty) {
              console.warn('[Registration] Blocked: nickname already taken:', chosenNickname);
              sessionStorage.setItem('auth_error', 'nickname_taken_at_registration');
              await signOut(auth);
              finishLoading();
              return;
            }

            const newUser = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              nickname: chosenNickname.trim(),
              avatar_url: firebaseUser.photoURL || '',
              status_line: 'Hello, I am new here!',
              role_id: isAdmin ? 'admin' : 'player',
              status: isAdmin ? 'active' : 'pending',
              created_at: serverTimestamp(),
              last_seen: serverTimestamp(),
              ...(pendingMessage ? { admin_message: pendingMessage } : {}),
              settings: {
                theme: 'dark',
                language: 'en',
                member_view_style: 'table'
              }
            };
            await setDoc(userDocRef, newUser);
            
            // Cleanup session
            sessionStorage.removeItem('pending_nickname');
            sessionStorage.removeItem('pending_message');
            sessionStorage.removeItem('is_registering');

            // Fire admin-broadcast notification for new (non-admin) registrations
            if (!isAdmin) {
              createNotification('new_registration', {
                uid: firebaseUser.uid,
                nickname: pendingNickname || defaultNickname,
                email: firebaseUser.email,
                admin_message: pendingMessage || null
              }).catch(err => console.warn('[notification]', err));
            }
          } else {
            // Login counts as activity — update immediately
            lastActivityRef.current = Date.now();
            pushLastSeen(firebaseUser.uid);
          }

          profileUnsub = onSnapshot(userDocRef, async (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();

              if (isAdmin && (data.role_id !== 'admin' || data.status !== 'active')) {
                const updates = {
                  role_id: 'admin',
                  status: 'active',
                  last_seen: serverTimestamp()
                };
                await setDoc(userDocRef, updates, { merge: true });
              } else {
                setProfile({ id: docSnap.id, ...data });
                // Keep public settings/global in sync with admin's current nickname
                // so RegisterPage can display it without requiring auth
                if (isAdmin && data.nickname && data.nickname !== settings?.adminNickname) {
                  setDoc(doc(db, 'settings', 'global'), { adminNickname: data.nickname }, { merge: true })
                    .catch(err => console.warn('[adminNickname sync]', err));
                }
              }
            } else {
              setProfile(null);
            }
            finishLoading();
          }, (error) => {
            console.error('Firestore profile listener error:', error);
            finishLoading();
          });

          // Periodic tick: only push last_seen if user was active recently
          clearInterval(lastSeenInterval);
          lastSeenInterval = setInterval(() => {
            const idleMs = Date.now() - lastActivityRef.current;
            if (idleMs < IDLE_TIMEOUT_MS) {
              pushLastSeen(firebaseUser.uid);
            }
            // If idle, we do nothing — last_seen stays at the last real activity
          }, TICK_MS);

        } catch (error) {
          console.error('Error initializing user data:', error);
          finishLoading();
        }

      } else {
        setUser(null);
        setProfile(null);
        finishLoading();
        if (profileUnsub) profileUnsub();
        clearInterval(lastSeenInterval);
      }
    });

    return () => {
      unsubGlobalSettings();
      unsubscribe();
      if (profileUnsub) profileUnsub();
      clearInterval(lastSeenInterval);
    };
  }, []);

  const value = {
    user,
    profile,
    settings,
    loading,
    loginWithGoogle,
    logout,
    updateSettings,
    updateProfile,
    recordActivity
  };

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};
