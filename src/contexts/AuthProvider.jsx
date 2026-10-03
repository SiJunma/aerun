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
  // ever sees this id and a timestamp.
  //
  // "Once" is the load-bearing word, and localStorage cannot enforce it. Two
  // tabs of the same browser share one storage area but run independent
  // JavaScript, so a get-then-set here is a race: both tabs can read `null`,
  // both mint an id, and the second write overwrites the first. Each tab then
  // beats with the id IT generated, and the forum counts one person as two
  // guests — which is exactly what a two-tab logout used to produce.
  //
  // Re-reading after the write makes both tabs converge on whichever value
  // ended up stored, instead of each keeping its own.
  const getOrCreateGuestId = useCallback(() => {
    const stored = localStorage.getItem('guest_id');
    if (stored) return stored;

    const candidate = Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem('guest_id', candidate);
    return localStorage.getItem('guest_id') || candidate;
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

  // Logging in ends the guest session: the guest_presence row goes, so a visitor
  // who registers or signs in is never counted as a guest (the heartbeat
  // switches to the member path).
  //
  // The STORED ID STAYS. Deleting it here was what made the second symptom: the
  // id is per-browser, but each tab called getOrCreateGuestId on its own logout,
  // so after a sign-out every open tab found `null` and minted a fresh identity.
  // Two tabs meant two guests for one person — and worse, the ids drifted apart,
  // so logging back in removed ONE row while the other tab's row survived and the
  // counter still read two.
  //
  // Keeping the id makes the row, not the key, the unit of a guest session: a
  // sign-in deletes the row and a later sign-out recreates the same one. That is
  // the same shape the member path uses after /presence/leave.
  useEffect(() => {
    if (!user?.uid) return;
    const guestId = localStorage.getItem('guest_id');
    if (!guestId) return;
    removeRtdbGuestPresence(guestId);
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

  // updateSettings saves `users.settings`, and returns the object the SERVER
  // ended up storing.
  //
  // The command is a wholesale replace (PUT /me/settings — deliberate, so a
  // partial body yields a partial state rather than an invisible merge). That
  // contract only holds if the client sends the WHOLE object, and the account
  // form does not: it enumerates theme, language, signature, notifications…
  // and knows nothing about the rest. So the body is merged over the settings
  // this profile actually holds, and the authoritative result is returned
  // rather than discarded — see updateProfile, where it used to be overwritten
  // again by the same partial object the form started from.
  const updateSettings = async (newSettings) => {
    if (!user) return null;
    const updated = { ...(profile?.settings || {}), ...newSettings };
    const res = await sendApi('/api/aerun/me/settings', {
      method: 'PUT',
      body: updated
    });
    const stored = res?.settings || updated;
    setProfile(prev => ({
      ...prev,
      settings: stored
    }));
    return stored;
  };

  // updateProfile saves the profile form.
  //
  // It used to merge everything into local state and call nothing for your own
  // account, so a changed status line, bio or nickname looked saved and vanished
  // on reload. Editing somebody ELSE went to the admin endpoint, which requires
  // admin_access and whose body only carries role and status — a moderator got a
  // 403 and an admin got a 200 that silently dropped every field.
  //
  // Each group now goes to the command that actually owns it:
  //
  //   nickname → its own command, because renaming is audited with the old AND
  //              new value and bounded by the rank matrix (a moderator may only
  //              rename strictly lower accounts). Sending it as a profile field
  //              would lose both the audit and the rank rule.
  //   profile  → /me/profile or /users/{id}/profile
  //   settings → the existing settings command, which REPLACES the object
  //
  // Sequential, not parallel: two PATCHes to the same row can interleave, and a
  // failure in the second must not leave the caller believing nothing saved.
  const updateProfile = async (newData, targetUid = null) => {
    if (!user) return;
    const finalUid = targetUid || user.uid;
    const isOwn = finalUid === user.uid;

    const { nickname, ...rest } = newData;
    const body = {};
    // Holds the settings object the server stored, so the optimistic merge below
    // can adopt it instead of the form's partial one.
    let savedSettings = null;
    for (const key of ['status_line', 'bio', 'location', 'birthday', 'occupation', 'interests', 'contacts']) {
      if (rest[key] !== undefined) body[key] = rest[key];
    }

    if (Object.keys(body).length > 0) {
      await sendApi(
        isOwn ? '/api/aerun/me/profile' : `/api/aerun/users/${finalUid}/profile`,
        { method: 'PATCH', body }
      );
    }

    if (nickname !== undefined && nickname !== null && String(nickname).trim() !== '') {
      await sendApi(
        isOwn ? '/api/aerun/me/nickname' : `/api/aerun/users/${finalUid}/nickname`,
        { method: 'PATCH', body: { nickname: String(nickname).trim() } }
      );
    }

    if (newData.settings && isOwn) {
      savedSettings = await updateSettings(newData.settings);
    }

    // Only AFTER the server confirmed, so a rejected save cannot leave the UI
    // showing a nickname the database does not hold.
    if (isOwn) {
      // `settings` is deliberately EXCLUDED from the optimistic merge below.
      // `newData.settings` is the account FORM's object — an enumeration of the
      // fields that form happens to know — and spreading it over `prev` threw
      // away the complete settings the server had just returned. Every key the
      // form does not mention (member_view_style, show_footer, …) vanished from
      // local state, so the NEXT save sent a body missing them, and because
      // PUT /me/settings replaces wholesale, the second save destroyed them on
      // the server too. That is the reported loss of account data.
      const { settings: _formSettings, ...rest } = newData;
      void _formSettings;
      setProfile(prev => ({
        ...prev,
        ...rest,
        ...(savedSettings ? { settings: savedSettings } : {}),
      }));
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

  // Re-read the forum whenever WHO is asking changes.
  //
  // This was a mount-only effect, so the forum state was frozen at whatever
  // identity happened to be signed in when the provider mounted. The symptoms
  // were all one bug with different faces: after logging out the stats panel
  // still named the members who had been online, and a category the previous
  // account could see stayed on the index — because /api/aerun/categories is
  // filtered by canViewCategory on the SERVER, and the guest was being handed
  // the admin's list.
  //
  // `force` is mandatory here rather than left to the cooldown: a role change or
  // a sign-out is precisely the moment a stale answer is wrong, and the cooldown
  // exists only to damp bursts of ordinary polling.
  //
  // Role is part of the key, not just the uid, because a role change alters the
  // answer without changing who is asking. The status is included for the same
  // reason: `pending` and `banned` narrow what the server will return, and
  // moderation can change either while the tab sits open.
  //
  // `updated` is deliberately NOT a dependency. It changes on every profile
  // keystroke-driven save, and re-reading the forum because a status line was
  // edited would be a request per save for a list that did not change.
  const identityKey = `${user?.uid || ''}|${profile?.role_id || ''}|${profile?.status || ''}`;

  useEffect(() => {
    refreshForumState(true);
  }, [identityKey, refreshForumState]);

  // Members leaving the online list are the OTHER half of the sign-out symptom,
  // and they arrive through a different channel: `activeUsers` is fed by the
  // presence snapshot, not by fetchSecuredMainPageData. Refreshing the forum
  // state does not touch it.
  //
  // The heartbeat stops the moment the session ends, so the previous account
  // stays in the panel for the presence TTL (~75s) — which is why the sign-out
  // screenshot still shows a signed-in member online. Dropping the cached list
  // immediately makes the panel agree with the navbar, which already shows the
  // guest state; the next snapshot repopulates it with whoever is actually
  // online, and by then the departed account is gone from that too.
  useEffect(() => {
    if (user?.uid) return;
    setActiveUsers([]);
  }, [user?.uid]);

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
