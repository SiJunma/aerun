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
import { createNotification, markTopicNotificationsRead } from '../api/notifications';
import { 
  subscribeToReadMap, 
  recordTopicVisit as apiRecordTopicVisit,
  markAllTopicsRead,
  subscribeToLatestTopics
} from '../api/forum';
import { subscribeToRoles, seedSystemRoles } from '../api/admin';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES } from '../constants/permissions';

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
  // readMap: { [topicId]: Firestore Timestamp | number } — synced from server
  const [readMap, setReadMap] = useState({});
  const [latestTopics, setLatestTopics] = useState([]);
  const [unreadTopicsCount, setUnreadTopicsCount] = useState(0);
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [roles, setRoles] = useState([]);

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
    let readMapUnsub;
    let latestTopicsUnsub;
    let rolesUnsub;
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
              role_id: isAdmin ? CHIEF_ADMIN_ID : 'player',
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

          // Subscribe to roles only for authenticated users
          rolesUnsub = subscribeToRoles(setRoles);

          // Seed system roles with fixed IDs if they don't exist yet (admin-only, safe to call repeatedly)
          if (isAdmin) {
            seedSystemRoles(DEFAULT_ROLES).catch(err => console.warn('[seedSystemRoles]', err));
          }

          // Subscribe to read map (all roles — everyone can read topics)
          readMapUnsub = subscribeToReadMap(firebaseUser.uid, setReadMap);

          // Subscribe to latest topics to track unread count (100 is enough for global badge)
          latestTopicsUnsub = subscribeToLatestTopics(setLatestTopics, 100);

          profileUnsub = onSnapshot(userDocRef, async (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();

              if (isAdmin && (data.role_id !== CHIEF_ADMIN_ID || data.status !== 'active')) {
                const updates = {
                  role_id: CHIEF_ADMIN_ID,
                  status: 'active',
                  last_seen: serverTimestamp()
                };
                await setDoc(userDocRef, updates, { merge: true });
              } else {
                setProfile({ id: docSnap.id, ...data });
                // Keep public settings/global in sync with admin's current nickname
                // so RegisterPage can display it without requiring auth
                if (isAdmin && data.nickname && firebaseUser && data.nickname !== settings?.adminNickname) {
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
        setReadMap({});
        setLatestTopics([]);
        finishLoading();
        if (profileUnsub) profileUnsub();
        if (readMapUnsub) readMapUnsub();
        if (latestTopicsUnsub) latestTopicsUnsub();
        if (rolesUnsub) rolesUnsub();
        clearInterval(lastSeenInterval);
      }
    });

    return () => {
      unsubGlobalSettings();
      unsubscribe();
      if (profileUnsub) profileUnsub();
      if (readMapUnsub) readMapUnsub();
      if (latestTopicsUnsub) latestTopicsUnsub();
      if (rolesUnsub) rolesUnsub();
      clearInterval(lastSeenInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calculate unreadTopicsCount whenever readMap or latestTopics change
  useEffect(() => {
    if (!user || latestTopics.length === 0) {
      setUnreadTopicsCount(0);
      return;
    }

    const count = latestTopics.filter(topic => {
      // Exclude own posts from unread count
      if (topic.last_post_author_id === user.uid) return false;

      const lastVisitRaw = readMap[topic.id];
      const lastVisitMs = lastVisitRaw?.toMillis ? lastVisitRaw.toMillis() : (lastVisitRaw || 0);
      const lastPostMs = topic.last_post_at?.toMillis?.() ?? 0;

      return lastPostMs > lastVisitMs;
    }).length;

    setUnreadTopicsCount(count);
  }, [user, latestTopics, readMap]);

  /**
   * Mark a topic as read for the current user.
   * Optimistically updates local readMap, then persists to Firestore.
   * Works for all roles (admin, moderator, player, spectator).
   */
  const markTopicRead = useCallback(async (topicId) => {
    if (!user || !topicId) return;
    // Optimistic local update (use a plain number since serverTimestamp doesn't resolve locally)
    const now = Date.now();
    setReadMap(prev => ({ ...prev, [topicId]: now }));
    try {
      await apiRecordTopicVisit(user.uid, topicId);
      await markTopicNotificationsRead(user.uid, topicId);
    } catch (err) {
      console.error('[markTopicRead]', err);
    }
  }, [user]);

  /**
   * Mark all fetched topics as read.
   */
  const markAllRead = useCallback(async () => {
    if (!user || latestTopics.length === 0 || isMarkingAllRead) return;
    
    setIsMarkingAllRead(true);
    try {
      // Optimistic local update
      const now = Date.now();
      const newReadMap = { ...readMap };
      const topicIds = latestTopics.map(t => {
        newReadMap[t.id] = now;
        return t.id;
      });
      
      setReadMap(newReadMap);
      await markAllTopicsRead(user.uid, topicIds);
    } catch (err) {
      console.error('[markAllRead]', err);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [user, latestTopics, readMap, isMarkingAllRead]);

  // Sync document.title with forumName
  useEffect(() => {
    if (settings?.forumName) {
      document.title = settings.forumName;
    }
  }, [settings?.forumName]);

  const hasPermission = useCallback((perm, context = {}) => {
    // ── 1. GLOBAL SETTINGS OVERRIDES (Highest Priority for feature flags) ──
    if (settings) {
      if (perm === PERMISSIONS.USE_DICE && settings.enableDice === false) return false;
      if (perm === PERMISSIONS.USE_MASKS && settings.enableCharacters === false) return false;
      if (perm === PERMISSIONS.USE_REPUTATION && settings.enableReputation === false) return false;
    }

    // ── 2. CHIEF ADMIN: bypasses ALL other checks (including category overrides) ──
    if (user?.email === import.meta.env.VITE_ADMIN_EMAIL) return true;
    const userRoleId = profile?.role_id || (user ? 'player' : 'guest');
    if (userRoleId === CHIEF_ADMIN_ID) return true;

    // ── 3. CATEGORY-LEVEL OVERRIDES ──
    // If a category object is passed in context, and the category has permission overrides
    // for the requested permission, those override the global role permissions.
    if (context?.category) {
      const catPerms = context.category.permissions;
      if (catPerms && catPerms[perm] !== undefined && catPerms[perm] !== null) {
        // catPerms[perm] is an array of allowed role IDs.
        const allowedRoles = catPerms[perm];
        // Check if user's own role is allowed
        if (allowedRoles.includes(userRoleId)) return true;
        // Check if user's role inherits from a base role that is allowed
        const userRole = roles.find(r => r.id === userRoleId);
        if (userRole?.base_role_id && allowedRoles.includes(userRole.base_role_id)) return true;
        return false;
      }
    }

    // ── 4. GLOBAL ROLE PERMISSIONS (Baseline) ──
    // Guests have no global permissions (they rely on category overrides for VIEW_FORUM).
    if (!user) return false;
    const userRole = roles.find(r => r.id === userRoleId);
    return !!userRole?.permissions?.includes(perm);
  }, [user, profile, roles, settings]);

  const value = {
    user,
    profile,
    settings,
    loading,
    readMap,
    unreadTopicsCount,
    isMarkingAllRead,
    markTopicRead,
    markAllRead,
    loginWithGoogle,
    logout,
    updateSettings,
    updateProfile,
    recordActivity,
    hasPermission,
    roles,
    PERMISSIONS,
    DEFAULT_ROLES
  };

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};
