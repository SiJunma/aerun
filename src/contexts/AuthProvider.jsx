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
  setRtdbOnline,
  setRtdbOffline,
  subscribeToOnlineUsers,
  initRtdbGuestPresence,
  removeRtdbGuestPresence
} from '../api/rtdb-presence';
import { subscribeToDmUnread } from '../api/dms';
import { clearAllDmCache } from '../api/dm-cache';
import { fetchSecuredMainPageData, subscribeToMainPageCategoriesRtdb, subscribeToMainPageStatsRtdb } from '../api/categories';
import { subscribeToRoles, seedSystemRoles } from '../api/admin';
import { logAdminAction } from '../api/audit';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES, normalizePermissions, isChiefAdmin } from '../constants/permissions';
import { generateRandomNickname } from '../utils/nickname';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

// How long without any activity before switching status to offline (5 min)
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity before going offline
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
  const [dmUnread, setDmUnread] = useState({ total: 0, conversations: {} });
  const [activeDmConvId, setActiveDmConvId] = useState(null); // Currently open DM conversation
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
  // Ref tracking if the current user is marked 'online' in RTDB
  const isRtdbOnlineRef = useRef(true);
  // Ref holding the timestamp of the last database push (last_seen)
  const lastPushTimeRef = useRef(0);
  const lastFirestorePushTimeRef = useRef(0);

  // Listener Refs (persisted across renders for cleanup)
  const profileUnsubRef = useRef(null);
  const readMapUnsubRef = useRef(null);
  const latestTopicsUnsubRef = useRef(null);
  const rolesUnsubRef = useRef(null);
  const catsUnsubRef = useRef(null);

  // RTDB Presence initialization (runs on connect / login / profile load)
  useEffect(() => {
    if (user?.uid && profile && profile.id === user.uid) {
      isRtdbOnlineRef.current = true;
      lastPushTimeRef.current = Date.now();
      return initRtdbPresence(user.uid, profile);
    }
  }, [user?.uid, profile?.id, profile?.nickname, profile?.avatar_url, profile?.role_id]);

  // Real-time Online Users subscription from RTDB (0 Firestore reads)
  useEffect(() => {
    return subscribeToOnlineUsers(setActiveUsers);
  }, []);

  // Real-time Categories & Stats subscriptions from RTDB (0 Firestore reads)
  useEffect(() => {
    const unsubCats = subscribeToMainPageCategoriesRtdb((cats) => {
      if (cats && cats.length > 0) {
        setCategories(cats);
      }
    });
    const unsubStats = subscribeToMainPageStatsRtdb((stats) => {
      if (stats) {
        setForumStats(stats);
      }
    });
    return () => {
      if (unsubCats) unsubCats();
      if (unsubStats) unsubStats();
    };
  }, []);

  // Real-time DM Unread subscription from RTDB (0 Firestore reads)
  useEffect(() => {
    if (user?.uid) {
      return subscribeToDmUnread(user.uid, setDmUnread);
    } else {
      setDmUnread({ total: 0, conversations: {} });
    }
  }, [user?.uid]);

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
   * (page navigation, posting a reply, creating a topic, clicks/typing, etc.)
   */
  const recordActivity = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;

    if (user?.uid && profile) {
      // If user was offline due to inactivity/idle, or every 2 minutes of active interaction, push fresh timestamp to RTDB
      const PUSH_INTERVAL_MS = 2 * 60 * 1000;
      if (!isRtdbOnlineRef.current || (now - lastPushTimeRef.current >= PUSH_INTERVAL_MS)) {
        isRtdbOnlineRef.current = true;
        lastPushTimeRef.current = now;
        setRtdbOnline(user.uid, profile).catch(err => console.warn('[setRtdbOnline resume err]', err));
      }

      // Periodic sync to Firestore users document (throttled to every 5 minutes to minimize writes)
      const FIRESTORE_PUSH_INTERVAL_MS = 5 * 60 * 1000;
      if (now - lastFirestorePushTimeRef.current >= FIRESTORE_PUSH_INTERVAL_MS) {
        lastFirestorePushTimeRef.current = now;
        setDoc(doc(db, 'users', user.uid), { last_seen: serverTimestamp() }, { merge: true })
          .catch(err => console.warn('[sync last_seen to firestore err]', err));
      }

      // 1. Если пользователь авторизован, но остался старый guest_id — удаляем его запись из guest_presence
      const gid = localStorage.getItem('guest_id');
      if (gid) {
        removeRtdbGuestPresence(gid);
        apiDeleteGuestActivity(gid).catch(() => {});
        localStorage.removeItem('guest_id');
      }
    }
  }, [user, profile]);

  // Inactivity detection: auto-switch to 'offline' after exactly 15 minutes of no clicks/keydowns
  useEffect(() => {
    if (!user?.uid || !profile) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const idleTime = now - (lastActivityRef.current || now);
      if (idleTime >= IDLE_TIMEOUT_MS && isRtdbOnlineRef.current) {
        isRtdbOnlineRef.current = false;
        setRtdbOffline(user.uid, false).catch(err => console.warn('[setRtdbOffline idle err]', err));
      }
    }, 15 * 1000); // Check every 15 seconds for timely transition to offline

    let throttleTimer = null;
    const onUserInteraction = () => {
      if (!throttleTimer) {
        recordActivity();
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
        }, 10000); // Throttle to at most once per 10 seconds
      }
    };

    window.addEventListener('click', onUserInteraction, { passive: true });
    window.addEventListener('keydown', onUserInteraction, { passive: true });

    return () => {
      clearInterval(interval);
      if (throttleTimer) clearTimeout(throttleTimer);
      window.removeEventListener('click', onUserInteraction);
      window.removeEventListener('keydown', onUserInteraction);
    };
  }, [user?.uid, profile, recordActivity]);

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
          await setRtdbOffline(uid, true); // isLogout=true cancels the onDisconnect hook
          await deleteDoc(doc(db, 'user_presence', uid)).catch(() => { });
          setActiveUsers(prev => prev.filter(u => u.id !== uid));
        } catch (e) {
          console.warn('[logout presence cleanup error]', e);
        }
      }

      localStorage.removeItem('last_guest_push');
      clearAllDmCache();
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

    if (updatedData.nickname && (finalUid === forumStats?.newestUser?.id || finalUid === forumStats?.newest_user_id)) {
      setForumStats(prev => prev ? {
        ...prev,
        newestUser: {
          ...prev.newestUser,
          nickname: updatedData.nickname
        }
      } : prev);
      setDoc(doc(db, 'forum_stats', 'global'), {
        newest_user: {
          id: finalUid,
          nickname: updatedData.nickname
        }
      }, { merge: true }).catch(() => {});
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
        setProfile(prev => (prev?.id === firebaseUser.uid ? prev : null));
        setUser(firebaseUser);

        const usesPassword = firebaseUser.providerData.some(p => p.providerId === 'password');
        setEmailUnverified(usesPassword && !firebaseUser.emailVerified);

        const userDocRef = doc(db, 'users', firebaseUser.uid);

        // 1. Очищаем гостевую сессию
        const gid = localStorage.getItem('guest_id');
        if (gid) {
          removeRtdbGuestPresence(gid);
          apiDeleteGuestActivity(gid).catch(() => {});
          localStorage.removeItem('guest_id');
        }

        try {
          const userDoc = await getDoc(userDocRef);
          const isAdmin = firebaseUser.email === import.meta.env.VITE_ADMIN_EMAIL;

          if (!userDoc.exists()) {
            const isRegistering = sessionStorage.getItem('is_registering') === 'true';

            // Разрешаем воссоздание профиля, если пользователь регистрируется 
            // ИЛИ если у него уже подтверждена почта/он вошел через пароль/провайдер
            const isExistingAuthUser = !!firebaseUser.uid;

            if (!isRegistering && !isExistingAuthUser) {
              console.warn('[AuthProvider] Документ профиля не найден. Запись заблокирована.');
              finishLoading();
              return;
            }

            // Получаем настройки
            const globalSettingsSnap = await getDoc(doc(db, 'settings', 'global'));
            const globalSettings = globalSettingsSnap.exists() ? globalSettingsSnap.data() : null;

            const registrationEnabled = globalSettings?.registrationEnabled !== false;

            if (!registrationEnabled && !isAdmin && isRegistering) {
              console.warn('[Registration] Blocked: registration is disabled.');
              sessionStorage.setItem('auth_error', 'registration_disabled');
              await signOut(auth);
              finishLoading();
              return;
            }

            // Восстанавливаем никнейм из сессии или генерируем из почты/рандома
            const pendingNickname = sessionStorage.getItem('pending_nickname');
            const pendingMessage = sessionStorage.getItem('pending_message');

            let finalNickname = (pendingNickname && typeof pendingNickname === 'string')
              ? pendingNickname.trim()
              : (firebaseUser.displayName || firebaseUser.email?.split('@')[0] || `${generateRandomNickname()}-${Math.random().toString(36).substring(2, 6)}`);

            const defaultAvatar = firebaseUser.photoURL || `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(finalNickname)}`;

            // Если у пользователя подтверждена почта или отключена пре-модерация — даем роль player
            const isEmailVerified = firebaseUser.emailVerified;
            const requireApproval = globalSettings?.requireApproval !== false;

            const initialRole = isAdmin
              ? CHIEF_ADMIN_ID
              : ((!requireApproval || isEmailVerified) ? 'player' : 'pending');

            const initialLanguage = localStorage.getItem('preferred_language')
              || localStorage.getItem('i18nextLng')
              || (navigator.language?.startsWith('ru') ? 'ru' : 'en')
              || 'ru';

            const newUser = {
              uid: firebaseUser.uid,
              email: firebaseUser.email,
              nickname: finalNickname,
              avatar_url: defaultAvatar,
              status_line: 'Hello, I am new here!',
              role_id: initialRole,
              status: initialRole === 'banned' ? 'banned' : (initialRole === 'pending' ? 'pending' : 'active'),
              post_count: 0,
              reputation: 0,
              created_at: serverTimestamp(),
              last_seen: serverTimestamp(),
              ...(pendingMessage ? { admin_message: pendingMessage } : {}),
              settings: {
                theme: localStorage.getItem('guest_theme') || 'dark',
                language: initialLanguage,
                member_view_style: 'table',
                email_notifications: {
                  dms: true,
                  topic_replies: true
                }
              }
            };

            // Создаем отсутствующий профиль в Firestore
            await setDoc(userDocRef, newUser, { merge: true });

            // Обновляем статистику
            setForumStats(prev => ({
              ...prev,
              totalUsers: (prev?.totalUsers || 0) + 1,
              newestUser: {
                id: firebaseUser.uid,
                nickname: finalNickname,
                role_id: newUser.role_id
              }
            }));

            // 3. Фоново запрашиваем обновленное состояние с сервера
            setTimeout(() => {
              refreshForumState(true);
            }, 500);

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
                  await setDoc(userDocRef, { role_id: 'player' }, { merge: true });
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

          // ВАЖНО: Подписки на карту прочитанного и темы активируем ТОЛЬКО ПОСЛЕ того, 
          // как профиль пользователя гарантированно существует в Firestore!
          readMapUnsubRef.current = subscribeToReadMap(firebaseUser.uid, setReadMap);
          latestTopicsUnsubRef.current = subscribeToLatestTopics(setLatestTopics, 50);

          profileUnsubRef.current = onSnapshot(userDocRef, async (docSnap) => {
            if (docSnap.exists()) {
              const rawData = docSnap.data();
              const data = {
                ...rawData,
                status: rawData.status || (rawData.role_id === 'banned' ? 'banned' : (rawData.role_id === 'pending' ? 'pending' : 'active'))
              };
              setAuthError(null);

              if (isAdmin && data.role_id !== CHIEF_ADMIN_ID) {
                await setDoc(userDocRef, { role_id: CHIEF_ADMIN_ID, last_seen: serverTimestamp() }, { merge: true });
              } else {
                setProfile({ id: docSnap.id, ...data });
                if (isAdmin && data.nickname && firebaseUser && settings?.adminNickname && data.nickname !== settings.adminNickname) {
                  setDoc(doc(db, 'settings', 'global'), { adminNickname: data.nickname }, { merge: true })
                    .catch(err => console.warn('[adminNickname sync]', err));
                }
              }
            } else {
              // Profile document was deleted (e.g. by admin). Force sign-out to clear the
              // client session — onAuthStateChanged will then handle full cleanup.
              console.warn('[AuthProvider] Profile document missing — forcing sign-out.');
              signOut(auth).catch(err => console.warn('[AuthProvider] Force sign-out error:', err));
            }
            finishLoading();
          }, (error) => {
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
    const gid = getOrCreateGuestId();
    const unsubGuest = initRtdbGuestPresence(gid);

    return () => {
      if (typeof unsubGuest === 'function') unsubGuest();
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
      if (data.latestTopics && data.latestTopics.length > 0) setLatestTopics(data.latestTopics);
      if (data.stats) setForumStats(data.stats);
      if (data.dailyActiveUsers) setDailyActiveUsers(data.dailyActiveUsers);
    } catch (err) {
      console.error('[refreshForumState]', err);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    // Debounce: loading→false and uid→value can fire as two separate renders.
    // Wait 100ms so both settle before making the network call.
    const timer = setTimeout(() => {
      refreshForumState(true);
    }, 100);
    return () => clearTimeout(timer);
  }, [loading, user?.uid, refreshForumState]);

  useEffect(() => {
    if (!user?.uid || latestTopics.length === 0) {
      setUnreadTopicsCount(0);
      return;
    }

    const registrationMs = profile?.created_at?.toMillis?.()
      || (profile?.created_at ? new Date(profile.created_at).getTime() : 0);

    const count = latestTopics.filter(topic => {
      const category = categories.find(c => c.id === topic.category_id);
      if (category && !hasPermission(PERMISSIONS.VIEW_FORUM, { category })) return false;

      if (topic.last_post_author_id === user.uid) return false;

      const entry = readMap[topic.id];
      const lastVisitValue = entry?.timestamp || entry;
      const lastVisitMs = lastVisitValue?.toMillis
        ? lastVisitValue.toMillis()
        : (typeof lastVisitValue === 'number' ? lastVisitValue : (lastVisitValue ? new Date(lastVisitValue).getTime() : 0));
      const effectiveLastVisitMs = Math.max(lastVisitMs, registrationMs);
      const lastPostMs = topic.last_post_at?.toMillis?.() ??
        (typeof topic.last_post_at === 'string' ? new Date(topic.last_post_at).getTime() : (typeof topic.last_post_at === 'number' ? topic.last_post_at : 0));

      return lastPostMs > effectiveLastVisitMs;
    }).length;

    setUnreadTopicsCount(count);
  }, [user?.uid, profile?.created_at, latestTopics, readMap, categories, hasPermission]);

  const readMapRef = useRef(readMap);
  readMapRef.current = readMap;

  const latestTopicsRef = useRef(latestTopics);
  latestTopicsRef.current = latestTopics;

  const markTopicRead = useCallback(async (topicId, offset = null) => {
    if (!user?.uid || !topicId) return;
    const now = Date.now();

    // Calculate the final offset using the current readMap state from ref
    const currentReadMap = readMapRef.current?.[topicId];
    const prevOffset = currentReadMap?.offset ?? -1;

    // Preserve or advance offset (never regress)
    const finalOffset = offset !== null ? Math.max(offset, prevOffset) : (prevOffset !== -1 ? prevOffset : null);

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
  }, [user?.uid, profile?.role_id]);

  const markAllRead = useCallback(async () => {
    if (!user?.uid || latestTopicsRef.current.length === 0 || isMarkingAllRead) return;

    setIsMarkingAllRead(true);
    try {
      const now = Date.now();
      const newReadMap = { ...(readMapRef.current || {}) };
      const topicIds = latestTopicsRef.current.map(t => {
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
  }, [user?.uid, isMarkingAllRead]);

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
    // При возвращении на вкладку обновляем активность и статичные данные форума (с соблюдением cooldown)
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshForumState(false);
        recordActivity();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshForumState, recordActivity]);

  const isUserOnline = useCallback((uid) => {
    if (!uid) return false;
    return activeUserIds.has(uid);
  }, [activeUserIds]);

  const isRootAdmin = isChiefAdmin(user?.email, profile?.role_id);

  const value = useMemo(() => ({
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
    dmUnread,
    activeDmConvId,
    setActiveDmConvId,
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
  }), [
    user, profile, authError, isRootAdmin, settings, loading, readMap, categories,
    unreadTopicsCount, dmUnread, activeDmConvId, setActiveDmConvId, isMarkingAllRead, markTopicRead, markAllRead,
    loginWithGoogle, registerWithEmail, loginWithEmail, resetPassword,
    resendVerificationEmail, checkVerificationStatus, emailUnverified, logout,
    updateSettings, updateProfile, recordActivity, refreshForumState, forumStats,
    dailyActiveUsers, updateLocalTopicLastPost, hasPermission, roles, activeUsers,
    activeUserIds, isUserOnline
  ]);

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};