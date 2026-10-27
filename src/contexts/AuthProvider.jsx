/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { pb, sendApi } from '../api/pocketbase';
import LoadingPreloader from '../components/common/LoadingPreloader';
import {
  apiMarkAllTopicsRead,
  apiRecordAllTopicVisits,
  refreshUnreadTopics,
  subscribeToEffectivePermissions,
  subscribeToReadMap,
  recordTopicVisit as apiRecordTopicVisit,
  normalizeUserProfile,
  fetchUserProfile
} from '../api/auth-resources';
import {
  initRtdbPresence,
  setRtdbOnline,
  setRtdbOffline,
  subscribeToOnlineUsers,
  initRtdbGuestPresence,
  removeRtdbGuestPresence
} from '../api/rtdb-presence';
import { subscribeToUnreadCounts, refreshUnreadCounts } from '../api/dms';
import { subscribeToRealtimeSignals, canReceiveSignals } from '../api/realtime-signals';
import { fetchSecuredMainPageData, INHERIT_ROLES } from '../api/categories';
import { subscribeToRoles, getGlobalSettings } from '../api/admin';
import { CHIEF_ADMIN_ID, PERMISSIONS, DEFAULT_ROLES, normalizePermissions, isChiefAdmin } from '../constants/permissions';

const AuthContext = createContext();
const FORUM_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

