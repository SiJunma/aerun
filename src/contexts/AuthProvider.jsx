/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { pb, sendApi } from '../api/pocketbase';
import LoadingPreloader from '../components/common/LoadingPreloader';
import {
  markAllTopicsRead,
  subscribeToReadMap,
  recordTopicVisit as apiRecordTopicVisit
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
import { fetchSecuredMainPageData } from '../api/categories';
import { subscribeToRoles, getGlobalSettings } from '../api/admin';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES, normalizePermissions, isChiefAdmin } from '../constants/permissions';

const AuthContext = createContext();
const FORUM_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export const useAuth = () => useContext(AuthContext);

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState({
    forumName: 'Aerun Forum',
    maintenanceMode: false,
    whitelistMode: false,
    registrationEnabled: true,
    requireApproval: false,
    postsPerPage: 20,
    maxPostsPerTopic: 1000
  });
  const [loading, setLoading] = useState(true);
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [readMap, setReadMap] = useState({});
  const [readMapReady] = useState(true);
  const [latestTopics, setLatestTopics] = useState([]);
  const [categories, setCategories] = useState([]);
  const [forumStateLoading, setForumStateLoading] = useState(true);
  const [forumStateError, setForumStateError] = useState(null);
  const [forumStats, setForumStats] = useState(null);
  const [dailyActiveUsers, setDailyActiveUsers] = useState([]);
  const [unreadTopicsCount] = useState(0);
  const [dmUnread, setDmUnread] = useState({ total: 0, conversations: {} });
  const [activeDmConvId, setActiveDmConvId] = useState(null);
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [authError] = useState(null);
  const [activeUsers, setActiveUsers] = useState([]);
  const activeUserIds = useMemo(() => new Set(activeUsers.map(u => u.id)), [activeUsers]);

  const lastActivityRef = useRef(Date.now());
  const isRtdbOnlineRef = useRef(true);
  const lastPushTimeRef = useRef(0);
  const lastOptimisticForumUpdateRef = useRef(0);
  const forumRefreshTimersRef = useRef(new Set());
  const lastForumRefreshTimeRef = useRef(0);
  const latestTopicsRef = useRef([]);
  latestTopicsRef.current = latestTopics;
  const readMapRef = useRef({});
  readMapRef.current = readMap;

  // getOrCreateGuestId returns the opaque per-browser visitor id used for
  // anonymous presence. It is generated once (the legacy generator: a random
  // base36 part plus a timestamp) and lives in localStorage; the backend only
  // ever sees this id and a timestamp. Logging in clears it (see below), so a
  // new guest session starts fresh after a logout.
  const getOrCreateGuestId = useCallback(() => {
    let gid = localStorage.getItem('guest_id');
    if (!gid) {
      gid = Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('guest_id', gid);
    }
    return gid;
  }, []);

  // Initialize Auth State from PocketBase authStore
  const syncUserFromAuthStore = useCallback(() => {
    if (pb.authStore.isValid && pb.authStore.record) {
      const rec = pb.authStore.record;
      const u = {
        uid: rec.id,
        id: rec.id,
        email: rec.email,
        displayName: rec.nickname || rec.email?.split('@')[0],
        photoURL: rec.avatar_url || '',
        providerData: [{ providerId: 'password' }]
      };
      const p = {
        id: rec.id,
        uid: rec.id,
        nickname: rec.nickname || rec.email?.split('@')[0] || 'User',
        role_id: rec.role || 'player',
        avatar_url: rec.avatar_url || '',
        status: rec.status || 'active',
        settings: rec.settings || {},
        post_count: rec.post_count || 0,
        status_line: rec.status_line || ''
      };
      setUser(u);
      setProfile(p);
      setEmailUnverified(rec.verified === false);
    } else {
      setUser(null);
      setProfile(null);
      setEmailUnverified(false);
    }
  }, []);

  useEffect(() => {
    syncUserFromAuthStore();
    const unsubAuth = pb.authStore.onChange(() => {
      syncUserFromAuthStore();
    });

    // Load global settings
    getGlobalSettings(data => {
      if (data) setSettings(prev => ({ ...prev, ...data }));
    });

    // Subscribe to roles
    const unsubRoles = subscribeToRoles(r => {
      if (r && r.length > 0) setRoles(r);
    });

    // Finish preloader
    const timer = setTimeout(() => {
      setLoading(false);
    }, 600);

    return () => {
      unsubAuth();
      unsubRoles();
      clearTimeout(timer);
    };
  }, [syncUserFromAuthStore]);

  // Presence and DM subscriptions. A signed-in visitor beats as a member; an
  // anonymous one beats as a guest so the stats panel can count them.
  useEffect(() => {
    if (user?.uid && profile) {
      return initRtdbPresence(user.uid, profile);
    }
    return initRtdbGuestPresence(getOrCreateGuestId());
  }, [user?.uid, profile, getOrCreateGuestId]);

  // Logging in ends the guest session: the guest_presence row and the stored id
  // both go, so a visitor who registers or signs in is never counted as a guest
  // (the heartbeat switches to the member path) and a later logout starts a new
  // guest identity instead of resurrecting the old one.
  useEffect(() => {
    if (!user?.uid) return;
    const guestId = localStorage.getItem('guest_id');
    if (!guestId) return;
    removeRtdbGuestPresence(guestId);
    localStorage.removeItem('guest_id');
  }, [user?.uid]);

  useEffect(() => {
    return subscribeToOnlineUsers(setActiveUsers);
  }, []);

  useEffect(() => {
    if (user?.uid) {
      return subscribeToDmUnread(user.uid, setDmUnread);
    } else {
      setDmUnread({ total: 0, conversations: {} });
    }
  }, [user?.uid]);

  // Readmap subscription
  useEffect(() => {
    if (user?.uid) {
      return subscribeToReadMap(user.uid, map => {
        setReadMap(map || {});
      });
    } else {
      setReadMap({});
    }
  }, [user?.uid]);

  // Activity tracking
  const recordActivity = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    if (user?.uid && profile) {
      const PUSH_INTERVAL_MS = 2 * 60 * 1000;
      if (!isRtdbOnlineRef.current || (now - lastPushTimeRef.current >= PUSH_INTERVAL_MS)) {
        isRtdbOnlineRef.current = true;
        lastPushTimeRef.current = now;
        setRtdbOnline(user.uid, profile).catch(() => {});
      }
    }
  }, [user, profile]);

  useEffect(() => {
    if (!user?.uid || !profile) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const idleTime = now - (lastActivityRef.current || now);
      if (idleTime >= IDLE_TIMEOUT_MS && isRtdbOnlineRef.current) {
        isRtdbOnlineRef.current = false;
        setRtdbOffline(user.uid, false).catch(() => {});
      }
    }, 15000);

    let throttleTimer = null;
    const onUserInteraction = () => {
      if (!throttleTimer) {
        recordActivity();
        throttleTimer = setTimeout(() => { throttleTimer = null; }, 10000);
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

  // Auth actions
  const loginWithGoogle = async () => {
    const authData = await pb.collection('users').authWithOAuth2({ provider: 'google' });
    syncUserFromAuthStore();
    return authData;
  };

  const registerWithEmail = async (email, password, nickname = '', adminMessage = '') => {
    await sendApi('/api/aerun/auth/register', {
      method: 'POST',
      body: {
        email,
        password,
        nickname: nickname.trim() || email.split('@')[0],
        admin_message: adminMessage || ''
      }
    });
    const authData = await pb.collection('users').authWithPassword(email, password);
    syncUserFromAuthStore();
    return authData;
  };

  const loginWithEmail = async (email, password) => {
    const authData = await pb.collection('users').authWithPassword(email, password);
    syncUserFromAuthStore();
    return authData;
  };

  const resetPassword = async (email) => {
    return await pb.collection('users').requestPasswordReset(email);
  };

  const resendVerificationEmail = async () => {};
  const checkVerificationStatus = async () => {};

  const logout = useCallback(async (skipPresenceCleanup = false) => {
    const uid = user?.uid;
    if (uid && !skipPresenceCleanup) {
      await setRtdbOffline(uid, true);
    }
    clearAllDmCache();
    pb.authStore.clear();
    syncUserFromAuthStore();
  }, [user?.uid, syncUserFromAuthStore]);

  const updateSettings = async (newSettings) => {
    if (!user) return;
    const updated = { ...(profile?.settings || {}), ...newSettings };
    const res = await sendApi('/api/aerun/me/settings', {
      method: 'PUT',
      body: updated
    });
    setProfile(prev => ({
      ...prev,
      settings: res?.settings || updated
    }));
  };

  const updateProfile = async (newData, targetUid = null) => {
    if (!user) return;
    const finalUid = targetUid || user.uid;
    if (finalUid !== user.uid) {
      await sendApi(`/api/aerun/admin/users/${finalUid}`, {
        method: 'PATCH',
        body: newData
      });
    } else {
      if (newData.settings) {
        await updateSettings(newData.settings);
      }
      setProfile(prev => ({ ...prev, ...newData }));
    }
  };

  const refreshForumState = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastForumRefreshTimeRef.current < FORUM_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastForumRefreshTimeRef.current = now;
    setForumStateLoading(true);
    setForumStateError(null);

    try {
      const data = await fetchSecuredMainPageData();
      if (data?.categories) setCategories(data.categories);
      if (data?.latestTopics) setLatestTopics(data.latestTopics);
      if (data?.stats) setForumStats(data.stats);
      if (data?.dailyActiveUsers) setDailyActiveUsers(data.dailyActiveUsers);
    } catch (err) {
      console.warn('[refreshForumState err]', err);
      setForumStateError(err);
    } finally {
      setForumStateLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshForumState(true);
  }, [refreshForumState]);

  const scheduleForumStateRefresh = useCallback((delayMs = 1500) => {
    const timer = setTimeout(() => {
      refreshForumState(true);
      forumRefreshTimersRef.current.delete(timer);
    }, delayMs);
    forumRefreshTimersRef.current.add(timer);
  }, [refreshForumState]);

  const applyForumState = useCallback((data) => {
    if (!data) return;
    if (Array.isArray(data.categories)) setCategories(data.categories);
    if (Array.isArray(data.latestTopics)) setLatestTopics(data.latestTopics);
    if (data.stats) setForumStats(data.stats);
  }, []);

  // The optimistic post-count bump was a Firestore-era local patch for the
  // category counters. Counts now come back from the server on every poll, so
  // the optimistic update is not just redundant — it would briefly show a
  // number the backend has not agreed to yet. The ref stamp stays: it is what
  // tells applyForumState to trust the incoming snapshot.
  const updateLocalTopicLastPost = useCallback((topicId, _categoryId, _topicTitle, lastPost, _postsCount) => {
    if (!topicId || !lastPost) return;
    lastOptimisticForumUpdateRef.current = Date.now();
  }, []);

  const updateLocalTopicPostsCount = useCallback((_topicId, _delta) => {}, []);

  const markTopicRead = useCallback(async (topicId, offset = null) => {
    if (!user?.uid || !topicId) return;
    const now = Date.now();
    setReadMap(prev => ({ ...prev, [topicId]: now }));
    await apiRecordTopicVisit(user.uid, topicId, offset);
  }, [user?.uid]);

  const markAllRead = useCallback(async () => {
    if (!user?.uid || latestTopicsRef.current.length === 0 || isMarkingAllRead) return;
    setIsMarkingAllRead(true);
    try {
      const topicIds = latestTopicsRef.current.map(t => t.id);
      await markAllTopicsRead(user.uid, topicIds);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [user?.uid, isMarkingAllRead]);

  // Permission checks
  const hasPermission = useCallback((perm) => {
    if (!user) {
      // Guest
      const guestRole = roles.find(r => r.id === 'spectator') || DEFAULT_ROLES.find(r => r.id === 'spectator');
      return !!normalizePermissions(guestRole?.permissions).includes(perm);
    }

    const effectiveRoleId = profile?.role_id || 'player';
    if (effectiveRoleId === 'root' || effectiveRoleId === CHIEF_ADMIN_ID) return true;

    const userRole = roles.find(r => r.id === effectiveRoleId) || DEFAULT_ROLES.find(r => r.id === effectiveRoleId);
    return !!normalizePermissions(userRole?.permissions).includes(perm);
  }, [user, profile, roles]);

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
    readMapReady,
    latestTopics,
    categories,
    forumStateLoading,
    forumStateError,
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
    scheduleForumStateRefresh,
    applyForumState,
    forumStats,
    dailyActiveUsers,
    updateLocalTopicLastPost,
    updateLocalTopicPostsCount,
    hasPermission,
    roles,
    activeUsers,
    activeUserIds,
    isUserOnline,
    PERMISSIONS,
    DEFAULT_ROLES
  }), [
    user, profile, authError, isRootAdmin, settings, loading, readMap, readMapReady, categories, forumStateLoading, forumStateError,
    unreadTopicsCount, dmUnread, activeDmConvId, setActiveDmConvId, isMarkingAllRead, markTopicRead, markAllRead,
    loginWithGoogle, registerWithEmail, loginWithEmail, resetPassword,
    resendVerificationEmail, checkVerificationStatus, emailUnverified, logout,
    updateSettings, updateProfile, recordActivity, refreshForumState, scheduleForumStateRefresh, applyForumState, forumStats,
    dailyActiveUsers, updateLocalTopicLastPost, updateLocalTopicPostsCount, hasPermission, roles, activeUsers,
    activeUserIds, isUserOnline, latestTopics
  ]);

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};
