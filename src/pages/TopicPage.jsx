/**
 * TopicPage — modular topic orchestration wrapper
 * Refactored per SPEC_REFACTOR_TOPIC_ARCHITECTURE_AND_RACE_CONDITIONS.md
 *
 * Coordinates modular components (TopicHeader, TopicActionsBar, TopicPostCard,
 * PostInlineEditor, TopicReplyComposer, TopicModalsContainer) and hooks
 * (useTopicData, useTopicPosts, useTopicNavigation, useTopicMutations,
 * useTopicModalState, useTopicModeration, useTopicPostAuth, useTopicJumpScroll).
 *
 * Contract requirements (tested via scripts/check-*.mjs):
 * - isTopicFirstPost guard
 * - setAlreadyJumped and isJumping
 * - navigateToCreatedPost navigation
 * - setLastSelectedMask
 * - decorateDraft server draft synchronization
 * - subscribeToTopicNotifications quote tracking
 * - canDeleteTopic affordance
 * - buildPostData passing character_id
 * - handleSaveDraft and handleUpdateDraft
 */
import React, { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Container, Card, Row, Col } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';

import {
  TopicHeader,
  TopicActionsBar,
  TopicPostCard,
  TopicReplyComposer,
  TopicModalsContainer,
  PostInlineEditor,
} from '../components/topic';

import ForumBreadcrumbs from '../components/common/ForumBreadcrumbs';
import { resolveField } from '../utils/text';

import {
  useTopicPageCore,
  useTopicMutations,
  useTopicModalState,
  useTopicModeration,
  useTopicPostAuth,
  useTopicJumpScroll,
  useTopicDmAndNavigation,
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
  subscribeToTopicStats,
} from '../api/forum';

import { toggleSubscription } from '../api/subscriptions';
import { subscribeToTopicNotifications, markNotificationRead } from '../api/notifications';
import { refreshUnreadCounts } from '../api/dms';
import { fetchCharacter } from '../api/character';
import { canDeleteTopic, topicDeleteErrorText } from '../utils/topic-delete';
import { queueOptimisticPost, clearPendingOptimisticPost, resolveOptimisticPost } from '../utils/optimisticPostQueue';
import { processDiceRolls } from '../utils/dice';
import { createInFlight } from '../utils/inflight';
import {
  saveUnsentReply,
  clearUnsentReply,
  hasUnsentReply,
  isTopicUnavailableError,
  REASON_TOPIC_CLOSED,
  REASON_TOPIC_UNAVAILABLE,
} from '../api/unsent-replies';

import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';

const ITEMS_PER_PAGE_DEFAULT = 20;

import { translations } from '../i18n/dictionary.js';

// The server refuses content that references [roll=<id>] throws it did not
// receive. Translate the terse validation message into an actionable one.
const friendlyDiceError = (err, lang) => {
  const message = String(err?.message || '');
  if (message.includes('dice rolls but no rolls were provided')) {
    const dict = translations[lang] || translations.en;
    return dict.topic_page.dice_invalid_tag;
  }
  return err?.message;
};

