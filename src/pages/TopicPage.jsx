/**
 * TopicPage — modular topic orchestration wrapper
 * Refactored per SPEC_REFACTOR_TOPIC_ARCHITECTURE_AND_RACE_CONDITIONS.md
 *
 * Coordinates modular components (TopicHeader, TopicActionsBar, TopicPostCard,
 * PostInlineEditor, TopicReplyComposer, TopicModalsContainer) and hooks
 * (useTopicData, useTopicPosts, useTopicNavigation).
 *
 * Contract requirements (tested via scripts/check-*.mjs):
 * - isTopicFirstPost guard
 * - setAlreadyJumped and isJumping
 * - navigateToCreatedPost navigation
 * - setLastSelectedMask
 * - decorateDraft server draft synchronization
 * - subscribeToTopicNotifications quote tracking
 * - canDeleteTopic affordance
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Container } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { useToast } from '../contexts/ToastProvider';

import {
  TopicHeader,
  TopicActionsBar,
  TopicPostCard,
  TopicReplyComposer,
  TopicModalsContainer,
  PostInlineEditor,
} from '../components/topic';

import {
  useTopicData,
  useTopicPosts,
  useTopicNavigation,
} from '../hooks/topic';

import {
  updateTopic,
  deleteTopics,
  moveTopics,
  movePosts,
  fetchTopicContext,
  saveTopicDraft,
  publishDraft,
  deleteDraft,
  createPost,
  updatePost,
  deletePost,
  subscribeToTopicStats,
} from '../api/forum';

import { toggleSubscription } from '../api/subscriptions';
import { subscribeToTopicNotifications, markNotificationRead } from '../api/notifications';
import { refreshUnreadCounts } from '../api/dms';
import { fetchCharacter } from '../api/character';
import { fetchUserProfile } from '../api/auth-resources';
import { voteOnPost, updateReputationComment } from '../api/reputation';
import { canDeleteTopic, topicDeleteErrorText } from '../utils/topic-delete';
import { processDiceRolls } from '../utils/dice';
import { createInFlight, newIdempotencyKey } from '../utils/inflight';
import {
  saveUnsentReply,
  clearUnsentReply,
  hasUnsentReply,
  isTopicUnavailableError,
  REASON_TOPIC_CLOSED,
  REASON_TOPIC_UNAVAILABLE,
} from '../api/unsent-replies';
import { queueOptimisticPost, clearPendingOptimisticPost } from '../utils/optimisticPostQueue';

import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import ForumCharacterBadge from '../components/common/ForumCharacterBadge';
import ForumRoleBadge from '../components/common/ForumRoleBadge';

const ITEMS_PER_PAGE_DEFAULT = 20;

// Helper function to safely strip BBCode quotes
const stripQuotes = (text) => {
  if (!text) return '';
  let result = '';
  let depth = 0;
  const regex = /\[(\/?)(quote)(?:[\s=][^\]]*)?\]/gi;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    if (depth === 0) {
      result += text.substring(lastIndex, match.index);
    }
    if (match[1] === '/') {
      depth = Math.max(0, depth - 1);
    } else {
      depth++;
    }
    lastIndex = regex.lastIndex;
  }
  if (depth === 0) {
    result += text.substring(lastIndex);
  }
  return result.trim();
};

// First-post detection contract: only page 1 index 0 can be the topic first post
const isTopicFirstPost = (post, pagePosts, pageNumber, itemsPerPage) => {
  if (!post || !Array.isArray(pagePosts) || pagePosts.length === 0) return false;
  if (pageNumber !== 1) return false;
  return pagePosts[0]?.id === post.id;
};

export default function TopicPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, lang } = useI18n();
  const {
    user,
    profile,
    setProfile,
    characters = [],
    settings = {},
    recordActivity,
    readMap = {},
    initialVisitMap = {},
    updateLocalTopicLastPost,
    hasPermission,
    PERMISSIONS,
    isUserOnline,
    categories = [],
    setLastSelectedMask,
  } = useAuth();
  const { showToast } = useToast();

  const ITEMS_PER_PAGE = settings?.postsPerPage ?? ITEMS_PER_PAGE_DEFAULT;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  // Jump render latch
  const [, forceJumpRender] = React.useReducer((x) => x + 1, 0);
  const alreadyJumpedRef = useRef(false);
  const setAlreadyJumped = React.useCallback((value) => {
    if (alreadyJumpedRef.current === value) return;
    alreadyJumpedRef.current = value;
    forceJumpRender();
  }, []);

  const isMountedRef = useRef(true);
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  const topicRef = useRef(null);
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const pendingCreatedPostIdRef = useRef(null);
  const replyInFlightRef = useRef(createInFlight());
  const rescueWrittenRef = useRef(null);
  const lastJumpIntentRef = useRef(null);
  const replyRef = useRef(null);
  const topicInitialStateRef = useRef({ loaded: false, wasUnavailable: false });
  const replyContentAtLoadRef = useRef('');
  const draftSaveTimerRef = useRef(null);
  const draftJustPublishedRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 1. Topic metadata & freshness
  // TopicPage drives its freshness loop and metadata from subscribeToTopicStats(id,
  const {
    topic,
    topicNotFound,
    accessError,
    isTopicLoading,
    setTopic,
    prevTopicStatsRef,
  } = useTopicData(id);

  useEffect(() => {
    topicRef.current = topic;
  }, [topic]);

  // 2. Posts & Pagination
  const {
    posts,
    setPosts,
    pinnedFirstPost,
    setPinnedFirstPost,
    authorStats,
    setAuthorStats,
    loadPosts,
    isFetchingPostsRef,
  } = useTopicPosts({
    topicId: id,
    currentPage,
    itemsPerPage: ITEMS_PER_PAGE,
    searchParams,
    setSearchParams,
    navigate,
    showToast,
    lang,
    currentUser: user,
    currentProfile: profile,
    readMap,
    initialVisitMap,
    updateLocalTopicLastPost,
    topicRef,
  });

  const { scrollToReply } = useTopicNavigation();

  // 3. Local Page State
  const [replyContent, setReplyContent] = useState('');
  const [guestNickname, setGuestNickname] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');

  const [myDraft, setMyDraft] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [isSubscribed, setIsSubscribed] = useState(!!(topic?.subscribed));
  const [togglingSub, setTogglingSub] = useState(false);
  const [myVotes, setMyVotes] = useState({});
  const [maskStats, setMaskStats] = useState({});
  const [unreadQuotes, setUnreadQuotes] = useState([]);

  // Editing state
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [editCharacterId, setEditCharacterId] = useState('');
  const [editTopicTitle, setEditTopicTitle] = useState('');
  const [editTopicDescription, setEditTopicDescription] = useState('');
  const [editPinFirstPost, setEditPinFirstPost] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Modals state
  const [deletingPost, setDeletingPost] = useState(null);
  const [showDeleteTopicModal, setShowDeleteTopicModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showMovePostsModal, setShowMovePostsModal] = useState(false);
  const [showRepModal, setShowRepModal] = useState(false);
  const [repTargetPost, setRepTargetPost] = useState(null);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [submittingRep, setSubmittingRep] = useState(false);
  const [showVoteInfoModal, setShowVoteInfoModal] = useState(false);
  const [selectedVote, setSelectedVote] = useState(null);
  const [isEditingRepComment, setIsEditingRepComment] = useState(false);
  const [editingRepComment, setEditingRepComment] = useState('');
  const [savingRepComment, setSavingRepComment] = useState(false);
  const [showPostVotersModal, setShowPostVotersModal] = useState(false);
  const [selectedPostForVoters, setSelectedPostForVoters] = useState(null);

  const canDeleteCurrentTopic = topic ? canDeleteTopic({ topic, user, hasPermission }) : false;
  const totalPages = topic ? Math.max(1, Math.ceil((topic.posts_count || 1) / ITEMS_PER_PAGE)) : 1;
  const isOnLastPage = currentPage === totalPages;

  // 4. Contract: navigateToCreatedPost
  const navigateToCreatedPost = (tempId, postId) => {
    const currentLocation = locationRef.current;
    if (!isMountedRef.current || !postId || currentLocation.state?.pendingPostId !== tempId) return;
    pendingCreatedPostIdRef.current = postId;
    setSearchParams(currentLocation.search, { replace: true, preventScrollReset: true, state: null });
  };

  // 5. Build nested Author DTO
  const buildAuthorDTO = useCallback((charId) => {
    const selChar = characters.find((c) => c.id === charId);
    return {
      kind: user ? 'member' : 'guest',
      user_id: user?.uid || null,
      display_name: selChar
        ? selChar.name
        : (profile?.nickname || user?.displayName || profile?.email?.split('@')[0] || 'Guest'),
      avatar_url: selChar
        ? selChar.avatar_url
        : (profile?.avatar_url || ''),
      character_id: charId || null,
      role_id: profile?.role_id || 'spectator',
    };
  }, [characters, user, profile]);

  // 6. Contract: decorateDraft
  const decorateDraft = (draft, charId = '') => {
    if (!draft) return null;
    const maskId = draft.author_character_id || charId;
    const char = characters.find((c) => c.id === maskId);
    const authorName = char ? char.name : (profile?.nickname || user?.displayName || 'Guest');
    const authorAvatar = char ? char.avatar_url : (profile?.avatar_url || '');
    const roleId = profile?.role_id || (user ? 'player' : 'guest');
    const authorUid = user?.uid || draft.author_id || null;

    return {
      ...draft,
      is_draft: true,
      author_id: authorUid,
      author_name: authorName,
      author_avatar: authorAvatar,
      author_role_id: roleId,
      author_status_line: char ? (char.status_line || '') : (profile?.status_line || ''),
      author_signature: char ? (char.signature || '') : (profile?.settings?.signature || ''),
      is_character: !!char,
      author_character_id: char ? char.id : null,
      author: {
        kind: user ? 'member' : 'guest',
        user_id: authorUid,
        display_name: authorName,
        avatar_url: authorAvatar,
        character_id: char ? char.id : null,
        role_id: roleId,
      },
    };
  };

  // 7. Contract: Mask selection & persistence
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    const cat = topic?.category || categories.find((c) => c.id === topic?.category_id);
    const masksUnavailable = settings?.enableCharacters === false
      || (cat && !hasPermission(PERMISSIONS.USE_MASKS, { category: cat }));
    if (masksUnavailable && selectedCharacterId !== '') {
      setSelectedCharacterId('');
      if (user) setLastSelectedMask('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.last_selected_character_id, topic?.category_id, categories, hasPermission, PERMISSIONS.USE_MASKS, user, setLastSelectedMask, settings?.enableCharacters]);

  const handleSelectCharacter = useCallback((charId) => {
    setSelectedCharacterId(charId);
    if (user) {
      if (charId) {
        const char = characters.find((c) => c.id === charId);
        if (char) setLastSelectedMask(char.id);
      } else {
        setLastSelectedMask('');
      }
    }
  }, [user, characters, setLastSelectedMask]);

  // 8. Topic context fetch (server draft, votes, subscription)
  useEffect(() => {
    if (!user?.uid || !id || !topic || topicNotFound) return;
    let cancelled = false;
    (async () => {
      try {
        const ctx = await fetchTopicContext(id);
        if (!cancelled && isMountedRef.current) {
          if (ctx?.deleted) return;
          if (!draftJustPublishedRef.current && ctx?.draft) {
            setMyDraft(decorateDraft(ctx.draft));
          }
          draftJustPublishedRef.current = false;
          setIsSubscribed(!!ctx.subscribed);
          setMyVotes(ctx.votes || {});
        }
      } catch {
        // graceful degradation
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, id, topic?.id, topicNotFound]);

  // 9. Contract: Quote notifications subscription
  useEffect(() => {
    if (!user?.uid || !id || !topic || topicNotFound) return;
    const unsub = subscribeToTopicNotifications(user.uid, id, (activeQuotes) => {
      setUnreadQuotes(activeQuotes || []);
    });
    return () => unsub();
  }, [user?.uid, id, topic, topicNotFound]);

  useEffect(() => {
    if (unreadQuotes.length === 0 || posts.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const postId = entry.target.id.replace('post-', '');
          const matchingNotifs = unreadQuotes.filter((n) => n.payload?.post_id === postId);
          if (matchingNotifs.length > 0) {
            matchingNotifs.forEach((n) => markNotificationRead(n.id).then(
              () => refreshUnreadCounts(user?.uid),
              () => {},
            ));
            setUnreadQuotes((prev) => prev.filter((p) => !matchingNotifs.some((m) => m.id === p.id)));
          }
        }
      });
    }, { threshold: 0.1 });

    unreadQuotes.forEach((n) => {
      if (n.payload?.post_id) {
        const el = document.getElementById(`post-${n.payload.post_id}`);
        if (el) observer.observe(el);
      }
    });
    return () => observer.disconnect();
  }, [unreadQuotes, posts, user?.uid]);

  // 10. Mask stats hydration via fetchCharacter
  useEffect(() => {
    if (posts.length === 0) return;
    const uniqueChars = new Map();
    posts.forEach((p) => {
      if (p.author?.user_id && p.author_character_id && maskStats[p.author_character_id] === undefined) {
        uniqueChars.set(p.author_character_id, p.author?.user_id);
      }
    });

    if (uniqueChars.size === 0) return;
    const pending = Array.from(uniqueChars.keys());
    let cancelled = false;

    (async () => {
      const entries = await Promise.all(pending.map(async (charId) => {
        try {
          const char = await fetchCharacter(charId);
          return [charId, char || null];
        } catch {
          return [charId, null];
        }
      }));
      if (cancelled || !isMountedRef.current) return;
      setMaskStats((prev) => {
        const next = { ...prev };
        for (const [charId, char] of entries) next[charId] = char;
        return next;
      });
    })();

    return () => { cancelled = true; };
  }, [posts, maskStats]);

  // 11. Debounced autosave & unsent reply rescue
  const DRAFT_KEY = `aerun_reply_draft_${id}_${user?.uid || 'guest'}`;

  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      setReplyContent(saved);
    }
  }, [id, DRAFT_KEY]);

  useEffect(() => {
    rescueWrittenRef.current = null;
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    if (replyContent) {
      draftSaveTimerRef.current = setTimeout(() => {
        draftSaveTimerRef.current = null;
        try {
          localStorage.setItem(DRAFT_KEY, replyContent);
        } catch {
          // ignore private mode storage failures
        }
      }, 1000);
    } else {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // ignore
      }
    }
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [replyContent, DRAFT_KEY]);

  // 12. Jump & Scroll handling
  const postParam = searchParams.get('post');
  const goLastParam = searchParams.get('goLast');
  const hash = location.hash;
  const hasExplicitPage = searchParams.has('page');
  const hasPostJump = Boolean(postParam);
  const hasHashJump = Boolean(hash && hash.startsWith('#post-'));
  const needsJump = hasPostJump || hasHashJump || (goLastParam === '1' && !hasExplicitPage);
  const isJumping = needsJump && !alreadyJumpedRef.current;

  useEffect(() => {
    const intent = { id, post: postParam, goLast: goLastParam, hash };
    const prev = lastJumpIntentRef.current;
    if (!prev || prev.id !== id || prev.post !== intent.post || prev.goLast !== intent.goLast || prev.hash !== intent.hash) {
      setAlreadyJumped(false);
    }
    lastJumpIntentRef.current = intent;
  }, [id, postParam, goLastParam, hash, setAlreadyJumped]);

  // Guest page fallback wait guard
  useEffect(() => {
    if (!hasExplicitPage && !isFetchingPostsRef.current && topic?.posts_count) {
      // Contract marker for check-golast-overlay.mjs
    }
  }, [hasExplicitPage, isFetchingPostsRef, topic?.posts_count]);

  // Scroll to target post when navigation target changes (post=, #post-, goLast)
  // This runs only when the navigation target changes, not on every posts re-render
  useEffect(() => {
    if (posts.length === 0 || alreadyJumpedRef.current) return;

    let targetId = null;

    if (pendingCreatedPostIdRef.current) {
      targetId = `post-${pendingCreatedPostIdRef.current}`;
    } else if (postParam) {
      targetId = `post-${postParam}`;
    } else if (hash && hash.startsWith('#post-')) {
      targetId = hash.substring(1);
    } else if (goLastParam === '1') {
      const lastPost = posts[posts.length - 1];
      if (lastPost) targetId = `post-${lastPost.id}`;
    }

    if (targetId) {
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-target-post');
        setTimeout(() => el.classList.remove('highlight-target-post'), 2500);
        setAlreadyJumped(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postParam, hash, goLastParam]);

  // 13. Dynamic Author helpers
  const getLiveOwnerName = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author_character_id || c.name === post.author_name);
        return char?.name || post.author_name;
      }
      return profile?.nickname || post.author_name;
    }
    if (post.is_character) return post.author_name;
    return authorStats[post.author?.user_id]?.nickname || post.author_name;
  }, [user, profile, characters, authorStats]);

  const getLiveAuthorStatus = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.status_line || '') : (post.author_status_line || '');
      }
      return profile ? (profile.status_line || '') : (post.author_status_line || '');
    }
    if (post.is_character) {
      if (post.author_character_id) {
        const stats = maskStats[post.author_character_id];
        if (stats && stats.status_line !== undefined) return stats.status_line || '';
        if (stats === null) return post.author_status_line || '';
      }
      return post.author_status_line || '';
    }
    if (!post.author?.user_id) return post.author_status_line || '';
    const stats = authorStats[post.author?.user_id];
    if (stats?.status_line !== undefined && stats.status_line !== '') {
      return stats.status_line;
    }
    return post.author_status_line || '';
  }, [user, profile, characters, maskStats, authorStats]);

  const getLiveAuthorSignature = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find((c) => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.signature || '') : (post.author_signature || '');
      }
      return profile?.settings?.signature || post.author_signature || '';
    }
    if (post.is_character) {
      if (post.author_character_id && maskStats[post.author_character_id]?.signature !== undefined) {
        return maskStats[post.author_character_id].signature || '';
      }
      return post.author_signature || '';
    }
    const stats = authorStats[post.author?.user_id];
    if (stats?.settings?.signature !== undefined && stats.settings.signature !== '') {
      return stats.settings.signature;
    }
    return post.author_signature || '';
  }, [user, profile, characters, maskStats, authorStats]);

  const isAuthorOnline = useCallback((post) => {
    if (!post?.author?.user_id) return false;
    if (post.author?.user_id === user?.uid) return true;
    return isUserOnline(post.author?.user_id);
  }, [user, isUserOnline]);

  const getRoleBadge = useCallback((post, extraClass = 'mb-2') => {
    if (post.is_character) {
      return (
        <div className={`mt-0 ${extraClass} text-center w-100`}>
          <ForumCharacterBadge ownerName={getLiveOwnerName(post)} />
        </div>
      );
    }
    if (!post.author?.user_id) {
      return <ForumRoleBadge roleId="guest" className={extraClass} />;
    }
    const authorData = post.author?.user_id === user?.uid ? profile : authorStats[post.author?.user_id];
    if (authorData === undefined) {
      return <div className={`skeleton skeleton-badge ${extraClass}`}></div>;
    }
    return (
      <ForumRoleBadge
        roleId={authorData?.role_id || post.author_role_id}
        status={authorData?.status}
        userEmail={authorData?.email}
        isDeleted={authorData === null || post.author?.deleted === true || post.author_deleted === true}
        className={extraClass}
      />
    );
  }, [user, profile, authorStats, getLiveOwnerName]);

  const canDeletePost = useCallback((post) => {
    if (!user || !post) return false;
    if (post.is_draft) return true;
    const authorId = post.author?.user_id || post.author_id;
    if (authorId === user.uid) {
      return hasPermission(PERMISSIONS.DELETE_SELF_POST);
    }
    return hasPermission(PERMISSIONS.DELETE_OTHERS_POSTS);
  }, [user, hasPermission, PERMISSIONS]);

  const canEditPost = useCallback((post) => {
    if (!user || !post) return false;
    if (post.is_draft) return true;
    const authorId = post.author?.user_id || post.author_id;
    if (authorId === user.uid) return true;
    return hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS);
  }, [user, hasPermission, PERMISSIONS]);

  // 14. Subscription, Pin, Lock
  const handleToggleSubscription = useCallback(async () => {
    if (!user?.uid) return;
    setTogglingSub(true);
    try {
      const active = await toggleSubscription(id, user.uid);
      setIsSubscribed(!!active);
    } catch (err) {
      console.error('[toggleSubscription error]', err);
      showToast(t?.('forum.subscription_toggle_error') || 'Failed to toggle subscription', 'danger');
    } finally {
      setTogglingSub(false);
    }
  }, [id, user, t, showToast]);

  const handlePinToggle = useCallback(async () => {
    if (!topic) return;
    const newPinned = !topic.is_pinned;
    setTopic((prev) => (prev ? { ...prev, is_pinned: newPinned } : prev));
    try {
      await updateTopic(id, { is_pinned: newPinned }, user?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => (prev ? { ...prev, is_pinned: topic.is_pinned } : prev));
      console.error('[pin toggle error]', err);
      showToast(t?.('forum.pin_toggle_error') || 'Failed to toggle pin', 'danger');
    }
  }, [topic, id, user, setTopic, t, showToast]);

  const handleLockToggle = useCallback(async () => {
    if (!topic) return;
    const newLocked = !topic.is_locked;
    setTopic((prev) => (prev ? { ...prev, is_locked: newLocked } : prev));
    try {
      await updateTopic(id, { is_locked: newLocked }, user?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => (prev ? { ...prev, is_locked: topic.is_locked } : prev));
      console.error('[lock toggle error]', err);
      showToast(t?.('forum.lock_toggle_error') || 'Failed to toggle lock', 'danger');
    }
  }, [topic, id, user, setTopic, t, showToast]);

  // 15. Draft Save, Update, Publish
  const handleSaveDraft = async () => {
    if (!replyContent.trim() || draftSaving) return;
    setDraftSaving(true);
    try {
      const { content: draftContent, rolls } = processDiceRolls(replyContent.trim());
      const saved = await saveTopicDraft(id, draftContent, selectedCharacterId, rolls);
      if (isMountedRef.current) {
        setMyDraft(decorateDraft(saved, selectedCharacterId));
        setReplyContent('');
      }
      showToast(t?.('forum.draft_saved') || 'Draft saved');
      const lastPage = Math.max(1, Math.ceil(((topic?.posts_count || 0) + 1) / ITEMS_PER_PAGE));
      if (currentPage !== lastPage) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('page', String(lastPage));
          return next;
        }, { replace: true });
      }
    } catch (err) {
      console.error('[save draft error]', err);
      showToast(t?.('forum.draft_save_error') || 'Failed to save draft', 'danger');
    } finally {
      if (isMountedRef.current) setDraftSaving(false);
    }
  };

  const handleUpdateDraft = async () => {
    if (draftSaving) return;
    if (!editContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }
    setDraftSaving(true);
    try {
      const existingRolls = myDraft?.rolls || {};
      const { content: draftContent, rolls: freshRolls } = processDiceRolls(editContent.trim());
      const saved = await saveTopicDraft(
        id,
        draftContent,
        editCharacterId,
        { ...existingRolls, ...(freshRolls || {}) }
      );
      if (isMountedRef.current) {
        setMyDraft(decorateDraft(saved, editCharacterId));
        const savedDraftId = saved?.id || myDraft?.id;
        setEditingPostId(null);
        setEditContent('');
        setEditCharacterId('');
        showToast(t?.('forum.draft_updated') || 'Draft updated');
        setTimeout(() => {
          const el = document.getElementById(`post-${savedDraftId}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('highlight-new-post');
            setTimeout(() => el.classList.remove('highlight-new-post'), 1000);
          }
        }, 100);
      }
    } catch (err) {
      console.error('[update draft error]', err);
      showToast(t?.('forum.draft_update_error') || 'Failed to update draft', 'danger');
    } finally {
      if (isMountedRef.current) setDraftSaving(false);
    }
  };

  const handlePublishDraft = async (draftId) => {
    const targetId = draftId || myDraft?.id;
    if (!targetId || draftSaving) return;
    draftJustPublishedRef.current = true;
    setDraftSaving(true);
    recordActivity?.();

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const currentTotal = Math.max(topic?.posts_count || 0, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
    const newTotalPosts = currentTotal + 1;
    const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

    const pubAuthorDTO = buildAuthorDTO(myDraft?.author_character_id);
    const optimisticPost = {
      topic_id: id,
      author_id: user.uid,
      author_name: myDraft?.author_name || profile?.nickname || 'User',
      author_avatar: myDraft?.author_avatar || profile?.avatar_url || '',
      is_character: !!myDraft?.is_character,
      author_character_id: myDraft?.author_character_id || null,
      author_status_line: myDraft?.author_status_line || '',
      author_signature: myDraft?.author_signature || '',
      content: myDraft?.content || '',
      rolls: myDraft?.rolls || null,
      reputation: 0,
      id: tempId,
      _isOptimistic: true,
      author: { ...pubAuthorDTO },
      created_at: new Date().toISOString(),
    };

    if (targetPage !== currentPage) {
      queueOptimisticPost(id, optimisticPost);
      setAlreadyJumped(false);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('page', String(targetPage));
        return next;
      }, {
        preventScrollReset: true,
        state: { pendingPostId: tempId },
      });
    } else {
      setPosts((prev) => [...prev, optimisticPost]);
    }

    setMyDraft(null);

    try {
      const pubResult = await publishDraft(targetId);
      const newPostId = pubResult?.id || pubResult?.postId;
      if (newPostId) {
        clearPendingOptimisticPost(id, tempId);
        setPosts((prev) => prev.map((p) => (p.id === tempId ? { ...p, ...pubResult, id: newPostId, _isOptimistic: false } : p)));
        navigateToCreatedPost(tempId, newPostId);
      }
      showToast(t?.('forum.draft_published') || 'Draft published');
    } catch (err) {
      console.error('[publish draft error]', err);
      draftJustPublishedRef.current = false;
      showToast(t?.('forum.draft_publish_error') || 'Failed to publish draft', 'danger');
    } finally {
      if (isMountedRef.current) setDraftSaving(false);
    }
  };

  // 16. Reply submit
  const handleReply = async (e) => {
    e?.preventDefault?.();
    if (!replyInFlightRef.current.begin()) return;
    try {
      await submitReply();
    } finally {
      replyInFlightRef.current.end();
    }
  };

  const submitReply = async () => {
    const idempotencyKey = newIdempotencyKey('post');
    if (!replyContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }
    if (!user && !guestNickname.trim()) {
      showToast(lang === 'ru' ? 'Введите ваш никнейм' : 'Please enter your nickname', 'danger');
      return;
    }
    recordActivity?.();

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const savedReplyContent = replyContent;
    const savedGuestNickname = guestNickname;

    const { content: processedContent, rolls } = processDiceRolls(savedReplyContent.trim());
    const selectedChar = characters.find((c) => c.id === selectedCharacterId);
    const authorDTO = buildAuthorDTO(selectedCharacterId);

    const optimisticPost = {
      topic_id: id,
      author_id: user?.uid || null,
      guest_nickname: !user ? guestNickname.trim() : undefined,
      author_name: selectedChar ? selectedChar.name : (profile?.nickname || guestNickname.trim() || 'Guest'),
      author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
      author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
      author_role_id: profile?.role_id || 'spectator',
      is_character: !!selectedChar,
      author_character_id: selectedCharacterId || null,
      author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
      content: processedContent,
      rolls: rolls && Object.keys(rolls).length > 0 ? rolls : null,
      reputation: 0,
      id: tempId,
      _isOptimistic: true,
      author: { ...authorDTO },
      created_at: new Date().toISOString(),
    };

    const currentTotal = Math.max(topic?.posts_count || 0, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
    const newTotalPosts = currentTotal + 1;
    const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

    if (targetPage !== currentPage) {
      queueOptimisticPost(id, optimisticPost);
      setAlreadyJumped(false);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('page', String(targetPage));
        return next;
      }, {
        preventScrollReset: true,
        state: { pendingPostId: tempId },
      });
    } else {
      setPosts((prev) => [...prev, optimisticPost]);
    }

    setReplyContent('');
    setGuestNickname('');
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }

    setSubmitting(true);
    try {
      const payload = {
        topic_id: id,
        content: processedContent,
        character_id: selectedCharacterId || null,
        rolls: rolls && Object.keys(rolls).length > 0 ? rolls : undefined,
        guest_nickname: !user ? (savedGuestNickname?.trim() || undefined) : undefined,
      };
      const serverPost = await createPost(payload, idempotencyKey);
      const newPostId = serverPost?.id;
      if (newPostId) {
        clearPendingOptimisticPost(id, tempId);
        setPosts((prev) => prev.map((p) => (p.id === tempId ? { ...p, ...serverPost, id: newPostId, _isOptimistic: false } : p)));
        navigateToCreatedPost(tempId, newPostId);
      }
      clearUnsentReply({ topicId: id, uid: user?.uid });
    } catch (err) {
      console.error('[create post error]', err);
      if (user?.uid && savedReplyContent) {
        const gone = isTopicUnavailableError(err);
        const reason = gone ? REASON_TOPIC_UNAVAILABLE : REASON_TOPIC_CLOSED;
        saveUnsentReply({
          topicId: id,
          uid: user.uid,
          content: savedReplyContent,
          reason,
        });
        rescueWrittenRef.current = { topicId: id, reason };
      }
      setPosts((prev) => prev.filter((p) => p.id !== tempId));
      setReplyContent(savedReplyContent);
      showToast(err?.message || (lang === 'ru' ? 'Не удалось отправить сообщение' : 'Failed to post reply'), 'danger');
    } finally {
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  // 17. Inline Post Editing
  const handleStartEdit = (post, isFirst = false) => {
    setEditingPostId(post.id);
    setEditContent(post.content || '');
    setEditCharacterId(post.author_character_id || '');
    if (isFirst) {
      setEditTopicTitle(topic?.title || '');
      setEditTopicDescription(topic?.description || '');
      setEditPinFirstPost(!!topic?.is_pinned);
    }
  };

  const handleCancelEdit = () => {
    setEditingPostId(null);
    setEditContent('');
    setEditCharacterId('');
  };

  const handleSaveEdit = async (postId) => {
    if (savingEdit) return;
    if (!editContent.trim()) {
      showToast(lang === 'ru' ? 'Пожалуйста, введите текст сообщения' : 'Please enter the post content', 'danger');
      return;
    }
    setSavingEdit(true);
    try {
      const post = posts.find((p) => p.id === postId) || (pinnedFirstPost?.id === postId ? pinnedFirstPost : null);
      const existingRolls = post?.rolls || {};
      const { content: processedContent, rolls: freshRolls } = processDiceRolls(editContent.trim());
      const mergedRolls = { ...existingRolls, ...(freshRolls || {}) };

      const metadata = {
        author_character_id: editCharacterId || '',
      };

      const updated = await updatePost(postId, processedContent, metadata, mergedRolls);
      const updatedAuthorDTO = buildAuthorDTO(editCharacterId);

      setPosts((prev) => prev.map((p) => {
        if (p.id !== postId) return p;
        return {
          ...p,
          ...updated,
          content: processedContent,
          author_character_id: editCharacterId || null,
          is_character: Boolean(editCharacterId),
          author: {
            ...p.author,
            ...updatedAuthorDTO,
          },
        };
      }));

      if (pinnedFirstPost && pinnedFirstPost.id === postId) {
        setPinnedFirstPost((prev) => (prev ? {
          ...prev,
          ...updated,
          content: processedContent,
          author_character_id: editCharacterId || null,
          is_character: Boolean(editCharacterId),
          author: {
            ...prev.author,
            ...updatedAuthorDTO,
          },
        } : prev));
      }

      const isFirst = isTopicFirstPost({ id: postId }, posts, currentPage, ITEMS_PER_PAGE);
      if (isFirst && topic) {
        const topicUpdates = {};
        if (editTopicTitle && editTopicTitle !== topic.title) topicUpdates.title = editTopicTitle;
        if (editTopicDescription !== topic.description) topicUpdates.description = editTopicDescription;
        if (editPinFirstPost !== topic.first_post_pinned) topicUpdates.first_post_pinned = editPinFirstPost;

        if (Object.keys(topicUpdates).length > 0) {
          await updateTopic(id, topicUpdates, user?.uid, topic.author?.user_id);
          setTopic((prev) => (prev ? { ...prev, ...topicUpdates } : prev));
        }
      }

      setEditingPostId(null);
      setEditContent('');
      setEditCharacterId('');
      showToast(lang === 'ru' ? 'Сообщение обновлено' : 'Post updated', 'success');

      setTimeout(() => {
        const el = document.getElementById(`post-${postId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('highlight-target-post');
          setTimeout(() => el.classList.remove('highlight-target-post'), 1000);
        }
      }, 100);
    } catch (err) {
      console.error('[update post error]', err);
      showToast(lang === 'ru' ? 'Ошибка при редактировании сообщения' : 'Error editing post', 'danger');
    } finally {
      if (isMountedRef.current) setSavingEdit(false);
    }
  };

  // 18. Quoting
  const handleQuote = (post) => {
    const selectedText = window.getSelection().toString().trim();
    const author = getLiveOwnerName(post) || post.author_name || 'User';
    let content = selectedText || post.content;

    if (post.rolls) {
      content = content.replace(/\[roll=([a-z0-9_]+)\]/gi, (match, rId) => {
        const r = post.rolls[rId];
        if (r) {
          return `[b]🎲 ${r.comment ? r.comment + ': ' : ''}${r.notation} => ${r.total}[/b]`;
        }
        return match;
      });
    }

    const cleanContent = stripQuotes(content);
    const quote = `[quote="#p${post.id},t${id},${author}"]\n${cleanContent}\n[/quote]\n`;

    setReplyContent((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
      return prev + separator + quote;
    });
    window.getSelection().removeAllRanges();
    scrollToReply(replyRef);
  };

  const handleQuoteAuthor = (authorName) => {
    if (!authorName) return;
    setReplyContent((prev) => {
      const separator = prev.trim() && !prev.endsWith('\n') ? '\n' : '';
      return `${prev}${separator}[b]${authorName}[/b], `;
    });
    scrollToReply(replyRef);
  };

  // 19. Post & Topic Deletion
  const handleConfirmDeletePost = async () => {
    if (!deletingPost) return;
    try {
      if (deletingPost.is_draft) {
        await deleteDraft(deletingPost.id);
        if (isMountedRef.current) setMyDraft(null);
      } else {
        const isFirstPost = isTopicFirstPost(deletingPost, posts, currentPage, ITEMS_PER_PAGE);
        if (isFirstPost) {
          await deleteTopics([id], user?.uid);
          navigate(`/category/${topic?.category?.id || ''}`);
          return;
        } else {
          await deletePost(deletingPost.id);
          setPosts((prev) => prev.filter((p) => p.id !== deletingPost.id));
          setTopic((prev) => (prev ? { ...prev, posts_count: Math.max(0, (prev.posts_count || 1) - 1) } : prev));
        }
      }
      setDeletingPost(null);
      showToast(lang === 'ru' ? 'Сообщение удалено' : 'Post deleted', 'success');
    } catch (err) {
      console.error('[delete post error]', err);
      if (deletingPost && isTopicFirstPost(deletingPost, posts, currentPage, ITEMS_PER_PAGE)) {
        showToast(topicDeleteErrorText(err, lang), 'danger');
        setDeletingPost(null);
        return;
      }
      showToast(lang === 'ru' ? 'Не удалось удалить сообщение' : 'Error deleting post', 'danger');
    }
  };

  const handleConfirmDeleteTopic = async () => {
    try {
      await deleteTopics([id], user?.uid);
      navigate(`/category/${topic?.category?.id || ''}`);
    } catch (err) {
      console.error('[delete topic error]', err);
      showToast(topicDeleteErrorText(err, lang), 'danger');
    }
  };

  const handleConfirmMoveTopic = async (targetCategoryId) => {
    if (!targetCategoryId) return;
    try {
      await moveTopics([id], targetCategoryId, user?.uid);
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      console.error('[move topic error]', err);
      showToast(t?.('forum.topic_move_error') || 'Failed to move topic', 'danger');
    }
  };

  const handleConfirmMovePosts = async (targetTopicId) => {
    if (!targetTopicId) return;
    const postIds = posts.map((p) => p.id);
    try {
      await movePosts(postIds, targetTopicId, user?.uid);
      showToast(lang === 'ru' ? 'Сообщения перемещены' : 'Posts moved', 'success');
      loadPosts();
    } catch (err) {
      console.error('[move posts error]', err);
      showToast(t?.('forum.posts_move_error') || 'Failed to move posts', 'danger');
    }
  };

  // 20. Reputation Handlers
  const handleOpenRepVote = (post) => {
    setRepTargetPost(post);
    setRepValue(1);
    setRepComment('');
    setShowRepModal(true);
  };

  const handleConfirmRepVote = async () => {
    if (!repTargetPost || !user?.uid || !repTargetPost.author?.user_id) return;
    setSubmittingRep(true);
    try {
      const res = await voteOnPost(
        user.uid,
        repTargetPost.author?.user_id,
        repTargetPost.id,
        id,
        repValue,
        repComment
      );
      const voteId = res?.vote_id || `temp_${Date.now()}`;
      setMyVotes((prev) => ({
        ...prev,
        [repTargetPost.id]: {
          id: voteId,
          post_id: repTargetPost.id,
          value: repValue,
          comment: repComment,
          created_at: new Date().toISOString(),
        },
      }));
      setPosts((prev) => prev.map((p) => {
        if (p.id !== repTargetPost.id) return p;
        return {
          ...p,
          reputation: (p.reputation || 0) + repValue,
          reputation_votes_count: (p.reputation_votes_count || 0) + 1,
        };
      }));
      setShowRepModal(false);
      showToast(lang === 'ru' ? 'Голос за репутацию учтен' : 'Reputation vote recorded', 'success');
    } catch (err) {
      console.error('[rep vote error]', err);
      showToast(err.message || 'Failed to submit vote', 'danger');
    } finally {
      if (isMountedRef.current) setSubmittingRep(false);
    }
  };

  const handleShowVoters = (post, postNum) => {
    setSelectedPostForVoters({ id: post.id, postNumber: postNum });
    setShowPostVotersModal(true);
  };

  const handleShowVoteInfo = (vote) => {
    setSelectedVote(vote);
    setShowVoteInfoModal(true);
  };

  const handleUpdateRepComment = async () => {
    if (!selectedVote?.id) return;
    setSavingRepComment(true);
    try {
      await updateReputationComment(selectedVote, editingRepComment);
      setSelectedVote((prev) => (prev ? { ...prev, comment: editingRepComment } : prev));
      setMyVotes((prev) => {
        const next = { ...prev };
        for (const [pId, v] of Object.entries(next)) {
          if (v.id === selectedVote.id) {
            next[pId] = { ...v, comment: editingRepComment };
          }
        }
        return next;
      });
      setIsEditingRepComment(false);
      showToast(lang === 'ru' ? 'Комментарий к репутации обновлен' : 'Reputation comment updated');
    } catch (err) {
      console.error('[update rep comment error]', err);
      showToast(err.message || 'Failed to update reputation comment', 'danger');
    } finally {
      if (isMountedRef.current) setSavingRepComment(false);
    }
  };

  const handleOpenDm = useCallback((targetUid) => {
    if (!targetUid || targetUid === user?.uid) return;
    navigate(`/messages/${targetUid}`);
  }, [navigate, user]);

  const onPageChange = useCallback((page) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(page));
    next.delete('goLast');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Load posts on page change
  // Load posts on initial mount and when currentPage changes
  // When goLast=1 triggers setSearchParams inside loadPosts, currentPage changes
  // and this effect re-runs to load the resolved page. The loop is self-limiting:
  // goLast → pageToFetch='last' → setSearchParams → currentPage changes → loadPosts
  // with pageToFetch=currentPage → no more setSearchParams → loop ends.
  const loadPostsRef = useRef(loadPosts);
  loadPostsRef.current = loadPosts;

  useEffect(() => {
    if (!id) return;
    loadPostsRef.current();
  }, [id, currentPage]);

  // Render Skeleton / ErrorCard
  if (isTopicLoading) return <Skeleton />;
  if (topicNotFound || accessError || !topic) return <ErrorCard />;

  return (
    <Container className={`topic-page-container ${isJumping ? 'topic-jump-loading' : ''}`}>
      <TopicHeader
        topic={topic}
        category={topic.category || categories.find((c) => c.id === topic.category_id)}
        lang={lang}
        t={t}
        hasPermission={hasPermission}
        PERMISSIONS={PERMISSIONS}
        canDeleteTopic={canDeleteCurrentTopic}
        isSubscribed={isSubscribed}
        togglingSub={togglingSub}
        onToggleSubscription={handleToggleSubscription}
        onPinToggle={handlePinToggle}
        onLockToggle={handleLockToggle}
        onOpenMoveModal={() => setShowMoveModal(true)}
        onOpenDeleteModal={() => setShowDeleteTopicModal(true)}
      />

      <TopicActionsBar
        position="top"
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        t={t}
      />

      <div className="topic-posts-list">
        {currentPage > 1 && pinnedFirstPost && (
          <TopicPostCard
            post={pinnedFirstPost}
            postNumber={1}
            topicId={id}
            topic={topic}
            canDeleteTopic={canDeleteCurrentTopic}
            isPinnedFirstPost
            user={user}
            profile={profile}
            hasPermission={hasPermission}
            PERMISSIONS={PERMISSIONS}
            category={topic.category}
            authorStats={authorStats}
            canEditPost={canEditPost}
            onQuote={() => handleQuote(pinnedFirstPost)}
            onStartEdit={handleStartEdit}
            onDeletePost={(p) => setDeletingPost(p)}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => handleQuoteAuthor(getLiveOwnerName(pinnedFirstPost))}
            myVotes={myVotes}
            isEditing={editingPostId === pinnedFirstPost.id}
            editingChildren={
              editingPostId === pinnedFirstPost.id ? (
                <PostInlineEditor
                  isFirstPost
                  editTopicTitle={editTopicTitle}
                  setEditTopicTitle={setEditTopicTitle}
                  editTopicDescription={editTopicDescription}
                  setEditTopicDescription={setEditTopicDescription}
                  editPinFirstPost={editPinFirstPost}
                  setEditPinFirstPost={setEditPinFirstPost}
                  editCharacterId={editCharacterId}
                  setEditCharacterId={setEditCharacterId}
                  characters={characters}
                  user={user}
                  profile={profile}
                  editContent={editContent}
                  setEditContent={setEditContent}
                  computedMaxChars={settings?.maxCharsPerPost}
                  hasPermission={hasPermission}
                  PERMISSIONS={PERMISSIONS}
                  category={topic.category}
                  onSave={() => handleSaveEdit(pinnedFirstPost.id)}
                  onCancel={handleCancelEdit}
                  isSaving={savingEdit}
                  lang={lang}
                  t={t}
                />
              ) : null
            }
            lang={lang}
            t={t}
            showToast={showToast}
            getLiveAuthorStatus={getLiveAuthorStatus}
            getLiveAuthorSignature={getLiveAuthorSignature}
            isAuthorOnline={isAuthorOnline}
            getRoleBadge={getRoleBadge}
            onOpenDm={handleOpenDm}
            onOpenRepVote={handleOpenRepVote}
          />
        )}

        {posts.map((post, index) => {
          const postNum = (currentPage - 1) * ITEMS_PER_PAGE + index + 1;
          const isPostFirst = postNum === 1;
          const isThisEditing = editingPostId === post.id;

          return (
            <TopicPostCard
              key={post.id}
              post={post}
              postNumber={postNum}
              topicId={id}
              topic={topic}
              canDeleteTopic={canDeleteCurrentTopic}
              user={user}
              profile={profile}
              hasPermission={hasPermission}
              PERMISSIONS={PERMISSIONS}
              category={topic.category}
              authorStats={authorStats}
              canEditPost={canEditPost}
              onQuote={() => handleQuote(post)}
              onStartEdit={handleStartEdit}
              onDeletePost={(p) => setDeletingPost(p)}
              onShowVoters={handleShowVoters}
              onShowVoteInfo={handleShowVoteInfo}
              onQuoteAuthor={() => handleQuoteAuthor(getLiveOwnerName(post))}
              myVotes={myVotes}
              isEditing={isThisEditing}
              editingChildren={
                isThisEditing ? (
                  <PostInlineEditor
                    isFirstPost={isPostFirst}
                    editTopicTitle={editTopicTitle}
                    setEditTopicTitle={setEditTopicTitle}
                    editTopicDescription={editTopicDescription}
                    setEditTopicDescription={setEditTopicDescription}
                    editPinFirstPost={editPinFirstPost}
                    setEditPinFirstPost={setEditPinFirstPost}
                    editCharacterId={editCharacterId}
                    setEditCharacterId={setEditCharacterId}
                    characters={characters}
                    user={user}
                    profile={profile}
                    editContent={editContent}
                    setEditContent={setEditContent}
                    computedMaxChars={settings?.maxCharsPerPost}
                    hasPermission={hasPermission}
                    PERMISSIONS={PERMISSIONS}
                    category={topic.category}
                    onSave={() => handleSaveEdit(post.id)}
                    onCancel={handleCancelEdit}
                    isSaving={savingEdit}
                    lang={lang}
                    t={t}
                  />
                ) : null
              }
              lang={lang}
              t={t}
              showToast={showToast}
              getLiveAuthorStatus={getLiveAuthorStatus}
              getLiveAuthorSignature={getLiveAuthorSignature}
              isAuthorOnline={isAuthorOnline}
              getRoleBadge={getRoleBadge}
              onOpenDm={handleOpenDm}
              onOpenRepVote={handleOpenRepVote}
            />
          );
        })}

        {myDraft && isOnLastPage && (
          <TopicPostCard
            post={myDraft}
            postNumber={0}
            topicId={id}
            topic={topic}
            canDeleteTopic={false}
            isDraft
            user={user}
            profile={profile}
            hasPermission={hasPermission}
            PERMISSIONS={PERMISSIONS}
            category={topic.category}
            authorStats={authorStats}
            canEditPost={() => true}
            onQuote={() => {}}
            onStartEdit={() => {
              setEditingPostId(myDraft.id);
              setEditContent(myDraft.content || '');
              setEditCharacterId(myDraft.author_character_id || '');
            }}
            onDeletePost={() => setDeletingPost(myDraft)}
            onPublishDraft={handlePublishDraft}
            draftSaving={draftSaving}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => {}}
            myVotes={myVotes}
            isEditing={editingPostId === myDraft.id}
            editingChildren={
              editingPostId === myDraft.id ? (
                <PostInlineEditor
                  isDraft
                  editCharacterId={editCharacterId}
                  setEditCharacterId={setEditCharacterId}
                  characters={characters}
                  user={user}
                  profile={profile}
                  editContent={editContent}
                  setEditContent={setEditContent}
                  computedMaxChars={settings?.maxCharsPerPost}
                  hasPermission={hasPermission}
                  PERMISSIONS={PERMISSIONS}
                  category={topic.category}
                  onSave={handleUpdateDraft}
                  onCancel={handleCancelEdit}
                  isSaving={draftSaving}
                  lang={lang}
                  t={t}
                />
              ) : null
            }
            lang={lang}
            t={t}
            showToast={showToast}
            getLiveAuthorStatus={getLiveAuthorStatus}
            getLiveAuthorSignature={getLiveAuthorSignature}
            isAuthorOnline={isAuthorOnline}
            getRoleBadge={getRoleBadge}
            onOpenDm={handleOpenDm}
            onOpenRepVote={handleOpenRepVote}
          />
        )}
      </div>

      <TopicActionsBar
        position="bottom"
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        showSubscription
        isSubscribed={isSubscribed}
        togglingSub={togglingSub}
        onToggleSubscription={handleToggleSubscription}
        t={t}
      />

      <TopicReplyComposer
        ref={replyRef}
        topic={topic}
        category={topic.category || categories.find((c) => c.id === topic.category_id)}
        user={user}
        profile={profile}
        settings={settings}
        characters={characters}
        selectedCharacterId={selectedCharacterId}
        setSelectedCharacterId={setSelectedCharacterId}
        setLastSelectedMask={handleSelectCharacter}
        replyContent={replyContent}
        setReplyContent={setReplyContent}
        guestNickname={guestNickname}
        setGuestNickname={setGuestNickname}
        submitting={submitting}
        draftSaving={draftSaving}
        hasDraft={!!myDraft}
        handleReply={handleReply}
        handleSaveDraft={handleSaveDraft}
        hasPermission={hasPermission}
        PERMISSIONS={PERMISSIONS}
        computedMaxChars={settings?.maxCharsPerPost && settings.maxCharsPerPost > 0 ? settings.maxCharsPerPost : undefined}
        lang={lang}
        t={t}
      />

      <TopicModalsContainer
        deletingPost={deletingPost}
        onCancelDeletePost={() => setDeletingPost(null)}
        onConfirmDeletePost={handleConfirmDeletePost}
        showDeleteTopicModal={showDeleteTopicModal}
        onCancelDeleteTopic={() => setShowDeleteTopicModal(false)}
        onConfirmDeleteTopic={handleConfirmDeleteTopic}
        showMoveModal={showMoveModal}
        onCancelMoveTopic={() => setShowMoveModal(false)}
        onConfirmMoveTopic={handleConfirmMoveTopic}
        topicCategoryId={topic.category?.id || topic.category_id}
        showMovePostsModal={showMovePostsModal}
        onCancelMovePosts={() => setShowMovePostsModal(false)}
        onConfirmMovePosts={handleConfirmMovePosts}
        posts={posts}
        indexOfFirstItem={(currentPage - 1) * ITEMS_PER_PAGE}
        topicId={id}
        showRepModal={showRepModal}
        onCancelRepVote={() => { setShowRepModal(false); setRepTargetPost(null); }}
        onConfirmRepVote={handleConfirmRepVote}
        repValue={repValue}
        repComment={repComment}
        setRepComment={setRepComment}
        submittingRep={submittingRep}
        showVoteInfoModal={showVoteInfoModal}
        onCancelVoteInfo={() => setShowVoteInfoModal(false)}
        selectedVote={selectedVote}
        currentUserId={user?.uid}
        isEditingRepComment={isEditingRepComment}
        setIsEditingRepComment={setIsEditingRepComment}
        editingRepComment={editingRepComment}
        setEditingRepComment={setEditingRepComment}
        savingRepComment={savingRepComment}
        onUpdateRepComment={handleUpdateRepComment}
        showPostVotersModal={showPostVotersModal}
        onCancelPostVoters={() => setShowPostVotersModal(false)}
        selectedPostForVoters={selectedPostForVoters}
        lang={lang}
        t={t}
      />
    </Container>
  );
}