export const useAuth = () => useContext(AuthContext);

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// confirmedProfilePatch is what a CONFIRMED profile save writes back into the
// auth store snapshot, and nothing else.
//
// WHY IT IS A FUNCTION AND WHY IT IS NARROW. The snapshot is what a reload
// replays, so a confirmed field missing here is a field that silently reverts;
// but a field present here that the server never confirmed is a field persisted
// as if it were stored state. `avatar_url` is exactly that case: the account form
// carries it, while the profile command does not accept it — the avatar has its
// own upload endpoint — so building the patch from the form would write a
// resolved URL over the stored file path.
//
// It is exported so a test can execute it: a regex can tell that a field name is
// mentioned, but only running it can tell that the confirmed fields are present
// AND the unconfirmed ones are absent.
export const confirmedProfilePatch = ({ body, nickname, savedSettings }) => {
  const patch = { ...(body || {}) };
  if (nickname) patch.nickname = nickname;
  if (savedSettings) patch.settings = savedSettings;
  return patch;
};

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
    topicsPerPage: 20,
    maxPostsPerTopic: 1000
  });
  const [loading, setLoading] = useState(true);
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [isPendingApproval, setIsPendingApproval] = useState(false);

  // canPostGlobally mirrors the backend's AccessContext.CanPostGlobally():
  // staff always pass; everyone else needs active status AND a confirmed email.
  const canPostGlobally = useMemo(() => {
    if (!profile) return false;
    const roleId = profile.role_id || 'player';
    const isStaffRole = roleId === 'root' || roleId === 'admin' || roleId === 'moderator';
    if (isStaffRole) return true;
    return profile.status === 'active' && profile.verified === true;
  }, [profile]);
  const [readMap, setReadMap] = useState({});
  const [readMapReady] = useState(true);
  const [categories, setCategories] = useState([]);
  const categoriesRef = useRef(categories);
  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);
  // The folders the index renders categories inside. They come from the SAME read
  // as the categories (forum-index), so the two can never disagree about which
  // group a category belongs to.
  const [categoryGroups, setCategoryGroups] = useState([]);
  const [forumStateLoading, setForumStateLoading] = useState(true);
  const [forumStateError, setForumStateError] = useState(null);
  const [forumStats, setForumStats] = useState(null);
  const [dailyActiveUsers, setDailyActiveUsers] = useState([]);
  // SERVER STATE, fed by the unread-counters subscription below.
  //
  // This was `const [unreadTopicsCount] = useState(0)` — destructured with no
  // setter, so it was permanently 0. Every consumer rendered accordingly and none
  // of them looked wrong: the navbar badge was absent, the tab title showed no
  // number, and the "mark all read" button on /new-replies was disabled forever
  // because its guard was `unreadTopicsCount === 0`. Three screens, one missing
  // setter, nothing red anywhere.
  const [unreadTopicsCount, setUnreadTopicsCount] = useState(0);
  // What the SERVER says this caller may do, straight from /me.
  //
  // It is deliberately NOT read out of `profile`. The profile is the caller's own
  // row, which carries the role; the effective permission set is that role narrowed
  // by account status, and only the command layer knows the narrowing. Keeping them
  // in one place is what lets `GET /roles` stop publishing the matrix.
  const [effectivePermissions, setEffectivePermissions] = useState([]);
  const [dmUnread, setDmUnread] = useState({ total: 0, conversations: {}, topics: 0 });
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

  // The caller's OWN profile: the shared normalizer plus the mailbox fallback.
  //
  // It is one function because two sources feed it — the auth store snapshot and
  // the row read from the server — and they must produce the same shape. A
  // profile that differed only by the fallback would re-seed the Settings form
  // on every single boot.
  const toOwnProfile = useCallback((rec) => ({
    ...normalizeUserProfile({ ...rec }),
    // Only the caller's OWN record falls back to the mailbox name and then to
    // a literal — the normalizer stays neutral about nicknames so a public
    // profile never renders one derived from an email address.
    nickname: rec.nickname || rec.email?.split('@')[0] || 'User'
  }), []);

  // Re-read the caller's row from the server, because the auth store is a
  // SNAPSHOT: PocketBase restores it from localStorage on every boot and nothing
  // refreshes it, while every profile command writes through /api/aerun. So the
  // app answered with whatever the row held at sign-in — rename yourself,
  // reload, and the Settings inputs are back to the old name.
  //
  // The snapshot still renders immediately (on a cold paint it is all there is);
  // this corrects it a moment later, and it is also what converges a profile
  // renamed somewhere else — another device, or an admin.
  // One refresh per account at a time.
  //
  // The auth store fires onChange more than once at boot (and again on the
  // write-back below), and the PocketBase SDK keeps a single in-flight request
  // per request key — a second `getOne` for the same record ABORTS the first.
  // Asking on every change therefore meant each ask cancelled the one before it,
  // and every cancellation surfaced as "own profile refresh failed" in the
  // console while the profile on screen was correct. A second caller now joins
  // the request already in flight instead of starting a rival one.
  const ownProfileRefreshRef = useRef({ uid: null, promise: null });

  const refreshOwnProfile = useCallback(async (uid) => {
    if (!uid) return;
    const pending = ownProfileRefreshRef.current;
    if (pending.promise && pending.uid === uid) return pending.promise;

    const promise = (async () => {
      try {
        const fresh = await fetchUserProfile(uid);
        // Signing out, or switching accounts, while this is in flight must not hand
        // the answer to a session that no longer exists. A cancelled duplicate
        // also lands here as null — that is the SDK working, not a failed read.
        if (!fresh || pb.authStore.record?.id !== uid) return;
        setUser(prev => (prev && prev.uid === uid
          ? {
              ...prev,
              displayName: fresh.nickname || prev.displayName,
              photoURL: fresh.avatar_url || prev.photoURL
            }
          : prev));
        setProfile({
          ...toOwnProfile(fresh),
          // `last_selected_character_id` is a private field the `/api/aerun/users/{id}`
          // profile DTO deliberately does not return, so a server profile refresh
          // must not wipe the mask the author chose. It survives in the auth store
          // snapshot (kept in step with the DB by `setLastSelectedMask`) and is the
          // value the reply/topic "Post as…" pickers read back on reload.
          last_selected_character_id: pb.authStore.record?.last_selected_character_id ?? ''
        });
      } catch (err) {
        // Everything that reaches here is a real failure: fetchUserProfile already
        // answers null for a cancellation. The snapshot is on screen regardless, so
        // this degrades to the older name and never to a blank header or a
        // signed-out member — but the diagnostic stays, because this is the only
        // place the app can learn that its own profile is drifting from the server.
        console.warn('[AuthProvider] own profile refresh failed:', err);
      }
    })().finally(() => {
      if (ownProfileRefreshRef.current.promise === promise) {
        ownProfileRefreshRef.current = { uid: null, promise: null };
      }
    });

    ownProfileRefreshRef.current = { uid, promise };
    return promise;
  }, [toOwnProfile]);

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
      setUser(u);
      setProfile(toOwnProfile(rec));
      setEmailUnverified(rec.verified === false);
      setIsPendingApproval(rec.status === 'pending');
      // …and the snapshot is corrected against the server, so nothing here is
      // read-only for the rest of the session.
      refreshOwnProfile(rec.id);
    } else {
      setUser(null);
      setProfile(null);
      setEmailUnverified(false);
      setIsPendingApproval(false);
    }
  }, [toOwnProfile, refreshOwnProfile]);

  useEffect(() => {
    // Restore a possibly-expired session before syncing identity. Without this,
    // a returning member's stale token makes `isValid` false, so no
    // Authorization header is sent and the backend answers /api/aerun/me as a
    // guest — heartbeats, notifications and the online list all break.
    const restoreSession = async () => {
      if (pb.authStore.record) {
        try {
          await pb.collection('users').authRefresh();
        } catch (refreshErr) {
          // Dead session: tokenKey rotated or account deleted. Never re-send a
          // stale token; clear so subsequent /me reads land as an honest guest.
          console.warn('[AuthProvider] session refresh failed; clearing stale store', refreshErr);
          pb.authStore.clear();
        }
      }
    };
    void restoreSession().then(syncUserFromAuthStore);

    const unsubAuth = pb.authStore.onChange(() => {
      syncUserFromAuthStore();
    });

    // Load global settings
    const unsubSettings = getGlobalSettings(data => {
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
      unsubSettings();
      unsubRoles();
      clearTimeout(timer);
    };
  }, [syncUserFromAuthStore]);

  // Effective permissions, for every visitor INCLUDING a signed-out one.
  //
  // The guest case is the point, not an afterthought: it is the half that let the
  // permission matrix stay public. `fetchUserProfile` needs a uid, so a guest never
  // had an answer of its own and the gate had to reach into the role registry for
  // one — which meant every caller, guest included, had to be told every role's
  // permissions. `/me` answers it for a guest too, so this subscription is what
  // makes the fallback in hasPermission unreachable in normal operation.
  useEffect(() => {
    const unsubscribe = subscribeToEffectivePermissions(user?.uid, setEffectivePermissions);
    return unsubscribe;
  }, [user?.uid]);

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
  //
  // ONLY ON THE TRANSITION, which is what this used to get wrong. Keyed on
  // `user?.uid` alone, the effect fires on the FIRST page load of an already
  // signed-in member too — authStore is restored synchronously on mount, so
  // `user.uid` is populated before the first effect run and there is no
  // guest→member transition to react to. That sent `POST /presence/guest/leave`
  // on every ordinary page view of the forum: a request announcing a departure
  // that never happened, which also stops the guest heartbeat that would have
  // kept a second tab of the same browser counted. The guard is the PREVIOUS
  // uid, so the effect runs only where the identity actually changed.
  const previousUidRef = useRef(undefined);
  useEffect(() => {
    const uid = user?.uid;
    const previousUid = previousUidRef.current;
    previousUidRef.current = uid;

    // First observation is a mount, not a transition: whatever the identity is,
    // it did not change under us.
    if (previousUid === undefined) return;

    if (!uid || uid === previousUid) return;
    const guestId = localStorage.getItem('guest_id');
    if (!guestId) return;
    removeRtdbGuestPresence(guestId);
  }, [user?.uid]);

  useEffect(() => {
    return subscribeToOnlineUsers(setActiveUsers);
  }, []);

    // ONE counters subscription feeds four pieces of state: the DM totals, the
    // per-conversation detail TitleProvider also wants, the unread-topic badge, and
    // the unread-notification badge.
  //
  // They arrive together because they are ONE request (`/me/unread-counts`), and
  // splitting them would mean either a second request for state the first response
  // already carried, or two subscribers to one resource — which is the same
  // duplicate this module was built to make impossible.
  useEffect(() => {
    if (!user?.uid) {
      setDmUnread({ total: 0, conversations: {}, topics: 0, notifications: 0 });
      setUnreadTopicsCount(0);
      return;
    }
    return subscribeToUnreadCounts(user.uid, (counts) => {
      setDmUnread(counts);
      setUnreadTopicsCount(counts.topics || 0);
    });
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

  const loginWithGoogle = useCallback(async () => {
    const authData = await pb.collection('users').authWithOAuth2({ provider: 'google' });
    const isRegistering = sessionStorage.getItem('is_registering') === 'true';
    const pendingNickname = sessionStorage.getItem('pending_nickname');
    if (isRegistering && pendingNickname && pendingNickname.trim()) {
      try {
        await sendApi('/api/aerun/me/nickname', {
          method: 'PATCH',
          body: { nickname: pendingNickname.trim() }
        });
        await pb.collection('users').authRefresh().catch(() => {});
      } catch (nickErr) {
        console.warn('[loginWithGoogle] could not apply pending nickname', nickErr);
      }
    }
    // One-time seed for a brand-new Google account (same contract as the
    // email path): the OAuth flow has no settings body, so the guest-side
    // theme/language snapshotted before the redirect are applied here — but
    // ONLY when the account holds neither key yet. A returning member's
    // stored choices are never touched.
    if (isRegistering) {
      try {
        await pb.collection('users').authRefresh().catch(() => {});
        const stored = pb.authStore.record?.settings || {};
        const seed = {};
        const pendingTheme = sessionStorage.getItem('pending_theme') || '';
        const pendingLang = sessionStorage.getItem('pending_language') || '';
        if (pendingTheme && stored.theme === undefined) seed.theme = pendingTheme;
        if (pendingLang && stored.language === undefined) seed.language = pendingLang;
        if (Object.keys(seed).length > 0) {
          try {
            await sendApi('/api/aerun/me/settings', {
              method: 'PUT',
              body: { ...stored, ...seed }
            });
          } catch (seedErr) {
            console.warn('[loginWithGoogle] could not seed settings', seedErr);
          }
          await pb.collection('users').authRefresh().catch(() => {});
        }
      } finally {
        sessionStorage.removeItem('pending_theme');
        sessionStorage.removeItem('pending_language');
      }
    }
    sessionStorage.removeItem('is_registering');
    sessionStorage.removeItem('pending_nickname');
    sessionStorage.removeItem('pending_message');
    // Clean up any previous guest presence when a new user logs in
    const guestId = localStorage.getItem('guest_id');
    if (guestId) {
      removeRtdbGuestPresence(guestId);
    }
    syncUserFromAuthStore();
    return authData;
  }, [syncUserFromAuthStore]);

  const registerWithEmail = useCallback(async (email, password, nickname = '', adminMessage = '', initialSettings = {}) => {
    const res = await sendApi('/api/aerun/auth/register', {
      method: 'POST',
      body: {
        email,
        password,
        nickname: nickname.trim() || email.split('@')[0],
        admin_message: adminMessage || '',
        // Guest-side seed: what the forum shows right now (theme/language).
        // Server whitelists both keys; anything else is ignored server-side.
        theme: initialSettings?.theme || '',
        language: initialSettings?.language || ''
      }
    });
    const authData = await pb.collection('users').authWithPassword(email, password);
    // Clean up any previous guest presence when a new user registers
    const guestId = localStorage.getItem('guest_id');
    if (guestId) {
      removeRtdbGuestPresence(guestId);
    }
    syncUserFromAuthStore();
    // Surface the server's mail verdict (mail_sent / mail_error) alongside the
    // auth payload, so the registration form can say "account created, but the
    // letter was not sent" instead of pretending.
    return { ...authData, mailSent: res?.mail_sent === true, mailError: res?.mail_error || '' };
  }, [syncUserFromAuthStore]);

  const loginWithEmail = useCallback(async (email, password) => {
    const authData = await pb.collection('users').authWithPassword(email, password);
    // Clean up any previous guest presence when a new user logs in
    const guestId = localStorage.getItem('guest_id');
    if (guestId) {
      removeRtdbGuestPresence(guestId);
    }
    syncUserFromAuthStore();
    return authData;
  }, [syncUserFromAuthStore]);

  const resetPassword = useCallback(async (email) => {
    return await pb.collection('users').requestPasswordReset(email);
  }, []);

  // Sends (or re-sends) the verification mail through the honest server command
  // POST /api/aerun/auth/resend-verification — NOT through PocketBase's native
  // request-verification endpoint, which answers 204 even when the mail stack
  // is off (the guard aborts the send after the status is decided), so a UI
  // built on it claims "sent" while nothing left the server. The command
  // answers mail_sent=true only after a real send, 503 when mail is disabled,
  // and {verified:true} when there is nothing left to send.
  const resendVerificationEmail = useCallback(async () => {
    const res = await sendApi('/api/aerun/auth/resend-verification', { method: 'POST', body: {} });
    if (res?.verified) {
      setEmailUnverified(false);
      return res;
    }
    if (res?.mail_sent !== true) {
      throw new Error(res?.mail_error || 'Email delivery is disabled on this server');
    }
    return res;
  }, []);

  // Re-reads the caller's verification flag: refresh the auth record (which
  // updates `verified` when the token link was already clicked), then correct
  // the unverified flag. Returns true when the account is now verified.
  const checkVerificationStatus = useCallback(async () => {
    try {
      const authData = await pb.collection('users').authRefresh();
      const verified = authData?.record?.verified !== false;
      setEmailUnverified(!verified);
      if (verified && authData?.record) {
        setProfile(toOwnProfile(authData.record));
        setIsPendingApproval(authData.record.status === 'pending');
      }
      return verified;
    } catch (err) {
      // A stale/expired session cannot be refreshed — re-sync from whatever
      // the store still holds rather than leaving the banner stuck.
      syncUserFromAuthStore();
      throw err;
    }
  }, [syncUserFromAuthStore, toOwnProfile]);

  const logout = useCallback(async (skipPresenceCleanup = false) => {
    const uid = user?.uid;
    if (uid && !skipPresenceCleanup) {
      await setRtdbOffline(uid, true);
    }
    // No cache to wipe here any more. The DM local cache existed so one member's
    // private messages could not be read by the next person to sign in on this
    // browser; with it gone, sign-out leaves nothing of the conversation behind.
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
  const updateSettings = useCallback(async (newSettings) => {
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
  }, [user, profile]);

  // THE BANNED-MEMBER EVICTION, RESTORED — F6.
  //
  // This effect existed on Firebase (commit e746c09) and was lost in the
  // PocketBase migration: nothing wrote `sessionStorage['banned_logout']`, so
  // `GlobalModals` — which has always READ the flag (GlobalModals.jsx:24-26) —
  // had nothing to raise. A banned member was evicted SILENTLY: `ProtectedRoute`
  // shadow-logged them to a guest for routing, every topic read answered 404
  // that read as "content missing", the forum shell came back empty after a
  // reload — and never once did the «Доступ заблокирован» modal appear. That is
  // a silent failure by `.agent/rules/AGENTS.md` §Zero Silent Failures.
  //
  // ONE BRANCH COVERS BOTH HALVES of the owner's ruling (2026-10-11), because
  // both arrive here identically — as a profile whose status reads 'banned':
  //   - banned MID-SESSION: `refreshOwnProfile` above re-reads the row from the
  //     server (a pb.authStore record is a sign-in snapshot), so the next
  //     identity read after an admin flips the status lands here;
  //   - banned AT SIGN-IN: the OAuth branch loads the profile right after the
  //     credentials resolve, so the member is evicted before the first page
  //     rather than after the first failed load.
  // `LoginPage.jsx:46-48` returns null waiting for exactly this — the comment
  // «AuthProvider will handle the forced logout shortly» describes behaviour
  // that had never actually been ported.
  //
  // NO ENDPOINT IS SPECIAL-CASED, and none may be: the server owes a banned
  // caller only the refusal (404 on topic reads, 403 on /me/votes — `auth_test.go`
  // already pins that it strips every permission). The CLIENT owes the member
  // the explanation, which is why this lives here and not in a route handler.
  // `ProtectedRoute` keeps its shadow-logout, but it is no longer the only line
  // of defence.
  //
  // The flag is written BEFORE the eviction and is NOT cleared on mount —
  // `GlobalModals` removes it only on hide, so it survives the redirect and the
  // page transitions in between until the member acknowledges the modal.
  //
  // `logout(true)` skips presence cleanup deliberately: a banned account has
  // already lost every permission, so setRtdbOffline would be a
  // permission-denied write whose only output is the error loop e746c09 also
  // had to dodge.
  //
  // No re-entrancy latch on purpose (the legacy effect had none either): logout
  // clears the auth store, `pb.authStore.onChange` hands that to
  // `resetAuthState`, and a null user/profile returns above before the flag can
  // be written twice.
  useEffect(() => {
    if (!user || !profile || loading) return;
    if (profile.status !== 'banned') return;
    sessionStorage.setItem('banned_logout', 'true');
    logout(true);
  }, [user, profile, loading, logout]);

  // THE DELETED-MEMBER EVICTION.
  //
  // A soft-deleted account is out of circulation, and the server enforces that
  // hard: the delete rotates the account's tokenKey, so every token it holds
  // stops verifying, and a group-level gate refuses every mutating request
  // with 403. What the server CANNOT do is clear the browser's copy of the
  // session.
  //
  // Without this the member sits on a forum that silently refuses everything:
  // the shell renders, the lists come back empty, the composer 403s on submit,
  // and nothing says why. That is the "silent failure" AGENTS.md forbids, and
  // it is exactly the failure the BAN path above already learned to avoid.
  //
  // The flag is written BEFORE the eviction and is NOT cleared on mount (the
  // modal removes it on hide), so the explanation survives the redirect and
  // the page transitions in between.
  //
  // `logout(true)` skips the presence cleanup: the account has lost every
  // permission, so the offline write would be a permission-denied request
  // whose only output is an error loop.
  useEffect(() => {
    if (!user || !profile || loading) return;
    if (profile.status !== 'deleted') return;
    sessionStorage.setItem('deleted_logout', 'true');
    logout(true);
  }, [user, profile, loading, logout]);

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
  const updateProfile = useCallback(async (newData, targetUid = null) => {
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
    //
    // THE NICKNAME IS PART OF THIS MERGE, and its absence was the reported bug.
    // It is destructured out above only to route it to its own audited command;
    // nobody put it back, so every save left `profile.nickname` at its old value
    // while the database moved on. ProfilePage seeds its form from `profile`, so
    // re-opening your own Settings tab showed the nickname you had just replaced.
    // `displayName` travels with it because normalizeUserProfile publishes both and
    // the form reads `nickname || displayName`.
    //
    // The merged object is RETURNED so the caller can re-seed its form from what
    // the server confirmed rather than from what was typed — the two differ
    // whenever the server normalises a value, and the form must show the former.
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
      const merged = {
        ...profile,
        ...rest,
        ...(nickname ? { nickname, displayName: nickname } : {}),
        ...(savedSettings ? { settings: savedSettings } : {}),
      };

      // Merge into React state fixes THIS TAB. The auth store is what a reload
      // replays — PocketBase restores it from localStorage, and no profile
      // command writes through PocketBase — so a merged-but-unpersisted profile
      // comes back old on the next F5. That was the reported "saved, reloaded,
      // the inputs are the previous values" bug: the card reads the row live
      // through subscribeToUser and showed the new name, the form is seeded from
      // `profile` and showed the old one.
      //
      // setLastSelectedMask already writes back for exactly this reason; a saved
      // profile has to do the same, and with the same discipline — only what the
      // server CONFIRMED, which is why the patch is built from `body`, the
      // nickname and the returned settings rather than from the form object.
      const record = pb.authStore.record;
      if (record) {
        const nextRecord = { ...record, ...confirmedProfilePatch({ body, nickname, savedSettings }) };
        const changed = Object.keys(nextRecord)
          .some(key => JSON.stringify(nextRecord[key]) !== JSON.stringify(record[key]));
        if (changed) {
          // Also fires the store's change callbacks, so `profile` is rebuilt from
          // the record that was actually just written.
          pb.authStore.save(pb.authStore.token, nextRecord);
        }
      }

      setProfile(merged);
      return merged;
    }
    // Somebody else's account: the caller's form is re-seeded from `viewedProfile`,
    // which subscribeToUser refreshes, so there is nothing to hand back here.
    return null;
  }, [user, profile, updateSettings]);

  // setLastSelectedMask records which mask the author is posting as.
  //
  // WHY THIS EXISTS SEPARATELY. The picker used to call
  // `updateUser(uid, { last_selected_character_id })` from api/forum.js, which
  // PATCHes /me/profile correctly — and then nothing else. The value the picker
  // READS back is `profile.last_selected_character_id`, and `profile` is built
  // from `pb.authStore.record`, which that raw fetch never touches. So the write
  // landed in the database while the read kept answering with whatever was in
  // the auth store at SIGN-IN time: the picker offered a mask the author had not
  // chosen in weeks, and a full page reload did not help, because PocketBase
  // restores the auth store from localStorage and nothing had ever refreshed it.
  //
  // The optimistic merge alone would only paper over the current tab; writing
  // the record back through authStore.save() is what makes it survive a reload,
  // and it fires the store's change callbacks, so `profile` is rebuilt from the
  // record that was actually just written.
  //
  // The server response is authoritative: on a successful save the picker
  // re-renders from the profile the server holds, so a rejected write cannot
  // leave the toggle naming a mask the database never accepted.
  const setLastSelectedMask = useCallback(async (characterId) => {
    if (!user?.uid) return;
    const id = characterId || '';
    await sendApi('/api/aerun/me/profile', {
      method: 'PATCH',
      body: { last_selected_character_id: id }
    });
    // Saved only AFTER the server confirmed, for the same reason updateProfile
    // merges late: a refused write must not leave the picker showing a mask the
    // database does not hold.
    const record = pb.authStore.record;
    if (record && record.last_selected_character_id !== id) {
      pb.authStore.save(pb.authStore.token, { ...record, last_selected_character_id: id });
    }
  }, [user?.uid]);

  // ONE refresh in flight at a time, with at most ONE queued behind it.
  //
  // There was no guard here at all, so two callers could read the forum at once
  // and whichever RESPONDED LAST won — not whichever asked first. That is a
  // correctness bug, not a cost one: a mutation's refresh (scheduled 1.5s after a
  // post) racing an identity-change refresh, with the slower response carrying
  // counters computed before the post, would repaint the index with the older
  // numbers after the newer ones had already landed.
  //
  // Joining the in-flight read instead of starting a second would be wrong for the
  // mutation case — it would return the answer fetched BEFORE the write, which is
  // precisely the stale answer above. So a request arriving mid-flight QUEUES, and
  // runs once the current read settles. Two callers still cost two reads, but they
  // cost two SEQUENTIAL reads, and the last one is the one that sticks.
  //
  // This is the same shape shared-poll already uses for the same reason, and it is
  // also why the dev network log shows these requests twice: React StrictMode
  // double-invokes mount effects, and this effect has no cleanup, so it fires
  // twice on load. That doubling is a development artifact, not a second
  // independent source — do not "fix" it by removing the effect.
  const forumRefreshInFlightRef = useRef(false);
  const forumRefreshQueuedRef = useRef(false);

  const refreshForumState = useCallback(async (force = false, showLoading = false) => {
    const now = Date.now();
    if (!force && now - lastForumRefreshTimeRef.current < FORUM_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastForumRefreshTimeRef.current = now;

    if (forumRefreshInFlightRef.current) {
      forumRefreshQueuedRef.current = true;
      return;
    }
    forumRefreshInFlightRef.current = true;

    // Only display full-page skeleton if requested or if initial categories are not loaded yet.
    // Background polling / realtime signal refreshes must never flash skeletons.
    const shouldShowLoading = showLoading || (!categoriesRef.current || categoriesRef.current.length === 0);
    if (shouldShowLoading) {
      setForumStateLoading(true);
    }
    setForumStateError(null);

    try {
      do {
        forumRefreshQueuedRef.current = false;
        const data = await fetchSecuredMainPageData();
        if (data?.categories) setCategories(data.categories);
        if (data?.categoryGroups) setCategoryGroups(data.categoryGroups);
        if (data?.stats) setForumStats(data.stats);
        if (data?.dailyActiveUsers) setDailyActiveUsers(data.dailyActiveUsers);
      } while (forumRefreshQueuedRef.current);
    } catch (err) {
      console.warn('[refreshForumState err]', err);
      setForumStateError(err);
    } finally {
      forumRefreshInFlightRef.current = false;
      if (shouldShowLoading) {
        setForumStateLoading(false);
      }
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

  // Realtime updates for forum state (categories, last posts, counters, stats).
  //
  // When another member posts in a topic, the backend emits `realtimeSignalTopicPost`
  // ("topic.post") through `realtime_signals`.
  //
  // To avoid spamming network reads during active multi-topic conversations,
  // incoming signals coalesce with a 3.5s trailing debounce and an 8s max-wait cap.
  // Inactive (hidden) tabs do not poll or fetch; they perform a single quiet
  // refresh on return.
  const forumDebounceTimerRef = useRef(null);
  const forumMaxWaitTimerRef = useRef(null);
  const needsForumRefreshOnVisibleRef = useRef(false);

  useEffect(() => {
    const triggerDebouncedForumRefresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        needsForumRefreshOnVisibleRef.current = true;
        return;
      }

      if (!forumMaxWaitTimerRef.current) {
        forumMaxWaitTimerRef.current = setTimeout(() => {
          if (forumDebounceTimerRef.current) {
            clearTimeout(forumDebounceTimerRef.current);
            forumDebounceTimerRef.current = null;
          }
          forumMaxWaitTimerRef.current = null;
          refreshForumState(true, false);
        }, 8000);
      }

      if (forumDebounceTimerRef.current) {
        clearTimeout(forumDebounceTimerRef.current);
      }
      forumDebounceTimerRef.current = setTimeout(() => {
        if (forumMaxWaitTimerRef.current) {
          clearTimeout(forumMaxWaitTimerRef.current);
          forumMaxWaitTimerRef.current = null;
        }
        forumDebounceTimerRef.current = null;
        refreshForumState(true, false);
      }, 3500);
    };

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && needsForumRefreshOnVisibleRef.current) {
        needsForumRefreshOnVisibleRef.current = false;
        refreshForumState(true, false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    let pollInterval = null;
    const startFallbackPolling = () => {
      if (pollInterval) return;
      pollInterval = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return;
        }
        refreshForumState(true, false);
      }, 60000);
    };

    const stopFallbackPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };

    let unsubRealtime = null;
    if (canReceiveSignals()) {
      unsubRealtime = subscribeToRealtimeSignals(
        (topic) => {
          if (topic === 'topic.post') {
            triggerDebouncedForumRefresh();
          }
        },
        () => {
          startFallbackPolling();
        },
        (connected) => {
          if (connected) {
            stopFallbackPolling();
          } else {
            startFallbackPolling();
          }
        }
      );
    } else {
      startFallbackPolling();
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (forumDebounceTimerRef.current) {
        clearTimeout(forumDebounceTimerRef.current);
        forumDebounceTimerRef.current = null;
      }
      if (forumMaxWaitTimerRef.current) {
        clearTimeout(forumMaxWaitTimerRef.current);
        forumMaxWaitTimerRef.current = null;
      }
      stopFallbackPolling();
      unsubRealtime?.();
    };
  }, [user?.uid, refreshForumState]);

  const applyForumState = useCallback((data) => {
    if (!data) return;
    if (Array.isArray(data.categories)) setCategories(data.categories);
    if (Array.isArray(data.categoryGroups)) setCategoryGroups(data.categoryGroups);
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

  const markTopicRead = useCallback(async (topicId, offset = null, lastVisiblePostId = null) => {
    if (!user?.uid || !topicId) return;
    const now = Date.now();
    setReadMap(prev => ({ ...prev, [topicId]: now }));
    setCategories(prev => (Array.isArray(prev) ? prev.map(c => (
      c.last_post_topic_id === topicId ? { ...c, unread: false } : c
    )) : prev));
    await apiRecordTopicVisit(user.uid, topicId, offset, lastVisiblePostId);
    // The server state already moved, but the navbar badge, the tab title and
    // the /new-replies tab render the last POLLED values (15s / 20s ticks).
    // Without an explicit re-read they stay stale — the exact "clears itself
    // after a while" from the report. Best effort: a missed refresh only
    // delays the badge to the next tick.
    refreshUnreadCounts(user.uid);
    refreshUnreadTopics();
  }, [user?.uid]);

  // markAllRead sends the ids to the server, which owns the read state now.
  //
  // It used to write the localStorage map over `latestTopicsRef` — the top fifty
  // topics, regardless of whether this member could read them — so "mark
  // everything read" silently meant "mark the fifty newest read", and the badge,
  // which counted a different set, came straight back on the next poll.
  //
  // The caller passes the ids it is actually showing, which is why the signature
  // takes a list: the server can only mark what it is told, and refusing an id in
  // a category the caller may not read is a deliberate 403 there rather than a
  // quiet skip.
  // `_topicIds` is accepted but ignored: the caller (NewRepliesPage) still passes
  // `unreadTopics.map(t => t.id)`, which the read-contract script asserts on the
  // call site, but the server no longer trusts a client snapshot. See below.
  const markAllRead = useCallback(async (_topicIds = []) => {
    if (!user?.uid || isMarkingAllRead) return;

    setIsMarkingAllRead(true);
    try {
      // The server resolves the set itself (`all:true`) from the same predicate
      // that drives the feed and the counter, and echoes back the FULL list of
      // ids it marked. The page's ids are no longer sent: a client snapshot can
      // only ever be a partial, polled view, which is exactly how "mark all
      // read" left real unread topics — and their lit row indicators — behind.
      // The server's answer is what moves the state.
      const res = await apiMarkAllTopicsRead(user.uid);
      const ids = Array.isArray(res?.ids) ? res.ids.filter(Boolean) : [];

      // The local map still drives the page's own "unread" rendering, so it has to
      // move too — a server-only write would leave the rows the member just marked
      // still highlighted until the next full reload. It moves on the SERVER's
      // full set, so rows that were never on screen (page two, or posted after the
      // last poll) go dark here as well, matching the badge and the feed.
      const now = Date.now();
      setReadMap(prev => {
        const next = { ...prev };
        ids.forEach(id => { next[id] = now; });
        return next;
      });
      setCategories(prev => (Array.isArray(prev) ? prev.map(c => ({ ...c, unread: false })) : prev));
      apiRecordAllTopicVisits(user.uid, ids);
      // Same staleness as the single read above: the badge counts the whole
      // board server-side, so re-read it instead of waiting for the next tick.
      refreshUnreadCounts(user.uid);
      refreshUnreadTopics();
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [user?.uid, isMarkingAllRead]);

  // Permission checks.
  //
  // THE ANSWER COMES FROM /me, NOT FROM THE ROLE REGISTRY.
  //
  // It used to resolve the caller's role in `roles` and read that role's
  // permission list — which is why GET /roles had to publish the full matrix to
  // everyone, guest included. Two consequences, both bad: the browser had a
  // second, independent copy of an authorization decision the server had already
  // made, and any drift between the two showed up as a button the server would
  // have refused anyway. Worse, the local copy is derived from the ROLE column
  // rather than from the effective set, so it ignored exactly the narrowing the
  // server applies for account status — a pending or banned account rendered
  // with the full chrome of its role.
  //
  // `/me` answers the same question with the answer the server would act on:
  // `profilePayload` sends `permissions: auth.PermissionValues(acc.Permissions)`,
  // where `acc` is already narrowed by role AND status. So this gate is now the
  // same fact the command layer enforces, not a re-derivation of it.
  //
  // WHAT THIS DOES NOT CHANGE: a client-side gate is still only what to RENDER.
  // Hiding a control is not refusing an action, and every write goes through a
  // command that re-checks. The difference is that the two can no longer
  // disagree.
  //
  // The registry fallback is kept deliberately, for the window before the first
  // `/me` answer lands — failing closed would blank the forum for every signed-out
  // visitor on every load. With subscribeToEffectivePermissions mounted it is a
  // genuine edge case rather than the normal path, which is what makes it safe to
  // trim the matrix out of GET /roles.
  const hasPermission = useCallback((perm, { category } = {}) => {
    // The unverified-write-rights architecture (plan PLAN_UNVERIFIED_WRITE_RIGHTS_2026-10-21):
    // an account that cannot post globally (pending or unverified, non-staff)
    // may write ONLY where the category explicitly opens its override to `guest`.
    if (!canPostGlobally && category && (perm === PERMISSIONS.CREATE_TOPIC || perm === PERMISSIONS.POST_REPLY)) {
      const catId = typeof category === 'string' ? category : category?.id;
      if (catId) {
        const cat = categories.find(c => c.id === catId);
        const override = cat?.permissions?.[perm];
        if (Array.isArray(override) && override.includes('guest')) {
          return true;
        }
        return false;
      }
      return false;
    }

    // A category-level override can GRANT an action to a role that lacks it
    // globally: an admin enables posting in a specific category without
    // enabling it board-wide for the role. Without this, enabling a role's
    // right would force turning it off in every category individually — bad
    // UX. An absent override or the inherit marker means "follow the global
    // role setting"; root bypasses entirely.
    //
    // view_forum is excluded: the server already filters categories through
    // canViewCategory before they reach the client, so a client-side category
    // check for view_forum is redundant and can wrongly hide categories whose
    // permissions map lacks the key (e.g. empty categories). If the category
    // is in our list, the server already approved it — trust the server and
    // return true without any client-side right lookup.
    if (perm === PERMISSIONS.VIEW_FORUM && category) {
      return true;
    }
    if (category) {
      const catId = typeof category === 'string' ? category : category?.id;
      if (catId) {
        const cat = categories.find(c => c.id === catId);
        const override = cat?.permissions?.[perm];
        if (
          override !== undefined &&
          override !== null &&
          Array.isArray(override) &&
          !override.includes(INHERIT_ROLES)
        ) {
          // Explicit category role list: membership grants, non-membership
          // denies, even when the global right differs. An empty list is
          // root-only.
          const effectiveRoleId = user ? profile?.role_id || 'player' : 'guest';
          const isRoot = effectiveRoleId === 'root' || effectiveRoleId === CHIEF_ADMIN_ID;
          if (isRoot) return true; // root bypasses any explicit category override
          if (override.length === 0) {
            return isRoot; // root-only override
          }
          return override.includes(effectiveRoleId);
        }
        // No override or inherit marker → fall through to the global check.
      }
    }

    if (effectivePermissions.length > 0) {
      return effectivePermissions.includes(perm);
    }

    if (!user) {
      const guestRole = roles.find(r => r.id === 'spectator') || DEFAULT_ROLES.find(r => r.id === 'spectator');
      return !!normalizePermissions(guestRole?.permissions).includes(perm);
    }

    const effectiveRoleId = profile?.role_id || 'player';
    if (effectiveRoleId === 'root' || effectiveRoleId === CHIEF_ADMIN_ID) return true;

    const userRole = roles.find(r => r.id === effectiveRoleId) || DEFAULT_ROLES.find(r => r.id === effectiveRoleId);
    return !!normalizePermissions(userRole?.permissions).includes(perm);
  }, [user, profile, roles, effectivePermissions, categories, canPostGlobally]);

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
    categories,
    categoryGroups,
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
    isPendingApproval,
    canPostGlobally,
    logout,
    updateSettings,
    updateProfile,
    setLastSelectedMask,
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
    user, profile, authError, isRootAdmin, settings, loading, readMap, readMapReady, categories, categoryGroups, forumStateLoading, forumStateError,
    unreadTopicsCount, dmUnread, activeDmConvId, setActiveDmConvId, isMarkingAllRead, markTopicRead, markAllRead,
    loginWithGoogle, registerWithEmail, loginWithEmail, resetPassword,
    resendVerificationEmail, checkVerificationStatus, emailUnverified, isPendingApproval, canPostGlobally, logout,
    updateSettings, updateProfile, setLastSelectedMask, recordActivity, refreshForumState, scheduleForumStateRefresh, applyForumState, forumStats,
    dailyActiveUsers, updateLocalTopicLastPost, updateLocalTopicPostsCount, hasPermission, roles, activeUsers,
    activeUserIds, isUserOnline
  ]);

  return (
    <AuthContext.Provider value={value}>
      {loading ? <LoadingPreloader /> : children}
    </AuthContext.Provider>
  );
};
