/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
  onSnapshot,
  serverTimestamp,
  Timestamp,
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  limit,
  orderBy
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
  subscribeToLatestTopics,
  fetchLatestTopics
} from '../api/auth-resources';
import {
  initRtdbPresence,
  setRtdbOffline,
  subscribeToOnlineUsers
} from '../api/rtdb-presence';
import { fetchSecuredMainPageData } from '../api/categories';
import { subscribeToRoles, seedSystemRoles } from '../api/admin';
import { logAdminAction } from '../api/audit';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES, normalizePermissions, isChiefAdmin } from '../constants/permissions';
import { generateRandomNickname } from '../utils/nickname';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

// How long without any activity before we stop updating last_seen (15 min)
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
// How often we check & potentially push last_seen (5 min)
const TICK_MS = 5 * 60 * 1000;

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
  const [forumStats, setForumStats] = useState(null);
  const [dailyActiveUsers, setDailyActiveUsers] = useState([]);
  const [unreadTopicsCount, setUnreadTopicsCount] = useState(0);
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [roles, setRoles] = useState([]);
  const [authError, setAuthError] = useState(null);
  const [activeUsers, setActiveUsers] = useState([]);
  // Производный Set UIDs — пересчитывается только при изменении списка
  const activeUserIds = useMemo(() => new Set(activeUsers.map(u => u.id)), [activeUsers]);

  // Ref holding the timestamp of the last recorded activity
  const lastActivityRef = useRef(null);
  if (lastActivityRef.current === null) {
    lastActivityRef.current = Date.now();
  }
  // Ref holding the timestamp of the last database push (last_seen)
  const lastPushTimeRef = useRef(0);

  // Listener Refs (persisted across renders for cleanup)
  const profileUnsubRef = useRef(null);
  const readMapUnsubRef = useRef(null);
  const latestTopicsUnsubRef = useRef(null);
  const rolesUnsubRef = useRef(null);
  const catsUnsubRef = useRef(null);

  // RTDB Presence initialization
  useEffect(() => {
    if (user?.uid && profile) {
      return initRtdbPresence(user.uid, profile);
    }
  }, [user?.uid, profile?.nickname, profile?.avatar_url, profile?.role_id]);

  // Real-time Online Users subscription from RTDB (0 Firestore reads)
  useEffect(() => {
    return subscribeToOnlineUsers(setActiveUsers);
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
      // 1. Если пользователь авторизован, но остался старый guest_id — удаляем его запись из guest_activity
      const gid = localStorage.getItem('guest_id');
      if (gid) {
        apiDeleteGuestActivity(gid).catch(err => console.warn('[deleteGuestActivity error]', err));
        localStorage.removeItem('guest_id');
        localStorage.removeItem('last_guest_push');
      }
    } else {
      // Для гостей: пинг раз в 10 минут
      const GUEST_TICK_MS = 10 * 60 * 1000;
      const lastGuestPush = parseInt(localStorage.getItem('last_guest_push') || '0', 10);
      if (now - lastGuestPush >= GUEST_TICK_MS) {
        const gid = getOrCreateGuestId();
        apiRecordGuestActivity(gid).catch(err => console.warn('[guest_activity]', err));
        localStorage.setItem('last_guest_push', now.toString());
      }
    }
  }, [user, getOrCreateGuestId]);

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
          await setRtdbOffline(uid);
          await deleteDoc(doc(db, 'user_presence', uid)).catch(() => {});
          setActiveUsers(prev => prev.filter(u => u.id !== uid));
        } catch (e) {
          console.warn('[logout presence cleanup error]', e);
        }
      }

      localStorage.removeItem('last_guest_push');
      await signOut(auth);

      const gid = getOrCreateGuestId();
      await apiRecordGuestActivity(gid);
    } catch (err) {
      console.error('[logout error]', err);
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

    const rolesUnsub = subscribeToRoles(setRoles);

    const startLoadTime = Date.now();
    const minDisplayTime = 800;

    const finishLoading = () => {
      const elapsed = Date.now() - startLoadTime;
      const remaining = Math.max(0, minDisplayTime - elapsed);
      setTimeout(() => setLoading(false), remaining);
    };

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      setAuthError(null);

      if (profileUnsubRef.current) { profileUnsubRef.current(); profileUnsubRef.current = null; }
      if (readMapUnsubRef.current) { readMapUnsubRef.current(); readMapUnsubRef.current = null; }
      if (latestTopicsUnsubRef.current) { latestTopicsUnsubRef.current(); latestTopicsUnsubRef.current = null; }

      if (firebaseUser) {
        setUser(firebaseUser);

        const usesPassword = firebaseUser.providerData.some(p => p.providerId === 'password');
        setEmailUnverified(usesPassword && !firebaseUser.emailVerified);

        const userDocRef = doc(db, 'users', firebaseUser.uid);

        // 1. Очищаем гостевую сессию
        const gid = localStorage.getItem('guest_id');
        if (gid) {
          apiDeleteGuestActivity(gid).catch(err => console.warn('[deleteGuestActivity error]', err));
          localStorage.removeItem('guest_id');
          localStorage.removeItem('last_guest_push');
        }

        try {
          const userDoc = await getDoc(userDocRef);
          const isAdmin = firebaseUser.email === import.meta.env.VITE_ADMIN_EMAIL;

          if (!userDoc.exists()) {
            const isRegistering = sessionStorage.getItem('is_registering') === 'true';

            // ЖЕСТКИЙ ЗАПРЕТ: Если нет флага регистрации — НИКОГДА НЕ ВЫЗЫВАЕМ setDoc
            if (!isRegistering) {
              console.warn('[AuthProvider] Документ профиля временно не найден в кэше Firestore. Запись заблокирована.');
              finishLoading();
              return;
            }

            // Логика создания НОВОГО пользователя при явной регистрации:
            const globalSettingsSnap = await getDoc(doc(db, 'settings', 'global'));
            const globalSettings = globalSettingsSnap.exists() ? globalSettingsSnap.data() : null;

            const registrationEnabled = globalSettings?.registrationEnabled !== false;

            if (!registrationEnabled && !isAdmin) {
              console.warn('[Registration] Blocked: registration is disabled.');
              sessionStorage.setItem('auth_error', 'registration_disabled');
              await signOut(auth);
              finishLoading();
              return;
            }

            const pendingNickname = sessionStorage.getItem('pending_nickname');
            const pendingMessage = sessionStorage.getItem('pending_message');

            let chosenNickname = (pendingNickname && typeof pendingNickname === 'string') ? pendingNickname.trim() : null;
            let finalNickname = chosenNickname || `${generateRandomNickname()}-${Math.random().toString(36).substring(2, 6)}`;

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
                language: 'ru',
                member_view_style: 'table'
              }
            };

            await setDoc(userDocRef, newUser, { merge: true });

            sessionStorage.removeItem('pending_nickname');
            sessionStorage.removeItem('pending_message');
            sessionStorage.removeItem('is_registering');

            await logAdminAction('user_registered', firebaseUser.uid, {
              email: firebaseUser.email,
              nickname: finalNickname,
              role_id: newUser.role_id
            }).catch(err => console.error('[audit log error]', err));
          } else {
            const data = userDoc.data();

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

            lastActivityRef.current = Date.now();

            if (isAdmin) {
              sessionStorage.removeItem('maintenance_logout');
            }
          }

          if (isAdmin) {
            seedSystemRoles(DEFAULT_ROLES).catch(err => console.warn('[seedSystemRoles]', err));

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

          readMapUnsubRef.current = subscribeToReadMap(firebaseUser.uid, setReadMap);

          profileUnsubRef.current = onSnapshot(userDocRef, async (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();
              setAuthError(null);

              if (isAdmin && data.role_id !== CHIEF_ADMIN_ID) {
                await setDoc(userDocRef, { role_id: CHIEF_ADMIN_ID, last_seen: serverTimestamp() }, { merge: true });
              } else {
                setProfile({ id: docSnap.id, ...data });
                if (isAdmin && data.nickname && firebaseUser && data.nickname !== settings?.adminNickname) {
                  setDoc(doc(db, 'settings', 'global'), { adminNickname: data.nickname }, { merge: true })
                    .catch(err => console.warn('[adminNickname sync]', err));
                }
              }
            } else {
              if (!profileUnsubRef._hasLoadedOnce) {
                setProfile(null);
              }
            }
            profileUnsubRef._hasLoadedOnce = true;
            finishLoading();
          }, (error) => {
            const isTransient = !error?.code ||
              error.code === 'unavailable' ||
              error.code === 'unknown' ||
              error.message === undefined;

            if (isTransient) {
              finishLoading();
              return;
            }

            console.error('Firestore profile listener error:', error);
            if (!profile) {
              setAuthError(error || new Error('Unknown Firestore Error'));
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

        if (profileUnsubRef.current) { profileUnsubRef.current(); profileUnsubRef.current = null; }
        if (readMapUnsubRef.current) { readMapUnsubRef.current(); readMapUnsubRef.current = null; }
        if (latestTopicsUnsubRef.current) { latestTopicsUnsubRef.current(); latestTopicsUnsubRef.current = null; }
      }
    });

    rolesUnsubRef.current = rolesUnsub;

    return () => {
      unsubGlobalSettings();
      unsubscribe();
      if (profileUnsubRef.current) profileUnsubRef.current();
      if (readMapUnsubRef.current) readMapUnsubRef.current();
      if (latestTopicsUnsubRef.current) latestTopicsUnsubRef.current();
      if (rolesUnsubRef.current) rolesUnsubRef.current();
    };
  }, []);

  useEffect(() => {
    if (user) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const GUEST_TICK_MS = 10 * 60 * 1000;
      const lastGuestPush = parseInt(localStorage.getItem('last_guest_push') || '0', 10);
      if (now - lastGuestPush >= GUEST_TICK_MS) {
        const gid = getOrCreateGuestId();
        apiRecordGuestActivity(gid).catch(err => console.warn('[guest_activity heartbeat]', err));
        localStorage.setItem('last_guest_push', now.toString());
      }
    }, 60000);

    return () => {
      clearInterval(interval);
    };
  }, [user, getOrCreateGuestId]);

  const hasPermission = useCallback((perm, context = {}) => {
    if (settings) {
      if (perm === PERMISSIONS.USE_DICE && settings.enableDice === false) return false;
      if (perm === PERMISSIONS.USE_MASKS && settings.enableCharacters === false) return false;
      if (perm === PERMISSIONS.USE_REPUTATION && settings.enableReputation === false) return false;
    }

    const adminEmail = import.meta.env.VITE_ADMIN_EMAIL;
    if (adminEmail && user?.email === adminEmail) return true;

    if (user && profile === null) return false;

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
    const effectiveRoleId = (isRestricted && isWhitelistOff)
      ? 'spectator'
      : (profile?.role_id || (user ? 'player' : 'guest'));

    if (effectiveRoleId === CHIEF_ADMIN_ID) return true;

    if (context?.category) {
      const catPerms = context.category.permissions;
      if (catPerms && catPerms[perm] !== undefined && catPerms[perm] !== null) {
        const allowedRoles = catPerms[perm];
        if (allowedRoles.includes(effectiveRoleId)) return true;

        const userRole = roles.find(r => r.id === effectiveRoleId);
        if (userRole?.base_role_id && allowedRoles.includes(userRole.base_role_id)) return true;

        return false;
      }
    }

    if (isRestricted && !isWhitelistOff) return false;

    const userRole = roles.find(r => r.id === effectiveRoleId) || DEFAULT_ROLES.find(r => r.id === effectiveRoleId);
    return !!normalizePermissions(userRole?.permissions).includes(perm);
  }, [user, profile, roles, settings]);

  const updateLocalTopicLastPost = useCallback((topicId, categoryId, topicTitle, lastPost, postsCount) => {
    if (!topicId || !lastPost) return;

    const lastPostDateIso = lastPost.created_at?.toMillis ? new Date(lastPost.created_at.toMillis()).toISOString() : (typeof lastPost.created_at === 'string' ? lastPost.created_at : new Date().toISOString());

    setLatestTopics(prevTopics => {
      const index = prevTopics.findIndex(t => t.id === topicId);
      const updatedTopicData = {
        id: topicId,
        category_id: categoryId,
        title: topicTitle,
        last_post_id: lastPost.id,
        last_post_at: lastPostDateIso,
        last_post_author_id: lastPost.author_id,
        last_post_author: lastPost.author_name || 'User',
        last_post_author_avatar: lastPost.author_avatar || '',
        last_post_author_role_id: lastPost.author_role_id || 'player',
        last_post_is_character: !!lastPost.is_character,
        last_post_author_character_id: lastPost.author_character_id || null,
        posts_count: postsCount
      };

      if (index !== -1) {
        const newArr = [...prevTopics];
        newArr[index] = { ...newArr[index], ...updatedTopicData };
        newArr.sort((a, b) => new Date(b.last_post_at).getTime() - new Date(a.last_post_at).getTime());
        return newArr;
      } else {
        const newArr = [updatedTopicData, ...prevTopics];
        newArr.sort((a, b) => new Date(b.last_post_at).getTime() - new Date(a.last_post_at).getTime());
        return newArr.slice(0, 50);
      }
    });

    if (categoryId) {
      setCategories(prevCats => {
        return prevCats.map(cat => {
          if (cat.id === categoryId) {
            const isSameTopic = cat.last_post_topic_id === topicId;
            const currentLastMs = cat.last_post_at ? (cat.last_post_at.toMillis ? cat.last_post_at.toMillis() : new Date(cat.last_post_at).getTime()) : 0;
            const newLastMs = new Date(lastPostDateIso).getTime();

            // If the category's last post is from THIS topic, update it ALWAYS (even when deleting a post makes lastPost earlier).
            // Otherwise, update if the new post timestamp is newer.
            if (isSameTopic || newLastMs >= currentLastMs) {
              return {
                ...cat,
                last_post_topic_id: topicId,
                last_post_topic_title: topicTitle,
                last_post_at: lastPostDateIso,
                last_post_author_id: lastPost.author_id,
                last_post_author: lastPost.author_name || 'User',
                last_post_author_avatar: lastPost.author_avatar || '',
                last_post_author_role_id: lastPost.author_role_id || 'player',
                last_post_is_character: !!lastPost.is_character,
                last_post_author_character_id: lastPost.author_character_id || null,
                last_post_topic_posts_count: postsCount
              };
            }
          }
          return cat;
        });
      });
    }
  }, []);

  const lastForumRefreshTimeRef = useRef(0);
  const FORUM_REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown

  const refreshForumState = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastForumRefreshTimeRef.current < FORUM_REFRESH_COOLDOWN_MS)) {
      return;
    }
    lastForumRefreshTimeRef.current = now;
    try {
      const data = await fetchSecuredMainPageData();
      if (data.categories) setCategories(data.categories);
      if (data.latestTopics) setLatestTopics(data.latestTopics);
      if (data.stats) setForumStats(data.stats);
      if (data.dailyActiveUsers) setDailyActiveUsers(data.dailyActiveUsers);
    } catch (err) {
      console.error('[refreshForumState]', err);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    refreshForumState(true);
  }, [loading, user?.uid, refreshForumState]);

  useEffect(() => {
    if (!user || latestTopics.length === 0) {
      setUnreadTopicsCount(0);
      return;
    }

    const registrationMs = profile?.created_at?.toMillis?.() || 0;

    const count = latestTopics.filter(topic => {
      const category = categories.find(c => c.id === topic.category_id);
      if (!category || !hasPermission(PERMISSIONS.VIEW_FORUM, { category })) return false;

      if (topic.last_post_author_id === user.uid) return false;

      const entry = readMap[topic.id];
      const lastVisitValue = entry?.timestamp || entry;
      const lastVisitMs = lastVisitValue?.toMillis ? lastVisitValue.toMillis() : (lastVisitValue || 0);
      const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);
      const lastPostMs = topic.last_post_at?.toMillis?.() ??
        (typeof topic.last_post_at === 'string' ? new Date(topic.last_post_at).getTime() : 0);

      return lastPostMs > effectiveLastVisitMs;
    }).length;

    setUnreadTopicsCount(count);
  }, [user, profile, latestTopics, readMap, categories, hasPermission]);

  const markTopicRead = useCallback(async (topicId, offset = null) => {
    if (!user || !topicId) return;
    const now = Date.now();
    
    // Calculate the final offset using the current readMap state to avoid async closure issues
    const currentReadMap = readMap[topicId];
    const prevOffset = currentReadMap?.offset ?? -1;
    
    // Do not allow offset to decrease or re-trigger if already at or past this offset
    if (offset !== null && offset <= prevOffset) return;
    
    // If no new offset is provided, but we had one, preserve it
    const finalOffset = offset !== null ? offset : (prevOffset !== -1 ? prevOffset : null);
    
    const value = finalOffset !== null ? { timestamp: now, offset: finalOffset } : now;
    
    setReadMap(prev => ({ ...prev, [topicId]: value }));

    try {
      await apiRecordTopicVisit(user.uid, topicId, finalOffset);
      if (profile?.role_id !== 'pending' && profile?.role_id !== 'banned') {
        await markTopicNotificationsRead(user.uid, topicId);
      }
    } catch (err) {
      console.error('[markTopicRead]', err);
    }
  }, [user, profile?.role_id, readMap]);

  const markAllRead = useCallback(async () => {
    if (!user || latestTopics.length === 0 || isMarkingAllRead) return;

    setIsMarkingAllRead(true);
    try {
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

  React.useEffect(() => {
    if (user && !loading) {
      const isRegistering = sessionStorage.getItem('is_registering') === 'true';

      if (!profile && !isRegistering && !authError) {
        console.warn('[AuthProvider] Profile missing for authenticated user. Triggering logout.');
        logout(true);
        return;
      }

      if (profile) {
        const isAdmin = hasPermission(PERMISSIONS.ADMIN_ACCESS);
        const isBanned = profile.role_id === 'banned';

        const isMaintenanceStrict = settings?.maintenanceMode && (settings.whitelistMode !== false);

        if (isBanned) {
          sessionStorage.setItem('banned_logout', 'true');
          logout(true);
        } else if (isMaintenanceStrict && !isAdmin) {
          sessionStorage.setItem('maintenance_logout', 'true');
          logout();
        }
      }
    }
  }, [settings?.maintenanceMode, settings?.whitelistMode, user, profile, loading, hasPermission, logout, authError]);

  useEffect(() => {
    // При возвращении на вкладку обновляем статичные данные форума (с соблюдением 5-минутного cooldown)
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshForumState(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshForumState]);

  const isUserOnline = useCallback((uid) => {
    if (!uid) return false;
    return activeUserIds.has(uid);
  }, [activeUserIds]);

  const isRootAdmin = isChiefAdmin(user?.email, profile?.role_id);

  const value = {
    user,
    profile,
    setProfile,
    authError,
    isRootAdmin,
    settings,
    loading,
    readMap,
    categories,
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
    refreshForumState,
    forumStats,
    dailyActiveUsers,
    updateLocalTopicLastPost,
    hasPermission,
    roles,
    activeUsers,
    activeUserIds,
    isUserOnline,
    PERMISSIONS,
    DEFAULT_ROLES
  };

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};