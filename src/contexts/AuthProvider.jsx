/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
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
import { markTopicNotificationsRead } from '../api/notifications';
import { 
  markAllTopicsRead,
  recordGuestActivity as apiRecordGuestActivity,
  deleteGuestActivity as apiDeleteGuestActivity,
  subscribeToReadMap,
  recordTopicVisit as apiRecordTopicVisit,
  subscribeToLatestTopics
} from '../api/auth-resources';
import { subscribeToCategories } from '../api/categories';
import { subscribeToRoles, seedSystemRoles } from '../api/admin';
import { logAdminAction } from '../api/audit';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES, normalizePermissions, isChiefAdmin } from '../constants/permissions';
import { generateRandomNickname } from '../utils/nickname';

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
  const [emailUnverified, setEmailUnverified] = useState(false);
  // readMap: { [topicId]: Firestore Timestamp | number } — synced from server
  const [readMap, setReadMap] = useState({});
  const [latestTopics, setLatestTopics] = useState([]);
  const [categories, setCategories] = useState([]);
  const [unreadTopicsCount, setUnreadTopicsCount] = useState(0);
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [roles, setRoles] = useState([]);
  const [authError, setAuthError] = useState(null);

  // Ref holding the timestamp of the last recorded activity
  const lastActivityRef = useRef(null);
  if (lastActivityRef.current === null) {
    lastActivityRef.current = Date.now();
  }
  // Ref holding the timestamp of the last database push (last_seen)
  const lastPushTimeRef = useRef(0);

  const pushLastSeen = useCallback((uid) => {
    if (!uid) return;
    setDoc(doc(db, 'users', uid), { last_seen: serverTimestamp() }, { merge: true })
      .then(() => {
        lastPushTimeRef.current = Date.now();
      })
      .catch((e) => {
        // Silent on permission-denied during login/logout transitions
        if (e.code !== 'permission-denied') {
          console.warn('[last_seen update]', e);
        }
      });
  }, []);

  const getOrCreateGuestId = useCallback(() => {
    let gid = localStorage.getItem('guest_id');
    if (!gid) {
      gid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('guest_id', gid);
    }
    return gid;
  }, []);

  /**
   * recordActivity — call this whenever the user does something meaningful
   * (page navigation, posting a reply, creating a topic, etc.)
   */
  const recordActivity = useCallback(() => {
    const now = Date.now();
    const idleMs = now - lastActivityRef.current;
    lastActivityRef.current = now;

    if (user) {
      // For registered users: push immediately if we haven't pushed in a while (TICK_MS)
      // or if we were definitively "idle" (IDLE_TIMEOUT_MS)
      if (now - lastPushTimeRef.current >= TICK_MS || idleMs >= IDLE_TIMEOUT_MS) {
        pushLastSeen(user.uid);
      }
    } else {
      // For guests: push throttled to 10 minutes (GUEST_TICK_MS)
      const GUEST_TICK_MS = 10 * 60 * 1000;
      const lastGuestPush = parseInt(localStorage.getItem('last_guest_push') || '0');
      if (now - lastGuestPush >= GUEST_TICK_MS) {
        const gid = getOrCreateGuestId();
        apiRecordGuestActivity(gid).catch(err => console.warn('[guest_activity]', err));
        localStorage.setItem('last_guest_push', now.toString());
      }
    }
  }, [user, pushLastSeen, getOrCreateGuestId]);

  const loginWithGoogle = () => {
    return signInWithPopup(auth, googleProvider);
  };

  const registerWithEmail = async (email, password) => {
    auth.languageCode = settings?.language || 'en';
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(userCredential.user);
    return userCredential;
  };

  const loginWithEmail = async (email, password) => {
    return await signInWithEmailAndPassword(auth, email, password);
  };

  const resetPassword = async (email) => {
    auth.languageCode = settings?.language || 'en';
    await sendPasswordResetEmail(auth, email);
  };

  const actionTimeRef = useRef({ resend: 0, check: 0 });

  const resendVerificationEmail = async () => {
    const now = Date.now();
    // 60 seconds cooldown for emails
    if (now - actionTimeRef.current.resend < 60000) return;
    actionTimeRef.current.resend = now;

    if (auth.currentUser) {
      auth.languageCode = settings?.language || 'en';
      try {
        await sendEmailVerification(auth.currentUser);
      } catch (e) {
        console.error('[resendVerificationEmail]', e);
      }
    }
  };

  const checkVerificationStatus = async () => {
    const now = Date.now();
    // 3 seconds cooldown to prevent spamming the auth API
    if (now - actionTimeRef.current.check < 3000) return;
    actionTimeRef.current.check = now;

    if (auth.currentUser) {
      setLoading(true);
      try {
        await auth.currentUser.reload();
      } catch (e) {
        console.error('[checkVerificationStatus]', e);
        setLoading(false);
      }
      window.location.reload();
    }
  };

  const loggingOutRef = useRef(false);

  const logout = useCallback(async (skipPresenceCleanup = false) => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;

    try {
      const uid = user?.uid || auth.currentUser?.uid;
      if (uid && !skipPresenceCleanup) {
        try {
          // Set last_seen to 16 minutes ago to immediately remove from "Online Now" list (15 min threshold)
          const sixteenMinsAgo = new Date(Date.now() - 16 * 60 * 1000);
          await updateDoc(doc(db, 'users', uid), { last_seen: sixteenMinsAgo });
        } catch (e) {
          // Only log if it's not a permission error (which can happen during logout transition)
          if (e.code !== 'permission-denied') {
            console.warn('[logout presence cleanup]', e);
          }
        }
      }
      localStorage.removeItem('last_guest_push');
      await signOut(auth);
      
      // Immediately record guest activity so they show up in "Online now" as a guest
      const gid = getOrCreateGuestId();
      await apiRecordGuestActivity(gid);
    } finally {
      loggingOutRef.current = false;
    }
  }, [user?.uid, getOrCreateGuestId]);

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

  const updateProfile = async (newData, targetUid = null) => {
    if (!user) return;
    const finalUid = targetUid || user.uid;
    const userDocRef = doc(db, 'users', finalUid);

    const updatedData = { ...newData };
    const isSelf = finalUid === user.uid;

    if (isSelf && newData.settings && profile?.settings) {
      updatedData.settings = {
        ...profile.settings,
        ...newData.settings
      };
    }

    await setDoc(userDocRef, updatedData, { merge: true });
    
    if (!isSelf) {
      await logAdminAction('user_profile_edited_by_admin', user.uid, { targetId: finalUid });
    }
    
    if (isSelf) {
      setProfile(prev => ({
        ...prev,
        ...updatedData
      }));
    }
  };

  useEffect(() => {
    // Global Settings Listener
    const unsubGlobalSettings = onSnapshot(doc(db, 'settings', 'global'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const migrated = { 
          ...data,
          forumName: data.forumName || 'Aerun Forum',
          welcomeMessage: data.welcomeMessage || '',
          maintenanceMode: data.maintenanceMode ?? false,
          whitelistMode: data.whitelistMode ?? false,
          requireApproval: data.requireApproval ?? true,
          registrationEnabled: data.registrationEnabled ?? true,
          postsPerPage: data.postsPerPage ?? 20,
          maxPostsPerTopic: data.maxPostsPerTopic ?? 1000
        };
        // Defaults for backgrounds
        if (!data.bgLight) migrated.bgLight = 'https://images.unsplash.com/photo-1458668383970-8ddd3927deed?q=80&w=1400&auto=format&fit=crop';
        if (!data.bgDark) migrated.bgDark = 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop';
        if (!data.bgNeutral) migrated.bgNeutral = 'https://images.unsplash.com/photo-1675636173835-657f72144c77?q=80&w=1400&auto=format&fit=crop';
        setSettings(migrated);
      } else {
        // Provide minimal defaults so the app doesn't crash if the document is missing
        setSettings({
          forumName: 'Aerun Forum',
          maintenanceMode: false,
          whitelistMode: false,
          registrationEnabled: true,
          requireApproval: true,
          postsPerPage: 20,
          maxPostsPerTopic: 1000,
          bgDark: 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop'
        });
      }
    }, (err) => console.error('[GlobalSettings Listener]', err));

    // Global Roles Listener (needed for unauthenticated guest permissions)
    const rolesUnsub = subscribeToRoles(setRoles);

    let profileUnsub;
    let readMapUnsub;
    let latestTopicsUnsub;


    // Buffer to prevent preloader "flash" on fast loads
    const startLoadTime = Date.now();
    const minDisplayTime = 800;

    const finishLoading = () => {
      const elapsed = Date.now() - startLoadTime;
      const remaining = Math.max(0, minDisplayTime - elapsed);
      setTimeout(() => setLoading(false), remaining);
    };

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      // Shield the UI while fetching the profile doc by throwing up the preloader during transitions
      // (Bypasses stale closure in useEffect([]) by directly triggering the setter)
      setLoading(true);
      setAuthError(null);

      if (firebaseUser) {
        setUser(firebaseUser);

        const usesPassword = firebaseUser.providerData.some(p => p.providerId === 'password');
        if (usesPassword && !firebaseUser.emailVerified) {
          setEmailUnverified(true);
        } else {
          setEmailUnverified(false);
        }

        const userDocRef = doc(db, 'users', firebaseUser.uid);

        // De-register as guest if was one
        const gid = localStorage.getItem('guest_id');
        if (gid) {
          apiDeleteGuestActivity(gid);
        }

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
            
            let chosenNickname = (pendingNickname && typeof pendingNickname === 'string') ? pendingNickname.trim() : null;
            let finalNickname = chosenNickname;

            // Small delay to allow Auth state to fully settle before Firestore queries
            // (Known workaround for internal SDK assertion errors during auth transitions)
            await new Promise(resolve => setTimeout(resolve, 500));

            const checkNicknameAvailability = async (name) => {
              try {
                const qAvailability = query(
                  collection(db, 'users'), 
                  where('nickname', '==', name),
                  limit(1)
                );
                const snap = await getDocs(qAvailability);
                return snap.empty;
              } catch (e) {
                console.error('[checkNicknameAvailability error]', e);
                return true; // Default to available on error to avoid blocking registration
              }
            };

            if (!finalNickname) {
              // Always generate a random one if nothing was provided (privacy)
              // Add a bit of extra randomness to avoid NEEDING a query check here
              const randomSuffix = Math.random().toString(36).substring(2, 6);
              finalNickname = `${generateRandomNickname()}-${randomSuffix}`;
            } else {
              // Check if the user-provided nickname is taken
              const isAvailable = await checkNicknameAvailability(finalNickname);
              if (!isAvailable) {
                console.warn('[Registration] Blocked: nickname already taken:', finalNickname);
                sessionStorage.setItem('auth_error', 'nickname_taken_at_registration');
                await signOut(auth);
                finishLoading();
                return;
              }
            }

            const defaultAvatar = `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(finalNickname)}`;

            const newUser = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              nickname: finalNickname,
              avatar_url: defaultAvatar,
              status_line: 'Hello, I am new here!',
              role_id: isAdmin ? CHIEF_ADMIN_ID : (globalSettings?.requireApproval === false ? 'player' : 'pending'),
              created_at: serverTimestamp(),
              last_seen: serverTimestamp(),
              ...(pendingMessage ? { admin_message: pendingMessage } : {}),
              settings: {
                theme: localStorage.getItem('guest_theme') || 'dark',
                language: (() => {
                  const saved = localStorage.getItem('language');
                  if (saved && (saved === 'ru' || saved === 'en')) return saved;
                  const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
                  return browserLang.startsWith('ru') ? 'ru' : 'en';
                })(),
                member_view_style: 'table'
              }
            };
            await setDoc(userDocRef, newUser);
            
            // Cleanup session
            sessionStorage.removeItem('pending_nickname');
            sessionStorage.removeItem('pending_message');
            sessionStorage.removeItem('is_registering');

            // Log registration to audit log
            await logAdminAction('user_registered', firebaseUser.uid, { 
              email: firebaseUser.email, 
              nickname: finalNickname,
              role_id: newUser.role_id
            }).catch(err => console.error('[audit log error]', err));
          } else {
            const data = userDoc.data();
            
            // Auto-upgrade pending users who just verified their email
            if (usesPassword && firebaseUser.emailVerified && data.role_id === 'pending') {
               try {
                   const globalSnap = await getDoc(doc(db, 'settings', 'global'));
                   const reqAppr = globalSnap.exists() ? globalSnap.data().requireApproval : false;
                   if (!reqAppr) {
                       await updateDoc(userDocRef, { role_id: 'player' });
                       data.role_id = 'player';
                   }
               } catch (e) {
                   console.error('[Auto-upgrade role error]', e);
               }
            }

            // Login counts as activity — update immediately
            lastActivityRef.current = Date.now();
            pushLastSeen(firebaseUser.uid);

            // If an admin logs in, ensure they don't see the maintenance logout modal
            if (isAdmin) {
              sessionStorage.removeItem('maintenance_logout');
            }
          }

          // Seed system roles with fixed IDs if they don't exist yet (admin-only, safe to call repeatedly)
          if (isAdmin) {
            seedSystemRoles(DEFAULT_ROLES).catch(err => console.warn('[seedSystemRoles]', err));
            
            // Also seed global settings if they are missing
            const globalSettingsRef = doc(db, 'settings', 'global');
            const globalSettingsSnap = await getDoc(globalSettingsRef);
            if (!globalSettingsSnap.exists()) {
              await setDoc(globalSettingsRef, {
                forumName: 'Aerun Forum',
                maintenanceMode: false,
                whitelistMode: false,
                registrationEnabled: true,
                requireApproval: true,
                adminNickname: firebaseUser.displayName || 'Admin',
                bgDark: 'https://images.unsplash.com/photo-1656077217715-bdaeb06bd01f?q=80&w=1400&auto=format&fit=crop',
                created_at: serverTimestamp()
              });
            }
          }

          // Subscribe to read map (all roles — everyone can read topics)
          readMapUnsub = subscribeToReadMap(firebaseUser.uid, setReadMap);

          // Subscribe to latest topics to track unread count (100 is enough for global badge)
          latestTopicsUnsub = subscribeToLatestTopics(setLatestTopics, 100);

          profileUnsub = onSnapshot(userDocRef, async (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();
              setAuthError(null);

              if (isAdmin && data.role_id !== CHIEF_ADMIN_ID) {
                const updates = {
                  role_id: CHIEF_ADMIN_ID,
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
            // Only set auth error if we don't have a profile yet (initial load failure)
            if (!profile) {
              setAuthError(error);
            }
            finishLoading();
          });


        } catch (error) {
          console.error('Error initializing user data:', error);
          setAuthError(error);
          finishLoading();
        }

      } else {
        setUser(null);
        setProfile(null);
        setEmailUnverified(false);
        setReadMap({});
        setLatestTopics([]);
        finishLoading();
        if (profileUnsub) profileUnsub();
        if (readMapUnsub) readMapUnsub();
        if (latestTopicsUnsub) latestTopicsUnsub();
      }
    });

    let catsUnsub = subscribeToCategories(setCategories);

    return () => {
      unsubGlobalSettings();
      unsubscribe();
      if (profileUnsub) profileUnsub();
      if (readMapUnsub) readMapUnsub();
      if (latestTopicsUnsub) latestTopicsUnsub();
      if (rolesUnsub) rolesUnsub();
      if (catsUnsub) catsUnsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat System: periodically update presence for both users and guests
  useEffect(() => {
    // Lightweight interaction tracking (throttled by recordActivity logic)
    // This ensures that reading/scrolling also counts as activity, not just navigation.
    const handleInteraction = () => recordActivity();
    
    window.addEventListener('mousedown', handleInteraction);
    window.addEventListener('keydown', handleInteraction, { passive: true });
    window.addEventListener('scroll', handleInteraction, { passive: true });

    const interval = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivityRef.current;
      
      // Stop heartbeat if truly idle (e.g. tab left open but no interaction for 15m)
      if (idleMs >= IDLE_TIMEOUT_MS) return;

      if (user) {
        // User heartbeat (TICK_MS = 2 min)
        if (now - lastPushTimeRef.current >= TICK_MS) {
          pushLastSeen(user.uid);
        }
      } else {
        // Guest heartbeat (GUEST_TICK_MS = 10 min)
        const GUEST_TICK_MS = 10 * 60 * 1000;
        const lastGuestPush = parseInt(localStorage.getItem('last_guest_push') || '0');
        if (now - lastGuestPush >= GUEST_TICK_MS) {
          const gid = getOrCreateGuestId();
          apiRecordGuestActivity(gid).catch(err => console.warn('[guest_activity heartbeat]', err));
          localStorage.setItem('last_guest_push', now.toString());
        }
      }
    }, 60000); // Check every minute
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('mousedown', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
      window.removeEventListener('scroll', handleInteraction);
    };
  }, [user, pushLastSeen, getOrCreateGuestId, recordActivity]);

  const hasPermission = useCallback((perm, context = {}) => {
    // ── 1. GLOBAL SETTINGS OVERRIDES (Highest Priority for feature flags) ──
    if (settings) {
      if (perm === PERMISSIONS.USE_DICE && settings.enableDice === false) return false;
      if (perm === PERMISSIONS.USE_MASKS && settings.enableCharacters === false) return false;
      if (perm === PERMISSIONS.USE_REPUTATION && settings.enableReputation === false) return false;
    }

    // ── 2. CHIEF ADMIN: bypasses ALL other checks (including category overrides) ──
    const adminEmail = import.meta.env.VITE_ADMIN_EMAIL;
    if (adminEmail && user?.email === adminEmail) return true;

    // If the user is logged in but profile hasn't arrived from Firestore yet,
    // deny everything to avoid a flash of content that disappears once the real
    // profile (e.g. status='pending') is applied.
    if (user && profile === null) return false;

    // Unverified password accounts are restricted even if they have 'player' role
    const isPending = profile?.role_id === 'pending';
    const usesPassword = user?.providerData.some(p => p.providerId === 'password');
    const isUnverified = usesPassword && !user?.emailVerified;
    const isRestricted = isPending || (isUnverified && settings?.requireApproval === false);

    if (isRestricted) {
      if (perm === PERMISSIONS.EDIT_SELF_NICKNAME || perm === PERMISSIONS.EDIT_SELF_AVATAR) {
        return true;
      }
    }

    const isWhitelistOff = !settings?.whitelistMode;
    // When whitelistMode is OFF, restricted users (pending or unverified player) get spectator-level read access
    // (spectator has VIEW_FORUM globally, but no posting rights).
    // When whitelistMode is ON, they are strictly locked down.
    const effectiveRoleId = (isRestricted && isWhitelistOff)
        ? 'spectator'
        : (profile?.role_id || (user ? 'player' : 'guest'));

    if (effectiveRoleId === CHIEF_ADMIN_ID) return true;

    // ── 3. CATEGORY-LEVEL OVERRIDES ──
    // If a category object is passed in context, and the category has permission overrides
    // for the requested permission, those override the global role permissions.
    if (context?.category) {
      const catPerms = context.category.permissions;
      if (catPerms && catPerms[perm] !== undefined && catPerms[perm] !== null) {
        // catPerms[perm] is an array of allowed role IDs.
        const allowedRoles = catPerms[perm];
        // Check if user's own role is allowed
        if (allowedRoles.includes(effectiveRoleId)) return true;
        
        // Check if user's role inherits from a base role that is allowed
        const userRole = roles.find(r => r.id === effectiveRoleId);
        if (userRole?.base_role_id && allowedRoles.includes(userRole.base_role_id)) return true;
        
        return false;
      }
    }

    // ── 4. GLOBAL ROLE PERMISSIONS (Baseline) ──
    // Restricted users with whitelist ON: no permissions at all (except profile editing above).
    // Restricted users with whitelist OFF: fall through to spectator's global permissions (VIEW_FORUM only).
    if (isRestricted && !isWhitelistOff) return false;

    const userRole = roles.find(r => r.id === effectiveRoleId) || DEFAULT_ROLES.find(r => r.id === effectiveRoleId);
    return !!normalizePermissions(userRole?.permissions).includes(perm);
  }, [user, profile, roles, settings]);

  // Calculate unreadTopicsCount whenever readMap or latestTopics change
  useEffect(() => {
    if (!user || latestTopics.length === 0) {
      setUnreadTopicsCount(0);
      return;
    }

    // New user baseline: topics updated before registration are treated as read
    const registrationMs = profile?.created_at?.toMillis?.() || 0;

    const count = latestTopics.filter(topic => {
      // 1. FILTER BY PERMISSIONS
      // Ensure the user actually has permission to see the category this topic belongs to
      const category = categories.find(c => c.id === topic.category_id);
      if (!category || !hasPermission(PERMISSIONS.VIEW_FORUM, { category })) return false;

      // 2. EXCLUDE OWN POSTS
      if (topic.last_post_author_id === user.uid) return false;

      // 3. COMPARE TIMESTAMPS
      const entry = readMap[topic.id];
      const lastVisitValue = entry?.timestamp || entry;
      const lastVisitMs = lastVisitValue?.toMillis ? lastVisitValue.toMillis() : (lastVisitValue || 0);
      const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);
      const lastPostMs = topic.last_post_at?.toMillis?.() ?? 0;

      return lastPostMs > effectiveLastVisitMs;
    }).length;

    setUnreadTopicsCount(count);
  }, [user, profile, latestTopics, readMap, categories, hasPermission]);

  /**
   * Mark a topic as read for the current user.
   * Optimistically updates local readMap, then persists to Firestore.
   * Works for all roles (admin, moderator, player, spectator).
   */
  const markTopicRead = useCallback(async (topicId, offset = null) => {
    if (!user || !topicId) return;
    // Optimistic local update
    const now = Date.now();
    const value = offset !== null ? { timestamp: now, offset } : now;
    setReadMap(prev => ({ ...prev, [topicId]: value }));
    try {
      await apiRecordTopicVisit(user.uid, topicId, offset);
      if (profile?.role_id !== 'pending' && profile?.role_id !== 'banned') {
        await markTopicNotificationsRead(user.uid, topicId);
      }
    } catch (err) {
      console.error('[markTopicRead]', err);
    }
  }, [user, profile?.role_id]);

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



  // Monitoring maintenance mode / status to force logout
  React.useEffect(() => {
    if (user && !loading) {
      const isRegistering = sessionStorage.getItem('is_registering') === 'true';
      
      // If user is authenticated but profile is missing and we aren't registering,
      // it means the account was deleted or never existed correctly.
      // We skip this if there was an authError to avoid logging out on network issues.
      if (!profile && !isRegistering && !authError) {
        logout(true);
        return;
      }

      if (profile) {
        const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);
        const isBanned = profile.role_id === 'banned';
        
        // Maintenance applies if ON and whitelist is active
        const isMaintenanceStrict = settings?.maintenanceMode && (settings.whitelistMode !== false);

        if (isBanned) {
          if (!sessionStorage.getItem('banned_login_logged')) {
            logAdminAction('banned_user_login_attempt', user.uid, { 
              email: user.email, 
              nickname: profile.nickname 
            }).catch(console.error);
            sessionStorage.setItem('banned_login_logged', 'true');
          }
          
          sessionStorage.setItem('banned_logout', 'true');
          logout(true); // skipPresenceCleanup = true to avoid permission error loop
        } else if (isMaintenanceStrict && !isAdmin) {
          sessionStorage.setItem('maintenance_logout', 'true');
          logout();
        }
      }
    }
  }, [settings?.maintenanceMode, settings?.whitelistMode, user, profile, loading, hasPermission, logout, authError]);

  const isRootAdmin = isChiefAdmin(user?.email, profile?.role_id);

  const value = {
    user,
    profile,
    authError,
    isRootAdmin,
    settings,
    loading,
    readMap,
    unreadTopicsCount,
    isMarkingAllRead,
    markTopicRead,
    markAllRead,
    loginWithGoogle,
    registerWithEmail,
    loginWithEmail,
    resetPassword,
    resendVerificationEmail,
    checkVerificationStatus,
    emailUnverified,
    setEmailUnverified,
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