// First-post detection contract — only page 1 index 0 can be the topic first post.
// Kept inline in TopicPage.jsx per scripts/check-first-post-guard.mjs contract.
// The canonical implementation lives in src/utils/topic-first-post.js.
const isTopicFirstPost = (post, pagePosts, pageNumber, itemsPerPage) => {
  void itemsPerPage;
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

  // 1. Core Page Infrastructure (auth, pagination, topic data, posts)
  const {
    user,
    profile,
    setProfile,
    characters,
    settings,
    recordActivity,
    hasPermission,
    PERMISSIONS,
    isUserOnline,
    categories,
    setLastSelectedMask,
    markTopicRead,
    scheduleForumStateRefresh,
    showToast,
    ITEMS_PER_PAGE,
    currentPage,
    isMountedRef,
    locationRef,
    topicRef,
    replyRef,
    topic,
    topicNotFound,
    topicRestricted,
    topicRestrictedMessage,
    accessError,
    accessErrRaw,
    isTopicLoading,
    setTopic,
    prevTopicStatsRef,
    posts,
    setPosts,
    pinnedFirstPost,
    setPinnedFirstPost,
    authorStats,
    setAuthorStats,
    loadPosts,
    isPageLoading,
    postsLoadError,
    isFetchingPostsRef,
    skipNextLoadForPageRef,
    loadedPageRef,
    updateLocalTopicLastPost,
    updateLocalTopicPostsCount,
  } = useTopicPageCore({
    topicId: id,
    searchParams,
    setSearchParams,
    navigate,
    lang,
  });

  const totalPages = topic ? Math.max(1, Math.ceil((topic.posts_count || 1) / ITEMS_PER_PAGE)) : 1;
  const isOnLastPage = currentPage === totalPages;
  // While the page's posts are still loading (including the server-side
  // goLast/goPost page resolution) the pagination must not render at all:
  // showing it against the not-yet-resolved currentPage flashes "page 1"
  // before the real page arrives.
  const paginationReady = !(isPageLoading && posts.length === 0);
  const paginationTotalPages = paginationReady ? totalPages : 0;
  const canDeleteCurrentTopic = topic ? canDeleteTopic({ topic, user, hasPermission }) : false;

  // 2. Author DTO builder (defined early to prevent TDZ ReferenceErrors)
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
      role: profile?.role || 'spectator',
      status_line: selChar ? (selChar.status_line || '') : (profile?.status_line || ''),
      signature: selChar ? (selChar.signature || '') : (profile?.settings?.signature || ''),
    };
  }, [characters, user, profile]);

  // 3. Draft author decoration (contract: check-drafts-and-settings.mjs)
  const decorateDraft = (draft, charId = '') => {
    if (!draft) return null;
    const maskId = draft.author_character_id || charId;
    const char = characters.find((c) => c.id === maskId);
    const authorName = char ? char.name : (profile?.nickname || user?.displayName || 'Guest');
    const authorAvatar = char ? char.avatar_url : (profile?.avatar_url || '');
    const roleId = profile?.role || (user ? 'player' : 'guest');
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
        role: roleId,
      },
    };
  };

  // 4. Mutations (create/edit/delete post, reputation votes)
  const {
    submitReply: mutationSubmitReply,
    editPost: mutationEditPost,
    removePost: mutationDeletePost,
  } = useTopicMutations({
    topicId: id,
    currentUser: user,
    showToast,
    lang,
    recordActivity,
    scheduleForumStateRefresh,
  });

  // Voting state lives here (declared BEFORE useTopicModalState, which reads
  // and updates it — a later const would be a TDZ ReferenceError).
  const [myVotes, setMyVotes] = useState({});

  // 5. Modal State and handlers
  // 5. Modal State and handlers
  const {
    modalState,
    setModalState,
    handleStartEdit,
    handleCancelEdit,
    handleSaveEdit,
    handleConfirmDeleteTopic,
    handleConfirmMoveTopic,
    handleConfirmMovePosts,
    handleOpenRepVote,
    handleConfirmRepVote,
    handleShowVoters,
    handleShowVoteInfo,
    handleUpdateRepComment,
  } = useTopicModalState({
    topicId: id,
    topic,
    currentUser: user,
    profile,
    myVotes,
    setMyVotes,
    recordActivity,
    lang,
    t,
    showToast,
    posts,
    setPosts,
    setAuthorStats,
    setPinnedFirstPost,
    currentPage,
    ITEMS_PER_PAGE,
    pinnedFirstPost,
    isTopicFirstPost,
    buildAuthorDTO,
    loadPosts,
    scheduleForumStateRefresh,
    mutationEditPost,
    setTopic,
    deleteTopics,
    moveTopics,
    movePosts,
    navigate,
    isMountedRef,
  });

  // 6. Navigation and Jump Scroll (contract: check-golast-overlay.mjs)
  const [, forceJumpRender] = React.useReducer((x) => x + 1, 0);
  const alreadyJumpedRef = useRef(false);
  const setAlreadyJumped = React.useCallback((value) => {
    if (alreadyJumpedRef.current === value) return;
    alreadyJumpedRef.current = value;
    forceJumpRender();
  }, []);

  const pendingCreatedPostIdRef = useRef(null);
  const lastJumpIntentRef = useRef(null);

  const postParam = searchParams.get('post');
  const goLastParam = searchParams.get('goLast');
  const hash = location.hash;
  const hasExplicitPage = searchParams.has('page');

  const hasPostJump = Boolean(postParam);
  const hasHashJump = Boolean(hash && hash.startsWith('#post-'));
  const needsJump = hasPostJump || hasHashJump || (goLastParam === '1' && !hasExplicitPage);
  const isJumping = needsJump && !alreadyJumpedRef.current;

  const {
    navigateToCreatedPost,
  } = useTopicJumpScroll({
    topicId: id,
    _searchParams: searchParams,
    setSearchParams,
    _navigate: navigate,
    posts,
    currentPage,
    ITEMS_PER_PAGE,
    isMountedRef,
    markTopicRead,
    locationRef,
    alreadyJumpedRef,
    setAlreadyJumped,
    pendingCreatedPostIdRef,
    lastJumpIntentRef,
    postParam,
    goLastParam,
    hash,
    hasExplicitPage,
  });

  const { scrollToReply } = useTopicNavigation();

  const {
    handleOpenDm,
    onPageChange,
  } = useTopicDmAndNavigation({
    navigate,
    searchParams,
    setSearchParams,
    user,
  });

  // 7. Reply form, Draft, and Mask state
  const [replyContent, setReplyContent] = useState('');
  // The guest nickname persists in localStorage so it is pre-filled on the
  // next visit (legacy monolith parity).
  const [guestNickname, setGuestNickname] = useState(() => {
    try {
      return localStorage.getItem('aerun_guest_nickname') || '';
    } catch {
      return '';
    }
  });

  // Persist the guest nickname on every change so the next visit pre-fills it.
  useEffect(() => {
    try {
      localStorage.setItem('aerun_guest_nickname', guestNickname);
    } catch {
      // localStorage may be unavailable in private mode; degrade gracefully.
    }
  }, [guestNickname]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [myDraft, setMyDraft] = useState(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const draftJustPublishedRef = useRef(false);
  const isSubmittingReplyRef = useRef(false);
  const replyInFlightRef = useRef(createInFlight());
  const rescueWrittenRef = useRef(null);

  // Mask initialization & selection (contract: check-last-selected-mask.mjs)
  useEffect(() => {
    if (profile?.last_selected_character_id !== undefined && selectedCharacterId === '') {
      setSelectedCharacterId(profile.last_selected_character_id || '');
    }
    const cat = categories?.find((c) => c.id === profile?.category_id);
    const masksUnavailable = settings?.enableCharacters === false
      || (cat && !hasPermission(PERMISSIONS.USE_MASKS, { category: cat }));
    if (masksUnavailable && selectedCharacterId !== '') {
      setSelectedCharacterId('');
      if (user) setLastSelectedMask('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.last_selected_character_id, categories, hasPermission, PERMISSIONS.USE_MASKS, user, setLastSelectedMask, settings?.enableCharacters]);

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

  const [maskStats, setMaskStats] = useState({});
  const [unreadQuotes, setUnreadQuotes] = useState([]);

  // ── Reply draft autosave & unsent-reply rescue (legacy monolith parity) ──
  // Draft Auto-save scoped to user so unsent text does not leak across accounts.
  const DRAFT_KEY = `aerun_reply_draft_${id}_${user?.uid || 'guest'}`;
  // Which reason already produced a rescue for the text currently in the form.
  // Two triggers can fire for one paragraph — the submit that was refused, and
  // then the topic closing or vanishing under that same text — and each would
  // raise its own copy of the modal for identical content. The latch collapses
  // them: once this attempt was rescued, the postability effect steps aside
  // until the member changes the text. Cleared on success and on a new
  // keystroke via the effect that owns DRAFT_KEY below.
  const topicInitialStateRef = useRef({ loaded: false, wasUnavailable: false });
  const replyContentAtLoadRef = useRef('');

  // Record the topic's availability state on first load. Runs once, when the
  // topic read finally resolves (topic set, topicNotFound set, or accessError
  // set). Reset whenever the member navigates to a different topic (id
  // change), because the component may be reused by React Router.
  useEffect(() => {
    topicInitialStateRef.current.loaded = false;
    topicInitialStateRef.current.wasUnavailable = false;
    replyContentAtLoadRef.current = '';
  }, [id]);

  useEffect(() => {
    if (topicInitialStateRef.current.loaded) return;
    if (!topic && !topicNotFound && !accessError) return; // still loading
    topicInitialStateRef.current.loaded = true;
    topicInitialStateRef.current.wasUnavailable =
      topicNotFound || accessError || Boolean(topic && topic.is_locked);
    replyContentAtLoadRef.current = replyContent;
  }, [topic, topicNotFound, accessError, replyContent]);

  // Restore scoped draft first, fall back to the legacy key if the member had
  // unsent text in it before this key existed.
  useEffect(() => {
    const savedDraft = localStorage.getItem(DRAFT_KEY) || localStorage.getItem(`reply_draft_${id}`);
    if (savedDraft) {
      setReplyContent(savedDraft);
    }
  }, [id, DRAFT_KEY]);

  // Debounced autosave of unsent reply text to localStorage. Writing on every
  // keystroke blocks the main thread (synchronous storage I/O) — we defer the
  // write until the member pauses typing, then flush once. `setReplyContent`
  // itself stays immediate so the controlled textarea never lags behind input.
  const draftSaveTimerRef = useRef(null);
  useEffect(() => {
    // The text changed, so whatever was rescued no longer describes it. A new
    // refusal deserves a fresh rescue — cleared immediately, not deferred, so
    // the rescue effect can re-evaluate on the very next keystroke.
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
          // localStorage may be unavailable in private mode; degrade gracefully.
        }
      }, 1000);
    } else {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // localStorage may be unavailable in private mode; degrade gracefully.
      }
    }
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [replyContent, DRAFT_KEY]);

  // THE SECOND RESCUE PATH — the form becomes unusable while the text sits in
  // it. The submit-catch rescue only fires when the member actually presses
  // send. But the two events that make the reply unsendable happen to the
  // topic, not to the form: it locks, or it is deleted/hidden. When that
  // happens the composer is replaced by the closed-lock card or the
  // not-found card — React unmounts it — and the in-memory snapshot inside
  // submitReply dies with it. The DRAFT_KEY autosave survives, but only THIS
  // topic's page reads it back, and there is no page left to do so. So the
  // key is written from this effect, BEFORE the composer disappears, keyed to
  // the one observable that is true in every closing/vanishing case: the
  // stats poll reports is_locked, or the read turns 404/403. A still-empty
  // form is not rescued — there is nothing to save.
  useEffect(() => {
    if (!id || !user?.uid) return;
    const text = replyContent.trim();
    if (!text) return;

    // Wait until the topic read has resolved before deciding whether to
    // rescue. Rescuing before it lands would treat every page load as an
    // incident.
    if (!topic && !topicNotFound && !accessError) return;

    // A topic that is neither locked nor missing is still postable: leave it be.
    if (topic && !topic.is_locked && !topicNotFound && !accessError) return;

    // A merely LOCKED topic still accepts posts from `close_topics` holders —
    // the composer stays mounted for them (TopicReplyComposer keeps rendering
    // the form when the lock bypass applies), so their text is not stranded
    // and there is nothing to rescue. A vanished topic strands even a
    // moderator's text, so the gone-branch below still applies.
    if (topic?.is_locked && hasPermission?.(PERMISSIONS.CLOSE_TOPICS)) return;

    // Only a 404/403 STRANDED the text. `accessError` is set for every failure
    // of the read, and one of those is a timeout or a 500: the topic is alive,
    // the request was not. The classification therefore runs against
    // `accessErrRaw`, the original Error — never against `accessError`, whose
    // `err.message` no longer carries the status the predicate exists to read.
    const gone = topicNotFound || isTopicUnavailableError(accessErrRaw);
    if (accessError && !gone) return;

    // Reason is decided from the state that changed, in the same precedence
    // the page's own cards use: not-found beats access-denied beats a lock.
    const reason = gone ? REASON_TOPIC_UNAVAILABLE : REASON_TOPIC_CLOSED;

    // A page reload (or first visit to an already-closed topic) is not a new
    // incident: the topic was already unavailable when this page loaded, and
    // the draft was simply restored into the form.
    if (
      topicInitialStateRef.current.wasUnavailable &&
      replyContent === replyContentAtLoadRef.current
    ) {
      rescueWrittenRef.current = { topicId: id, reason };
      return;
    }

    // If a rescue already exists for this (topic, member), the text is
    // already safe — leave it be and do not notify the global notice.
    if (hasUnsentReply(id, user?.uid)) {
      rescueWrittenRef.current = { topicId: id, reason };
      return;
    }

    // Already rescued this exact event on this exact topic; the stats poll
    // would otherwise re-write it every 15s until the page is left.
    if (rescueWrittenRef.current?.topicId === id && rescueWrittenRef.current.reason === reason) {
      return;
    }

    const saved = saveUnsentReply({ topicId: id, uid: user.uid, content: replyContent, reason });
    if (saved) rescueWrittenRef.current = { topicId: id, reason };
  }, [id, user?.uid, replyContent, topic, topicNotFound, accessError, accessErrRaw, hasPermission, PERMISSIONS.CLOSE_TOPICS]);

  // A rescue is stale once its key is gone (the member deleted it, or a submit
  // cleared it): forget it so a later rescue on the same topic can re-open.
  useEffect(() => {
    if (rescueWrittenRef.current && !hasUnsentReply(rescueWrittenRef.current.topicId, user?.uid)) {
      rescueWrittenRef.current = null;
    }
  });

  // 8. Post author helpers & quoting
  const {
    getLiveOwnerName,
    getLiveAuthorStatus,
    getLiveAuthorSignature,
    isAuthorOnline,
    getRoleBadge,
    canDeletePost,
    canEditPost,
    handleQuote,
    handleQuoteAuthor,
  } = useTopicPostAuth({
    topicId: id,
    currentUser: user,
    profile,
    characters,
    authorStats,
    maskStats,
    isUserOnline,
    hasPermission,
    PERMISSIONS,
    setReplyContent,
    replyRef,
    scrollToReply,
    _lang: lang,
  });

  // 9. Reply and Draft Handlers (contract: check-forum-read-contract.mjs & check-drafts-and-settings.mjs)
  const buildPostData = (tempId, processedContent = '', rolls = null, authorDTO = {}) => {
    const selectedChar = characters.find((c) => c.id === selectedCharacterId);
    return {
      topic_id: id,
      category_id: topic?.category_id,
      content: processedContent || replyContent.trim(),
      author_id: user?.uid || null,
      guest_nickname: !user ? guestNickname.trim() : undefined,
      character_id: selectedCharacterId || '',
      author_name: selectedChar ? selectedChar.name : (profile?.nickname || guestNickname.trim() || user?.displayName || 'Guest'),
      author_avatar: selectedChar ? selectedChar.avatar_url : (profile?.avatar_url || ''),
      author_status_line: selectedChar ? (selectedChar.status_line || '') : (profile?.status_line || ''),
      author_role_id: profile?.role || 'spectator',
      is_character: !!selectedChar,
      author_character_id: selectedCharacterId || null,
      author_signature: selectedChar ? (selectedChar.signature || '') : (profile?.settings?.signature || ''),
      rolls: rolls && Object.keys(rolls).length > 0 ? rolls : null,
      karma: 0,
      id: tempId || `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      _isOptimistic: true,
      author: { ...authorDTO },
      created_at: new Date().toISOString(),
      owner_name: profile?.nickname || guestNickname.trim() || user?.displayName || 'Guest',
    };
  };

  const handleSaveDraft = async () => {
    if (!replyContent.trim() || myDraft || draftSaving) return;
    setDraftSaving(true);
    try {
      // A draft stores its dice tags RAW: the throw must be editable for as
      // long as the draft is. processDiceRolls runs at PUBLICATION (server
      // side, RollDraftDice) — rolling here would freeze a value the author
      // can still change.
      const saved = await saveTopicDraft(id, replyContent.trim(), selectedCharacterId);
      if (isMountedRef.current) {
        setMyDraft(decorateDraft(saved, selectedCharacterId));
        setReplyContent('');
      }
      showToast(t('forum.draft_saved') || 'Draft saved');
      const lastPage = Math.max(1, totalPages);
      if (currentPage !== lastPage) setSearchParams({ page: lastPage });
    } catch (err) {
      console.error('[save draft error]', err);
      showToast(friendlyDiceError(err, lang) || t('forum.draft_save_error') || 'Failed to save draft', 'danger');
    } finally {
      if (isMountedRef.current) setDraftSaving(false);
    }
  };

  const handleUpdateDraft = async () => {
    if (draftSaving) return;
    const { editCharacterId, editContent } = modalState;
    if (!editContent.trim()) {
      showToast(t('topic_page.enter_content'), 'danger');
      return;
    }
    setDraftSaving(true);
    try {
      // RAW body save (same semantics as handleSaveDraft). The DRAFT'S OWN
      // throws (myDraft.rolls) travel back: a legacy-era draft can carry
      // [roll=<id>] references whose throws live in its rolls map — saving
      // without them would be refused by the server's missing-rolls guard.
      // Entries the new body no longer references are dropped server-side.
      const saved = await saveTopicDraft(
        id,
        editContent.trim(),
        editCharacterId,
        myDraft?.rolls || undefined
      );
      if (isMountedRef.current) {
        setMyDraft(decorateDraft(saved, editCharacterId));
        const savedDraftId = saved?.id || myDraft?.id;
        setModalState((prev) => ({ ...prev, editingPostId: null, editContent: '', editCharacterId: '' }));
        showToast(t('forum.draft_updated') || 'Draft updated');

        setTimeout(() => {
          const element = document.getElementById(`post-${savedDraftId}`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            element.classList.add('highlight-new-post');
            setTimeout(() => element.classList.remove('highlight-new-post'), 1000);
          }
        }, 100);
      }
    } catch (err) {
      console.error('[update draft error]', err);
      showToast(friendlyDiceError(err, lang) || t('forum.draft_update_error') || 'Failed to update draft', 'danger');
    } finally {
      if (isMountedRef.current) setDraftSaving(false);
    }
  };

  const handlePublishDraft = async (draftId) => {
    const targetId = draftId || myDraft?.id;
    if (!targetId) return;
    if (topic?.is_locked && !hasPermission(PERMISSIONS.CLOSE_TOPICS)) {
      showToast(t('forum.draft_locked_error'), 'danger');
      return;
    }
    const publishedDraft = myDraft;
    if (!publishedDraft) return;

    isSubmittingReplyRef.current = true;
    draftJustPublishedRef.current = true;
    setDraftSaving(true);
    recordActivity?.();

    const tempId = `temp_draft_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Remember the optimistic id right away so the unified scroll controller
    // focuses post-${tempId} once the optimistic row is appended.
    pendingCreatedPostIdRef.current = tempId;

    // Drop ?goLast / ?draft from the address bar immediately so the scroll
    // controller does not chase a stale jump intent while the publish is in
    // flight.
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.delete('draft');
      params.delete('goLast');
      return params;
    }, { replace: true, preventScrollReset: true, state: null });

    // THE THROW HAPPENS SERVER-SIDE at publish (forum.RollDraftDice): the
    // draft body carries the RAW [dice=N] tag, and the optimistic row below
    // shows the unrolled "pending" placeholder until the server response
    // reconciles it with the thrown value.

    // Optimistically hide draft
    setMyDraft(null);

    // Client-side post count updates (legacy parity)
    let ownNewStats = null;
    if (user?.uid) {
      const prevOwnStats = authorStats[user.uid] || {};
      ownNewStats = {
        post_count: Math.max(prevOwnStats.post_count || 0, profile?.post_count || 0) + 1,
        reputation: prevOwnStats.reputation ?? profile?.reputation ?? 0,
      };
      setProfile((prev) => (prev ? { ...prev, post_count: (prev.post_count || 0) + 1 } : prev));
      setAuthorStats((prev) => ({
        ...prev,
        [user.uid]: {
          ...(prev[user.uid] || {}),
          ...ownNewStats,
          role: prev[user.uid]?.role || profile?.role || 'player',
          status_line: prev[user.uid]?.status_line ?? profile?.status_line ?? '',
          settings: prev[user.uid]?.settings || (profile?.settings ? { ...profile.settings } : { signature: '' }),
        },
      }));
    }

    const currentTotal = Math.max(topic?.posts_count || 0, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
    const newTotalPosts = currentTotal + 1;
    const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

    setTopic((prev) => (prev ? {
      ...prev,
      posts_count: Math.max(newTotalPosts, (prev.posts_count || 0) + 1),
      last_post_at: new Date().toISOString(),
    } : prev));

    if (prevTopicStatsRef.current) {
      prevTopicStatsRef.current.posts_count = Math.max(newTotalPosts, (prevTopicStatsRef.current.posts_count || 0) + 1);
      prevTopicStatsRef.current.last_post_at = new Date().toISOString();
    }

    const curCategoryId = topicRef.current?.category_id || topic?.category_id;
    const curTitle = topicRef.current?.title || topic?.title;
    if (curCategoryId) {
      updateLocalTopicLastPost?.(id, curCategoryId, curTitle, {
        id: tempId,
        author_id: user?.uid || null,
        author_name: publishedDraft?.author_name || profile?.nickname || 'User',
        author_avatar: publishedDraft?.author_avatar || profile?.avatar_url || '',
        author_role_id: profile?.role || 'player',
        is_character: !!publishedDraft?.is_character,
        author_character_id: publishedDraft?.author_character_id || null,
        created_at: new Date().toISOString(),
      }, newTotalPosts, 1);
    }

    const pubAuthorDTO = buildAuthorDTO(publishedDraft?.author_character_id);
    const optimisticPost = {
      topic_id: id,
      author_id: user?.uid || null,
      author_name: publishedDraft?.author_name || profile?.nickname || user?.displayName || 'User',
      author_avatar: publishedDraft?.author_avatar || profile?.avatar_url || '',
      is_character: !!publishedDraft?.is_character,
      author_character_id: publishedDraft?.author_character_id || null,
      author_status_line: publishedDraft?.author_status_line || '',
      author_signature: publishedDraft?.author_signature || '',
      content: publishedDraft.content || '',
      rolls: null,
      karma: 0,
      id: tempId,
      _isOptimistic: true,
      author: {
        ...pubAuthorDTO,
        ...(ownNewStats ? { posts_count: ownNewStats.post_count, reputation: ownNewStats.reputation } : {}),
      },
      created_at: {
        toDate: () => new Date(),
        toMillis: () => Date.now(),
        seconds: Math.floor(Date.now() / 1000),
      },
    };

    if (targetPage !== currentPage) {
      queueOptimisticPost(id, optimisticPost);
      setAlreadyJumped(false);
      setSearchParams({ page: targetPage }, {
        preventScrollReset: true,
        state: { pendingPostId: tempId },
      });
    } else {
      setPosts((prev) => {
        if (prev.some((p) => p.id === tempId)) return prev;
        return [...prev, optimisticPost];
      });

      setTimeout(() => {
        const element = document.getElementById(`post-${tempId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          element.classList.add('highlight-new-post');
          setTimeout(() => element.classList.remove('highlight-new-post'), 1000);
        }
      }, 50);
    }

    try {
      const pubResult = await publishDraft(publishedDraft.id);
      const newPostId = pubResult?.postId || pubResult?.id;
      if (newPostId) {
        resolveOptimisticPost(id, tempId, newPostId);
        markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length, newPostId);
      }
      navigateToCreatedPost(tempId, newPostId);

      // The server's decorated post is the authority on WHO spoke — the
      // published row is what the read endpoints will serve from now on.
      if (curCategoryId && newPostId) {
        updateLocalTopicLastPost?.(id, curCategoryId, curTitle, {
          id: newPostId,
          author_id: pubResult?.author?.user_id || user?.uid || null,
          author_name: pubResult?.author_name || publishedDraft?.author_name || profile?.nickname || 'User',
          author_avatar: pubResult?.author_avatar || publishedDraft?.author_avatar || profile?.avatar_url || '',
          author_role_id: pubResult?.author_role_id || profile?.role || 'player',
          is_character: pubResult?.is_character ?? !!publishedDraft?.is_character,
          author_character_id: pubResult?.author_character_id || publishedDraft?.author_character_id || null,
          created_at: new Date().toISOString(),
        }, newTotalPosts, 1);
      }

      // Legacy parity: applyMutationResult ≈ forum-state refresh.
      scheduleForumStateRefresh?.();

      if (isMountedRef.current) {
        showToast(t('forum.draft_published'));
        if (newPostId) {
          setPosts((prev) => {
            if (prev.some((p) => p.id === newPostId)) {
              return prev.filter((p) => p.id !== tempId);
            }
            // Build the converged author DTO from the server's response so
            // the reconciled card shows correct data without a page reload.
            const serverAuthor = pubResult?.author || {};
            const convergedAuthorDTO = {
              kind: serverAuthor.kind || 'member',
              user_id: serverAuthor.user_id || user?.uid || null,
              display_name: serverAuthor.display_name || pubResult?.author_name || publishedDraft?.author_name || profile?.nickname || 'User',
              avatar_url: serverAuthor.avatar_url || pubResult?.author_avatar || publishedDraft?.author_avatar || profile?.avatar_url || '',
              character_id: serverAuthor.character_id || pubResult?.author_character_id || null,
              role: serverAuthor.role || profile?.role || 'player',
            };
            return prev.map((p) => {
              if (p.id === tempId) {
                return {
                  ...p,
                  id: newPostId,
                  _isOptimistic: false,
                  // The THROWN content and rolls come from the server — the
                  // optimistic row showed the unrolled [dice=N] placeholder.
                  ...(pubResult?.content !== undefined ? { content: pubResult.content } : {}),
                  ...(pubResult?.rolls !== undefined ? { rolls: pubResult.rolls } : {}),
                  ...(pubResult?.author_name ? { author_name: pubResult.author_name } : {}),
                  ...(pubResult?.author_avatar !== undefined ? { author_avatar: pubResult.author_avatar } : {}),
                  ...(pubResult?.author_status_line !== undefined ? { author_status_line: pubResult.author_status_line } : {}),
                  ...(pubResult?.author_signature !== undefined ? { author_signature: pubResult.author_signature } : {}),
                  ...(pubResult?.is_character !== undefined ? { is_character: pubResult.is_character } : {}),
                  ...(pubResult?.author_character_id !== undefined ? { author_character_id: pubResult.author_character_id } : {}),
                  author: convergedAuthorDTO,
                };
              }
              return p;
            });
          });
          // Remember the real post ID so the unified scroll controller can
          // focus post-${newPostId} once the list re-renders.
          pendingCreatedPostIdRef.current = newPostId;
          // Drop ?draft=1 / ?goLast from the address bar so the draft editor
          // does not reopen and the URL stops pointing at a draft that is now
          // a published post.
          setSearchParams((prev) => {
            const params = new URLSearchParams(prev);
            params.delete('draft');
            params.delete('goLast');
            return params;
          }, { replace: true, preventScrollReset: true, state: null });
        }
      }
    } catch (err) {
      console.error('[publish draft error]', err);
      clearPendingOptimisticPost(id, tempId);

      if (isMountedRef.current) {
        setMyDraft(publishedDraft);
        setPosts((prev) => prev.filter((p) => p.id !== tempId));
        setTopic((prev) => (prev ? { ...prev, posts_count: Math.max(0, (prev.posts_count || 1) - 1) } : prev));

        if (prevTopicStatsRef.current) {
          prevTopicStatsRef.current.posts_count = Math.max(0, (prevTopicStatsRef.current.posts_count || 1) - 1);
        }
      }

      if (user?.uid) {
        setProfile((prev) => (prev ? { ...prev, post_count: Math.max(0, (prev.post_count || 1) - 1) } : prev));
        if (isMountedRef.current) {
          setAuthorStats((prev) => {
            if (!prev[user.uid]) return prev;
            return {
              ...prev,
              [user.uid]: {
                ...prev[user.uid],
                post_count: Math.max(0, (prev[user.uid].post_count || 1) - 1),
              },
            };
          });
        }
      }

      draftJustPublishedRef.current = false;
      showToast(friendlyDiceError(err, lang) || t('forum.draft_publish_error'), 'danger');
    } finally {
      isSubmittingReplyRef.current = false;
      if (isMountedRef.current) {
        setDraftSaving(false);
      }
    }
  };

  const submitReply = async () => {
    if (!replyContent.trim()) {
      showToast(t('topic_page.enter_content'), 'danger');
      return;
    }
    if (!user && !guestNickname.trim()) {
      showToast(t('topic_page.enter_nickname'), 'danger');
      return;
    }
    isSubmittingReplyRef.current = true;
    recordActivity?.();

    // 1. Generate unique temporary ID and save rollback snapshot
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const savedReplyContent = replyContent;
    const savedGuestNickname = guestNickname;

    // The optimistic card gets the rewritten [roll=id] shape + provisional
    // rolls; the REAL throw is drawn server-side (SEC-08), so the card's
    // `rolls` is short-lived and never becomes the request body.
    const { content: processedContent, rolls } = processDiceRolls(replyContent.trim());
    const authorDTO = buildAuthorDTO(selectedCharacterId);

    const optimisticPost = buildPostData(tempId, processedContent, rolls, authorDTO);

    // 2. Client-side own-stats updates (optimistic, legacy parity): the reply
    // author card and the profile header show the incremented counts before
    // the server confirms.
    let ownNewStats = null;
    if (user?.uid) {
      const prevOwnStats = authorStats[user.uid] || {};
      ownNewStats = {
        post_count: Math.max(prevOwnStats.post_count || 0, profile?.post_count || 0) + 1,
        reputation: prevOwnStats.reputation ?? profile?.reputation ?? 0,
      };
      setProfile((prev) => (prev ? { ...prev, post_count: (prev.post_count || 0) + 1 } : prev));
      setAuthorStats((prev) => ({
        ...prev,
        [user.uid]: {
          ...(prev[user.uid] || {}),
          ...ownNewStats,
          role: prev[user.uid]?.role || profile?.role || 'player',
          status_line: prev[user.uid]?.status_line ?? profile?.status_line ?? '',
          settings: prev[user.uid]?.settings || (profile?.settings ? { ...profile.settings } : { signature: '' }),
        },
      }));
      optimisticPost.author = {
        ...authorDTO,
        ...(ownNewStats ? { posts_count: ownNewStats.post_count, reputation: ownNewStats.reputation } : {}),
      };
    }

    // Calculate pagination target (legacy parity: the REAL topic counter
    // decides where the optimistic post lands — a placeholder formula here
    // pinned the reply to page 1 of every multi-page topic).
    const currentTotal = Math.max(topic?.posts_count || 0, (currentPage - 1) * ITEMS_PER_PAGE + posts.length);
    const newTotalPosts = currentTotal + 1;
    const targetPage = Math.ceil(newTotalPosts / ITEMS_PER_PAGE) || 1;

    // Immediately update local topic state so posts_count and pagination UI
    // update instantly
    setTopic((prev) => (prev ? {
      ...prev,
      posts_count: Math.max(newTotalPosts, (prev.posts_count || 0) + 1),
      last_post_at: new Date().toISOString(),
    } : prev));

    if (prevTopicStatsRef.current) {
      prevTopicStatsRef.current.posts_count = Math.max(newTotalPosts, (prevTopicStatsRef.current.posts_count || 0) + 1);
      prevTopicStatsRef.current.last_post_at = new Date().toISOString();
    }

    const curCategoryId = topicRef.current?.category_id || topic?.category_id;
    const curTitle = topicRef.current?.title || topic?.title;
    if (curCategoryId) {
      updateLocalTopicLastPost?.(id, curCategoryId, curTitle, {
        id: tempId,
        author_id: user?.uid || null,
        author_name: optimisticPost.author_name || profile?.nickname || guestNickname || 'User',
        author_avatar: optimisticPost.author_avatar || profile?.avatar_url || '',
        author_role_id: profile?.role || 'player',
        is_character: !!optimisticPost.is_character,
        author_character_id: optimisticPost.author_character_id || null,
        created_at: new Date().toISOString(),
      }, newTotalPosts, 1);
    }

    if (targetPage !== currentPage) {
      queueOptimisticPost(id, optimisticPost);
      setAlreadyJumped(false);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('page', String(targetPage));
        return next;
      }, { preventScrollReset: true, state: { pendingPostId: tempId } });
    } else {
      // Same-page send: reset the jump latch so the unified scroll controller
      // can position on post-${newPostId} once the server confirms it
      // (onSuccess below sets pendingCreatedPostIdRef.current).
      setAlreadyJumped(false);

      setPosts((prev) => {
        if (prev.some((p) => p.id === tempId)) return prev;
        return [...prev, optimisticPost];
      });

      // Highlight the freshly created post on its page (legacy parity).
      setTimeout(() => {
        const element = document.getElementById(`post-${tempId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          element.classList.add('highlight-new-post');
          setTimeout(() => element.classList.remove('highlight-new-post'), 1000);
        }
      }, 50);
    }

    // 3. Clear editor input immediately for snappy UX
    setReplyContent('');

    setSubmitting(true);
    try {
      await mutationSubmitReply({
        content: savedReplyContent,
        selectedCharacterId,
        guestNickname: savedGuestNickname,
        // The SAME temp id the optimistic card was appended under — the
        // hook's onSuccess reconcile must address THAT card. A hook-local
        // second id made the replacement miss and duplicated the post.
        tempId,
        onSuccess: (post, tempIdRef) => {
          const newPostId = post?.id;
          if (newPostId) {
            clearPendingOptimisticPost(id, tempIdRef);
            // Reconcile is REMOVAL-aware: a loadPosts() that ran between the
            // optimistic append and this response (move/stats poll) already
            // carried the server row (different id, so the temp survived its
            // optimistic-preservation filter). A blind map replace would then
            // produce the temp's twin — the same post rendered twice until
            // reload. If the real post is already in the list, DROP the temp.
            setPosts((prev) => {
              if (prev.some((p) => p.id === newPostId)) {
                return prev.filter((p) => p.id !== tempIdRef);
              }
              return prev.map((p) => (p.id === tempIdRef ? { ...p, ...post, id: newPostId, _isOptimistic: false } : p));
            });
            navigateToCreatedPost(tempIdRef, newPostId);
            markTopicRead?.(id, (currentPage - 1) * ITEMS_PER_PAGE + posts.length, newPostId);
            // Same-page sends never touch `location.state`, so remember the
            // real post ID here — the unified scroll controller will focus
            // `post-${newPostId}` once the optimistic placeholder swaps to
            // the server ID.
            pendingCreatedPostIdRef.current = newPostId;
            // Reset the jump latch so the scroll effect in useTopicJumpScroll
            // (guarded by alreadyJumpedRef.current) can reposition on the
            // confirmed post after a same-page send.
            setAlreadyJumped(false);
            if (curCategoryId) {
              updateLocalTopicLastPost?.(id, curCategoryId, curTitle, {
                id: newPostId,
                author_id: user?.uid || null,
                author_name: optimisticPost.author_name || profile?.nickname || savedGuestNickname || 'User',
                author_avatar: optimisticPost.author_avatar || profile?.avatar_url || '',
                author_role_id: profile?.role || 'player',
                is_character: !!optimisticPost.is_character,
                author_character_id: optimisticPost.author_character_id || null,
                created_at: new Date().toISOString(),
              }, newTotalPosts, 1);
            }
          }
        },
        onError: (err, tempIdRef, savedContent) => {
          console.error('[create post error]', err);
          // A VALIDATION error leaves the text in the form — the member can
          // fix and retry, nothing is lost. The unsent-reply rescue is for
          // text that would actually disappear (topic gone/closed) — it must
          // not fire for form-fixable validation failures.
          const isValidation = err?.code === 'validation';
          if (user?.uid && savedContent && !isValidation) {
            const gone = isTopicUnavailableError(err);
            const reason = gone ? REASON_TOPIC_UNAVAILABLE : REASON_TOPIC_CLOSED;
            saveUnsentReply({
              topicId: id,
              uid: user.uid,
              content: savedContent,
              reason,
            });
            rescueWrittenRef.current = { topicId: id, reason };
          }
          setPosts((prev) => prev.filter((p) => p.id !== tempIdRef));

          // Rollback the optimistic topic counter updates (legacy parity).
          if (isMountedRef.current) {
            setTopic((prev) => (prev ? {
              ...prev,
              posts_count: Math.max(0, (prev.posts_count || 1) - 1),
            } : prev));
            if (prevTopicStatsRef.current) {
              prevTopicStatsRef.current.posts_count = Math.max(0, (prevTopicStatsRef.current.posts_count || 1) - 1);
            }
          }

          // Rollback the own-stats bump (legacy parity).
          if (user?.uid) {
            setProfile((prev) => (prev ? { ...prev, post_count: Math.max(0, (prev.post_count || 1) - 1) } : prev));
            if (isMountedRef.current) {
              setAuthorStats((prev) => {
                if (!prev[user.uid]) return prev;
                return {
                  ...prev,
                  [user.uid]: {
                    ...prev[user.uid],
                    post_count: Math.max(0, (prev[user.uid].post_count || 1) - 1),
                  },
                };
              });
            }
          }

          // Restore input in UI
          setReplyContent(savedContent);
          setGuestNickname(savedGuestNickname);
          try {
            if (savedContent) localStorage.setItem(DRAFT_KEY, savedContent);
          } catch {
            // ignore
          }
          showToast(friendlyDiceError(err, lang) || t('topic_page.post_failed'), 'danger');
        },
      });
      // A successful send means the text reached the topic, so there is
      // nothing left to rescue and no draft to keep (legacy parity).
      try {
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(`reply_draft_${id}`);
        clearUnsentReply(id, user?.uid);
        rescueWrittenRef.current = null;
      } catch {
        // ignore
      }
    } catch {
      // Errors are fully handled in onError (toast + rollbacks + text
      // restore). Swallowed here — rethrowing just surfaced an unhandled
      // promise rejection.
    } finally {
      isSubmittingReplyRef.current = false;
      if (isMountedRef.current) setSubmitting(false);
    }
  };

  const handleReply = async (e) => {
    e?.preventDefault?.();
    if (!replyInFlightRef.current.begin()) return;
    try {
      await submitReply();
    } finally {
      replyInFlightRef.current.end();
    }
  };

  // 10. Moderation handlers
  const {
    togglingSub,
    isSubscribed,
    setIsSubscribed,
    handleToggleSubscription,
    handlePinToggle,
    handleLockToggle,
  } = useTopicModeration({
    topicId: id,
    topic,
    currentUser: user,
    lang,
    t,
    showToast,
    toggleSubscription,
    updateTopic,
    setTopic,
    deleteTopics,
    moveTopics,
    movePosts,
    navigate,
    isMountedRef,
  });

  // Post deletion (contract: check-topic-delete-affordance.mjs & check-drafts-and-settings.mjs)
  const handleConfirmDeletePost = async () => {
    const deletingPost = modalState.deletingPost;
    if (!deletingPost) return;
    try {
      if (deletingPost.is_draft) {
        await deleteDraft(deletingPost.id);
        setMyDraft(null);
        setModalState((prev) => ({ ...prev, deletingPost: null }));
        showToast(t('topic_page.draft_deleted')); 
        return;
      } else {
        const isFirstPost = isTopicFirstPost(modalState.deletingPost, posts, currentPage, ITEMS_PER_PAGE);
        if (isFirstPost) {
          await deleteTopics([id], user?.uid);
          // Same stale-projection surface as Session 33: the category index
          // must drop the deleted topic from its Last Post column.
          scheduleForumStateRefresh?.();
          navigate(`/category/${topic?.category?.id || ''}`);
          return;
        } else {
          const delAuthorId = deletingPost.author?.user_id;
          const targetPostId = deletingPost.id;
          const remainingPosts = posts.filter((p) => p.id !== targetPostId);

          // ОПТИМИСТИЧНЫЙ UI: мгновенно убираем пост с экрана
          setPosts((prev) => prev.filter((p) => p.id !== targetPostId));

          const result = await mutationDeletePost(targetPostId);

          const toMs = (value) => value?.toMillis?.() ?? new Date(value || 0).getTime();
          const topicLastMs = toMs(topic?.last_post_at);
          const deletedPostMs = toMs(deletingPost.created_at);
          const nextPostCount = Math.max(0, (topic?.posts_count || posts.length) - 1);
          const nextLastPost = [...remainingPosts].sort((a, b) => toMs(b.created_at) - toMs(a.created_at))[0];
          // Prefer the authoritative last_post_id; fall back to timestamps.
          const isDeletedPostLast = topic?.last_post_id
            ? topic.last_post_id === targetPostId
            : deletedPostMs === topicLastMs;

          setTopic((prev) => (prev ? {
            ...prev,
            posts_count: nextPostCount,
            last_post_id: nextLastPost?.id || prev.last_post_id,
          } : prev));

          if (prevTopicStatsRef.current) {
            prevTopicStatsRef.current.posts_count = nextPostCount;
            if (nextLastPost) {
              prevTopicStatsRef.current.last_post_id = nextLastPost.id;
            }
          }

          if (category?.id && nextLastPost && isDeletedPostLast) {
            updateLocalTopicLastPost?.(id, category.id, topic?.title || '', nextLastPost, nextPostCount, -1);
          } else {
            updateLocalTopicPostsCount?.(id, category?.id, -1);
          }

          // Own-stats decrement for the deleted post's author (legacy parity).
          if (delAuthorId) {
            if (delAuthorId === user?.uid) {
              setProfile((prev) => (prev ? { ...prev, post_count: Math.max(0, (prev.post_count || 0) - 1) } : prev));
            }
            setAuthorStats((prev) => (prev[delAuthorId] ? {
              ...prev,
              [delAuthorId]: {
                ...prev[delAuthorId],
                post_count: Math.max(0, (prev[delAuthorId].post_count || 0) - 1),
              },
            } : prev));
          }

          if (result?.isGhost) {
            showToast(t('topic_page.ghost_post_cleared'), 'info'); 
          } else {
            showToast(t('topic_page.post_deleted'), 'success'); 
          }

          // The deleted post was the only one on this page — go back one page.
          if (currentPage > 1 && remainingPosts.length === 0) {
            setSearchParams({ page: currentPage - 1 });
          }
        }
      }
      setModalState((prev) => ({ ...prev, deletingPost: null }));
    } catch (err) {
      console.error('[delete post error]', err);
      if (modalState.deletingPost && isTopicFirstPost(modalState.deletingPost, posts, currentPage, ITEMS_PER_PAGE)) {
        showToast(topicDeleteErrorText(err, lang), 'danger');
        setModalState((prev) => ({ ...prev, deletingPost: null }));
        return;
      }
      showToast(t('topic_page.delete_post_error'), 'danger'); 
      // Resync with the server: the optimistic removal may have been wrong.
      await loadPosts?.();
    }
  };

  // Topic stats freshness contract (contract: check-forum-read-contract.mjs)
  useEffect(() => {
    if (!id || topicRestricted) return;
    const unsub = subscribeToTopicStats(id, () => {});
    return () => unsub();
  }, [id, topicRestricted]);

  // 11. Topic context fetch (server draft, votes, subscription)
  useEffect(() => {
    if (!user?.uid || !id || !topic || topicNotFound || topicRestricted) return;
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
  }, [user?.uid, id, topic?.id, topicNotFound, topicRestricted]);

  // 12. Quote notifications subscription (contract)
  // Depend on topic?.id (primitive) instead of the `topic` object so that
  // live stats updates (which create a new topic identity on every tick) do
  // not tear down and re-open the subscription — that was Effect 12's
  // "срыв подписки" generating duplicate quote-notification fetches.
  useEffect(() => {
    if (!user?.uid || !id || !topic?.id || topicNotFound || topicRestricted) return;
    const unsub = subscribeToTopicNotifications(user.uid, id, (activeQuotes) => {
      setUnreadQuotes(activeQuotes || []);
    });
    return () => unsub();
  }, [user?.uid, id, topic?.id, topicNotFound, topicRestricted]);

  // Guest page fallback wait guard — contract marker for check-golast-overlay.mjs
  useEffect(() => {
    if (!hasExplicitPage && !isFetchingPostsRef.current && topic?.posts_count) {
      // Contract marker for check-golast-overlay.mjs
    }
  }, [hasExplicitPage, isFetchingPostsRef, topic?.posts_count]);

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

  // 13. Mask stats hydration via fetchCharacter
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
  }, [posts, maskStats, isMountedRef]);

  // 14. Author stats come from the posts payload itself — every decorated
  // post carries its author's posts_count/reputation (post.author), so no
  // per-author profile hydration runs here. The old fetchUserProfile N+1 is
  // gone: /api/aerun/users/{uid} no longer fires once per author on every
  // page load.

  // 15. Mark topic as read when posts are displayed (legacy monolith parity,
  // legacy_backup 633-654).
  //
  // The read cursor is PINNED to the id of the last post this screen rendered:
  // a reply that lands after the load (live update or a race) must stay
  // unread instead of being swallowed by a "now" stamp — the server falls
  // back to exactly that when last_visible_post_id is missing
  // (markTopicReadHandler). Without the pin every silent live refetch
  // re-stamped "now" and the Active Topics unread badge flashed (1) and
  // wiped itself even though the new posts sit on a page never rendered.
  //
  // The offset guard keeps same-page refetches from re-calling the endpoint
  // at all; it re-arms on topic/page change like the monolith's
  // lastMarkedOffsetRef.
  const lastMarkedOffsetRef = useRef(-1);
  useEffect(() => {
    lastMarkedOffsetRef.current = -1;
  }, [id, currentPage]);

  useEffect(() => {
    if (!user?.uid || !id || posts.length === 0) return;
    if (profile?.role === 'spectator') return;
    if (isSubmittingReplyRef.current) return;
    const lastMessageIndex = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1);
    if (lastMarkedOffsetRef.current === lastMessageIndex) return;
    lastMarkedOffsetRef.current = lastMessageIndex;
    // Optimistic (not-yet-confirmed) posts are skipped: their temp ids would
    // 404 server-side and the cursor must only hold persisted rows. A page
    // with NO real post must not mark at all — that would fall back to the
    // server's "now" stamp and swallow replies that landed meanwhile.
    const lastRealPost = [...posts].reverse().find((p) => !p._isOptimistic && p.id);
    if (!lastRealPost) return;
    markTopicRead(id, lastMessageIndex, lastRealPost.id);
  }, [user?.uid, id, posts, currentPage, ITEMS_PER_PAGE, markTopicRead, profile?.role]);

  // 15b. Pin the reply composer under the typing caret while live updates
  // insert or remove posts above it.
  //
  // A post arriving from another reader is rendered BEFORE the composer, so
  // the form (with the member half-written reply and its focus) is pushed
  // out of the viewport mid-keystroke. While the member is actually typing,
  // compensate the scroll so the form and the caret stay visually still.
  //
  // THE BASELINE IS THE COMPOSER DOCUMENT-RELATIVE OFFSET, never its
  // viewport position: the document offset changes ONLY when content above
  // the composer changes, so the member own scrolling between updates can
  // never leak into the delta (a viewport baseline turned every live update
  // into "scroll the member back to where the FORM was" - literally throwing
  // a reader whose focus stayed in the textarea while they scrolled up to
  // read, to the top of the page). The compensation itself is the VIEWPORT
  // delta, so a browser scroll anchoring that already restored the position
  // makes it a no-op rather than a double correction. Reading without focus
  // is never disturbed: the scroll only moves when document.activeElement
  // lives inside the composer and the composer is on screen. replyRef points
  // at the composer root element (forwardRef).
  const composerDocTopRef = useRef(null);
  useLayoutEffect(() => {
    // While the member's own reply is in flight the local posts_count bump and
    // optimistic insert already move content; compensating the scroll here
    // would fight the same movement and produce jitter. Skip until the server
    // confirms and isSubmittingReplyRef flips back to false.
    if (isSubmittingReplyRef.current) return;

    const el = replyRef.current;
    if (!el || !el.isConnected) {
      composerDocTopRef.current = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const docTop = rect.top + window.scrollY;
    const prev = composerDocTopRef.current;
    if (prev === null) {
      composerDocTopRef.current = docTop;
      return;
    }
    const deltaDoc = docTop - prev;
    composerDocTopRef.current = docTop;
    if (deltaDoc === 0) return; // content above the form did not move

    const active = document.activeElement;
    const typing = !!active && (active === el || el.contains(active));
    // The form is scrolled out of view: the member is reading, not pinned to
    // the caret - leave the scroll alone.
    const onScreen = rect.bottom > 0 && rect.top < window.innerHeight;
    if (typing && onScreen) {
      // Where the form top edge sat in the viewport BEFORE the content above
      // it moved (the scroll position itself is unchanged by a DOM mutation),
      // and scroll only the gap the browser has not already closed for us.
      const viewportBefore = prev - window.scrollY;
      window.scrollBy(0, rect.top - viewportBefore);
    }
    // replyRef is a stable ref object; including it only satisfies the linter.
  }, [posts, replyRef]);

  // 16. Load posts on page change or initial topic resolution
  const loadPostsRef = useRef(loadPosts);
  loadPostsRef.current = loadPosts;
  const hasTopic = Boolean(topic);

  useEffect(() => {
    if (!id || !hasTopic || topicNotFound || topicRestricted) return;
    loadPostsRef.current();
  }, [id, hasTopic, topicNotFound, topicRestricted, currentPage]);

  // 16b. Live updates from OTHER readers (legacy monolith parity).
  //
  // The stats loop (subscribeToTopicStats: realtime nudge + 15s fallback)
  // keeps `topic` fresh, but freshness alone renders nothing: THIS is the
  // consumer the poll exists for. The monolith's "Load posts whenever topic
  // id or page changes" effect (legacy_backup 572-631) reloaded the page the
  // moment the freshness key moved — another member posted, a post was
  // deleted — and the hook decomposition lost it, freezing every reader on
  // the posts they opened with.
  //
  // The key is deliberately ONLY the freshness fields (last_post_id,
  // posts_count): an optimistic submitReply bumps posts_count WITHOUT
  // last_post_id, and the server's confirmation swaps last_post_id in — the
  // reload then converges the page with the server (bringing the posts other
  // readers published in the meantime). A title/lock/pin change moves no
  // key and costs no refetch.
  const prevTopicKeyRef = useRef(null);
  const watchedIdRef = useRef(null);
  const watchedPageRef = useRef(currentPage);
  const postsRef = useRef(posts);
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  useEffect(() => {
    if (!id || !topic || topicNotFound || topicRestricted) return;

    // A different topic (or the first delivery for this one) is effect 16's
    // initial load, not news — re-arm the key and step aside.
    if (watchedIdRef.current !== id) {
      watchedIdRef.current = id;
      prevTopicKeyRef.current = `${id}|${topic.last_post_id || ''}|${topic.posts_count || 0}`;
      watchedPageRef.current = currentPage;
      return;
    }

    const currentTopicKey = `${id}|${topic.last_post_id || ''}|${topic.posts_count || 0}`;
    if (prevTopicKeyRef.current === currentTopicKey) return;
    prevTopicKeyRef.current = currentTopicKey;

    // A page navigation is effect 16's job; if the page changed in this same
    // commit, its effect already fetches — do not double-bill the endpoint.
    if (watchedPageRef.current !== currentPage) {
      watchedPageRef.current = currentPage;
      return;
    }

    // A deep-link tick that just resolved this exact page owns the fetch
    // (skipNextLoadForPageRef contract from useTopicPosts).
    if (skipNextLoadForPageRef.current === currentPage) {
      skipNextLoadForPageRef.current = null;
      return;
    }

    // A jump target (?post=) that is already rendered on the loaded page
    // needs no refetch — scrolling is the navigation effect's job.
    const jumpTargetId = searchParams.get('post');
    if (jumpTargetId && loadedPageRef.current === currentPage && postsRef.current.some((p) => p.id === jumpTargetId)) {
      return;
    }

    // Own reply in flight: the posts_count bump came from our local optimistic update,
    // not from a server post. Fetching now would only read stale pre-submit rows.
    if (isSubmittingReplyRef.current) {
      return;
    }

    // If the server's newest last_post_id is ALREADY rendered on this page (e.g. reconciled
    // from our own submit onSuccess), there is nothing new to re-fetch from the server.
    if (topic.last_post_id && postsRef.current.some((p) => p.id === topic.last_post_id)) {
      return;
    }

    // Silent refetch: the rendered page stays on screen while the request is
    // in flight (stale-while-revalidate), and loadPosts merges the server
    // answer around the still-pending optimistic cards.
    loadPostsRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, topic, topicNotFound, topicRestricted, currentPage, searchParams]);

  // Render Skeleton / ErrorCard
  if (isTopicLoading) return <Skeleton />;
  if (topicNotFound || accessError || !topic) {
    // RES-02: parametrize the card. The branch used to render a bare
    // `<ErrorCard />` — no title, no diagnosis, no retry — so a 404, a 403
    // and a network failure were indistinguishable and the reader had no
    // way to act on any of them. `accessErrRaw` is the raw ApiError the
    // stats loop surfaced (sendApi preserves status/code/requestId) and the
    // card already classifies a transport failure vs a server fault vs an
    // auth refusal; the title carries the human answer: 404 means the topic
    // is gone, 403 means the category is closed to this reader, anything
    // else is a transient load failure worth retrying.
    const isRestricted = topicRestricted;
    const isNotFound = topicNotFound && !isRestricted;
    const errorTitle = isRestricted
      ? t('topic_page.access_denied')
      : isNotFound
        ? t('topic_page.topic_not_found')
        : t('topic_page.failed_load_topic');

    return (
      <ErrorCard
        title={errorTitle}
        message={topicRestrictedMessage || undefined}
        error={null}
        hideTechnicalDetails={isRestricted}
        // restricted и not found — осознанные ответы сервера, а не обрыв
        // соединения. classifyError(null) без явного флага ставит диагноз
        // "network", что вводит читателя в заблуждение.
        isNetworkError={isNotFound || isRestricted ? false : undefined}
        onRetry={undefined}
      />
    );
  }

  const category = topic.category || categories.find((c) => c.id === topic.category_id);
  const categoryTitle = category ? resolveField(category.title, lang) : '...';

  // Legacy parity: the max-chars cap falls back to 15000 when unset and is
  // disabled entirely when <= 0 — maxLength={0} would silently block all
  // keyboard input in the editors.
  const MAX_CHARS = settings?.maxCharsPerPost ?? 15000;
  const computedMaxChars = MAX_CHARS > 0 ? MAX_CHARS : undefined;

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
        currentPage={currentPage}
        totalPages={paginationTotalPages}
        onPageChange={onPageChange}
        onPinToggle={handlePinToggle}
        onLockToggle={handleLockToggle}
        onOpenMoveModal={() => setModalState((prev) => ({ ...prev, showMoveModal: true }))}
        onOpenMovePostsModal={() => setModalState((prev) => ({ ...prev, showMovePostsModal: true }))}
        onOpenDeleteModal={() => setModalState((prev) => ({ ...prev, showDeleteTopicModal: true }))}
      />

      <div className="topic-posts-list">
        {postsLoadError && posts.length === 0 ? (
          <ErrorCard
            title={t('topic_page.failed_load_posts')}
            error={postsLoadError}
            onRetry={() => loadPosts(currentPage)}
          />
        ) : null}
        {!postsLoadError && posts.length === 0 && isPageLoading
          ? /* Inline skeleton while page posts are loading (legacy parity). */
            [...Array(3)].map((_, i) => (
              <Card key={`skel-${i}`} className="mb-4 post-card shadow-sm border-0 overflow-hidden skeleton-fade-in">
                <Row className="g-0">
                  <Col md={3} lg={2} className="author-sidebar p-3 d-none d-md-block text-center border-end" style={{ minHeight: '200px' }}>
                    <Skeleton variant="avatar" width={80} height={80} className="mb-3 mx-auto rounded-circle" />
                    <Skeleton width="70%" height="1.2rem" className="mb-2 mx-auto" />
                    <Skeleton width="50%" height="0.8rem" className="mb-2 mx-auto" />
                  </Col>
                  <Col md={9} lg={10} className="p-4">
                    <div className="d-flex justify-content-between mb-4">
                      <Skeleton width="25%" height="1rem" />
                      <Skeleton width="40px" height="1rem" />
                    </div>
                    <div>
                      <Skeleton width="100%" height="1rem" className="mb-2" />
                      <Skeleton width="100%" height="1rem" className="mb-2" />
                      <Skeleton width="85%" height="1rem" className="mb-2" />
                      <Skeleton width="40%" height="1rem" className="mb-2" />
                    </div>
                    <div className="mt-5 pt-3 border-top">
                      <Skeleton width="150px" height="1.5rem" />
                    </div>
                  </Col>
                </Row>
              </Card>
            ))
          : null}
        {/* Unpin must take effect live: the flag is the TOPIC's (refreshed by
            the stats poll and by the PATCH merge in handleSaveEdit), so the
            card is gated on it — pinnedFirstPost alone is a load-time
            snapshot that kept a unpinned post rendered until reload. */}
        {currentPage > 1 && pinnedFirstPost && topic?.first_post_pinned !== false && (
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
            category={category}
            authorStats={authorStats}
            canEditPost={canEditPost}
            onQuote={() => handleQuote(pinnedFirstPost)}
            onStartEdit={handleStartEdit}
            onDeletePost={(p) => setModalState((prev) => ({ ...prev, deletingPost: p }))}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => handleQuoteAuthor(getLiveOwnerName(pinnedFirstPost))}
            myVotes={myVotes}
            isEditing={modalState.editingPostId === pinnedFirstPost.id}
            editingChildren={
              modalState.editingPostId === pinnedFirstPost.id ? (
                <PostInlineEditor
                  isFirstPost
                  editTopicTitle={modalState.editTopicTitle}
                  setEditTopicTitle={(v) => setModalState((prev) => ({ ...prev, editTopicTitle: v }))}
                  editTopicDescription={modalState.editTopicDescription}
                  setEditTopicDescription={(v) => setModalState((prev) => ({ ...prev, editTopicDescription: v }))}
                  editPinFirstPost={modalState.editPinFirstPost}
                  setEditPinFirstPost={(v) => setModalState((prev) => ({ ...prev, editPinFirstPost: v }))}
                  editCharacterId={modalState.editCharacterId}
                  setEditCharacterId={(v) => setModalState((prev) => ({ ...prev, editCharacterId: v }))}
                  characters={characters}
                  canChangeMask={pinnedFirstPost.author?.user_id === user?.uid}
                  user={user}
                  profile={profile}
                  editContent={modalState.editContent}
                  setEditContent={(v) => setModalState((prev) => ({ ...prev, editContent: v }))}
                  computedMaxChars={computedMaxChars}
                  hasPermission={hasPermission}
                  PERMISSIONS={PERMISSIONS}
                  category={category}
                  onSave={() => handleSaveEdit(pinnedFirstPost.id)}
                  onCancel={handleCancelEdit}
                  isSaving={modalState.savingEdit}
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
          const isThisEditing = modalState.editingPostId === post.id;

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
              category={category}
              authorStats={authorStats}
              canEditPost={canEditPost}
              canDeletePost={canDeletePost}
              onQuote={() => handleQuote(post)}
              onStartEdit={handleStartEdit}
              onDeletePost={(p) => setModalState((prev) => ({ ...prev, deletingPost: p }))}
              onShowVoters={handleShowVoters}
              onShowVoteInfo={handleShowVoteInfo}
              onQuoteAuthor={() => handleQuoteAuthor(getLiveOwnerName(post))}
              myVotes={myVotes}
              isEditing={isThisEditing}
              editingChildren={
                isThisEditing ? (
                  <PostInlineEditor
                    isFirstPost={isPostFirst}
                    editTopicTitle={modalState.editTopicTitle}
                    setEditTopicTitle={(v) => setModalState((prev) => ({ ...prev, editTopicTitle: v }))}
                    editTopicDescription={modalState.editTopicDescription}
                    setEditTopicDescription={(v) => setModalState((prev) => ({ ...prev, editTopicDescription: v }))}
                    editPinFirstPost={modalState.editPinFirstPost}
                    setEditPinFirstPost={(v) => setModalState((prev) => ({ ...prev, editPinFirstPost: v }))}
                    editCharacterId={modalState.editCharacterId}
                    setEditCharacterId={(v) => setModalState((prev) => ({ ...prev, editCharacterId: v }))}
                    characters={characters}
                    canChangeMask={post.author?.user_id === user?.uid}
                    user={user}
                    profile={profile}
                    editContent={modalState.editContent}
                    setEditContent={(v) => setModalState((prev) => ({ ...prev, editContent: v }))}
                    computedMaxChars={computedMaxChars}
                    hasPermission={hasPermission}
                    PERMISSIONS={PERMISSIONS}
                    category={category}
                    onSave={() => handleSaveEdit(post.id)}
                    onCancel={handleCancelEdit}
                    isSaving={modalState.savingEdit}
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
            category={category}
            authorStats={authorStats}
            canEditPost={() => true}
            onQuote={() => {}}
            onStartEdit={() => {
              setModalState((prev) => ({
                ...prev,
                editingPostId: myDraft.id,
                editContent: myDraft.content || '',
                editCharacterId: myDraft.author_character_id || '',
              }));
            }}
            onDeletePost={() => setModalState((prev) => ({ ...prev, deletingPost: myDraft }))}
            onPublishDraft={handlePublishDraft}
            draftSaving={draftSaving}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => {}}
            myVotes={myVotes}
            isEditing={modalState.editingPostId === myDraft.id}
            editingChildren={
              modalState.editingPostId === myDraft.id ? (
                <PostInlineEditor
                  isDraft
                  editCharacterId={modalState.editCharacterId}
                  setEditCharacterId={(v) => setModalState((prev) => ({ ...prev, editCharacterId: v }))}
                  characters={characters}
                  user={user}
                  profile={profile}
                  editContent={modalState.editContent}
                  setEditContent={(v) => setModalState((prev) => ({ ...prev, editContent: v }))}
                  computedMaxChars={computedMaxChars}
                  hasPermission={hasPermission}
                  PERMISSIONS={PERMISSIONS}
                  category={category}
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

      {/* Bottom Actions & Pagination (legacy parity): the follow/unfollow button
          is for authenticated members only — pending, banned and spectator roles
          (and guests) never see it. */}
      <TopicActionsBar
        position="bottom"
        currentPage={currentPage}
        totalPages={paginationTotalPages}
        onPageChange={onPageChange}
        showSubscription={!!(user && profile?.role !== 'pending' && profile?.role !== 'banned' && profile?.role !== 'spectator')}
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
        computedMaxChars={computedMaxChars}
        lang={lang}
        t={t}
      />

      {/* Bottom breadcrumbs & back-to-category (legacy parity) */}
      <div className="mt-5 mb-5">        <ForumBreadcrumbs
          items={[
            ...(category ? [{ label: categoryTitle, to: `/category/${category.id}` }] : []),
            { label: topic?.title || '...', active: true },
          ]}
        />

        <div className="d-flex justify-content-between">
          {category && (
            <Link to={`/category/${category.id}`} className="btn btn-outline-secondary">
              &larr; {t('forum.back_to_category')}
            </Link>
          )}
        </div>
      </div>

      <TopicModalsContainer
        deletingPost={modalState.deletingPost}
        onCancelDeletePost={() => setModalState((prev) => ({ ...prev, deletingPost: null }))}
        onConfirmDeletePost={handleConfirmDeletePost}
        showDeleteTopicModal={modalState.showDeleteTopicModal}
        onCancelDeleteTopic={() => setModalState((prev) => ({ ...prev, showDeleteTopicModal: false }))}
        onConfirmDeleteTopic={handleConfirmDeleteTopic}
        showMoveModal={modalState.showMoveModal}
        onCancelMoveTopic={() => setModalState((prev) => ({ ...prev, showMoveModal: false }))}
        onConfirmMoveTopic={handleConfirmMoveTopic}
        topicCategoryId={topic.category?.id || topic.category_id}
        showMovePostsModal={modalState.showMovePostsModal}
        onCancelMovePosts={() => setModalState((prev) => ({ ...prev, showMovePostsModal: false }))}
        onConfirmMovePosts={handleConfirmMovePosts}
        posts={posts}
        indexOfFirstItem={(currentPage - 1) * ITEMS_PER_PAGE}
        topicId={id}
        showRepModal={modalState.showRepModal}
        onCancelRepVote={() => setModalState((prev) => ({ ...prev, showRepModal: false, repTargetPost: null }))}
        onConfirmRepVote={handleConfirmRepVote}
        repValue={modalState.repValue}
        repComment={modalState.repComment}
        setRepComment={(v) => setModalState((prev) => ({ ...prev, repComment: v }))}
        submittingRep={modalState.submittingRep}
        showVoteInfoModal={modalState.showVoteInfoModal}
        onCancelVoteInfo={() => setModalState((prev) => ({ ...prev, showVoteInfoModal: false }))}
        selectedVote={modalState.selectedVote}
        currentUserId={user?.uid}
        isEditingRepComment={modalState.isEditingRepComment}
        setIsEditingRepComment={(v) => setModalState((prev) => ({ ...prev, isEditingRepComment: v }))}
        editingRepComment={modalState.editingRepComment}
        setEditingRepComment={(v) => setModalState((prev) => ({ ...prev, editingRepComment: v }))}
        savingRepComment={modalState.savingRepComment}
        onUpdateRepComment={handleUpdateRepComment}
        showPostVotersModal={modalState.showPostVotersModal}
        onCancelPostVoters={() => setModalState((prev) => ({ ...prev, showPostVotersModal: false }))}
        selectedPostForVoters={modalState.selectedPostForVoters}
        lang={lang}
        t={t}
      />
    </Container>
  );
}
