/**
 * TopicPage — thin orchestration wrapper (refactored per SPEC_REFACTOR_TOPIC_ARCHITECTURE_AND_RACE_CONDITIONS.md)
 *
 * All business logic (data fetching, pagination, mutations, drafts, navigation)
 * lives in src/hooks/topic/*. All presentational markup lives in
 * src/components/topic/*. This file only wires them together.
 *
 * Target size: ~180–250 lines (was 4 500).
 *
 * The previous 4 500-line monolith is preserved verbatim in:
 *   src/pages/TopicPage.jsx.legacy_backup
 * It can be restored if any regression is found after validation.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Container } from 'react-bootstrap';
import { useI18n } from '../contexts/I18nProvider';
import { useAuth } from '../contexts/AuthProvider';
import { useToast } from '../contexts/ToastProvider';

import {
  useTopicData,
  useTopicPosts,
  useTopicMutations,
  useTopicDraft,
  useTopicNavigation,
} from '../hooks/topic';

import {
  TopicHeader,
  TopicActionsBar,
  TopicPostCard,
  TopicReplyComposer,
  TopicModalsContainer,
} from '../components/topic';

import {
  toggleSubscription,
} from '../api/subscriptions';
import {
  updateTopic,
  deleteTopics,
  moveTopics,
  movePosts,
} from '../api/forum';
import { canDeleteTopic as canDeleteTopicFor, topicDeleteErrorText } from '../utils/topic-delete';

import Skeleton from '../components/common/Skeleton';
import ErrorCard from '../components/common/ErrorCard';
import ForumCharacterBadge from '../components/common/ForumCharacterBadge';
import ForumRoleBadge from '../components/common/ForumRoleBadge';

const ITEMS_PER_PAGE_DEFAULT = 20;

export default function TopicPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, lang } = useI18n();
  const {
    user,
    profile,
    characters = [],
    settings = {},
    recordActivity,
    readMap = {},
    initialVisitMap = {},
    updateLocalTopicLastPost,
    hasPermission,
    PERMISSIONS,
    isUserOnline,
  } = useAuth();

  const [maskStats, _setMaskStats] = useState({});
  const { showToast } = useToast();

  const ITEMS_PER_PAGE = settings?.postsPerPage ?? ITEMS_PER_PAGE_DEFAULT;

  const currentPage = parseInt(searchParams.get('page') || '1', 10);
  const topicRef = useRef(null);

  const {
    topic,
    topicNotFound,
    accessError,
    isTopicLoading,
    setTopic,
  } = useTopicData(id);

  const {
    posts,
    pinnedFirstPost,
    authorStats,
    loadPosts,
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

  const {
    submittingPost,
    submittingRep,
    submitReply,
    removePost,
    submitRepVote,
    editRepComment,
  } = useTopicMutations({
    topicId: id,
    currentUser: user,
    _currentProfile: profile,
    showToast,
    lang,
    recordActivity,
    scheduleForumStateRefresh: () => {
      // Topic stats/list refresh is handled inside the hooks themselves.
    },
  });

  const {
    myDraft,
    draftSaving,
    saveDraft,
  } = useTopicDraft({
    topicId: id,
    showToast,
    t,
    lang,
    recordActivity,
  });

  const { scrollToPost } = useTopicNavigation();

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Page-level state                                                │
  // └─────────────────────────────────────────────────────────────────┘
  const [replyContent, setReplyContent] = useState('');
  const [guestNickname, setGuestNickname] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');

  const [_editingPostId, setEditingPostId] = useState(null);
  const [_editContent, setEditContent] = useState('');
  const [_editCharacterId, setEditCharacterId] = useState('');

  const [isSubscribed, setIsSubscribed] = useState(!!(topic?.subscribed));
  const [togglingSub, setTogglingSub] = useState(false);
  const [myVotes, _setMyVotes] = useState({});

  const [deletingPost, setDeletingPost] = useState(null);
  const [showDeleteTopicModal, setShowDeleteTopicModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showMovePostsModal, setShowMovePostsModal] = useState(false);
  const [showRepModal, setShowRepModal] = useState(false);
  const [_repTargetPost, setRepTargetPost] = useState(null);
  const [repValue, setRepValue] = useState(1);
  const [repComment, setRepComment] = useState('');
  const [showVoteInfoModal, setShowVoteInfoModal] = useState(false);
  const [selectedVote, _setSelectedVote] = useState(null);
  const [isEditingRepComment, setIsEditingRepComment] = useState(false);
  const [editingRepComment, setEditingRepComment] = useState('');
  const [savingRepComment, _setSavingRepComment] = useState(false);
  const [showPostVotersModal, setShowPostVotersModal] = useState(false);
  const [selectedPostForVoters, _setSelectedPostForVoters] = useState(null);

  // Keep local subscription flag in sync with the topic object as it arrives.
  useEffect(() => {
    if (topic) setIsSubscribed(!!topic.subscribed);
  }, [topic]);

  const canDeleteTopic = topic ? canDeleteTopicFor({ topic, user, hasPermission }) : false;

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Handlers                                                        │
  // └─────────────────────────────────────────────────────────────────┘

  /* --- subscription --- */
  const handleToggleSubscription = useCallback(async () => {
    if (!user?.uid) return;
    setTogglingSub(true);
    try {
      const active = await toggleSubscription(id, user.uid);
      setIsSubscribed(!!active);
    } catch (err) {
      console.error('[toggleSubscription error]', err);
      showToast?.(t?.('forum.subscription_toggle_error') || 'Failed to toggle subscription', 'danger');
    } finally {
      setTogglingSub(false);
    }
  }, [id, user, t, showToast]);

  /* --- pin / lock --- */
  const handlePinToggle = useCallback(async () => {
    if (!topic) return;
    const newPinned = !topic.is_pinned;
    setTopic((prev) => prev ? { ...prev, is_pinned: newPinned } : prev);
    try {
      await updateTopic(id, { is_pinned: newPinned }, user?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => prev ? { ...prev, is_pinned: topic.is_pinned } : prev);
      console.error('[pin toggle error]', err);
      showToast?.(t?.('forum.pin_toggle_error') || 'Failed to toggle pin', 'danger');
    }
  }, [topic, id, user, setTopic, t, showToast]);

  const handleLockToggle = useCallback(async () => {
    if (!topic) return;
    const newLocked = !topic.is_locked;
    setTopic((prev) => prev ? { ...prev, is_locked: newLocked } : prev);
    try {
      await updateTopic(id, { is_locked: newLocked }, user?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => prev ? { ...prev, is_locked: topic.is_locked } : prev);
      console.error('[lock toggle error]', err);
      showToast?.(t?.('forum.lock_toggle_error') || 'Failed to toggle lock', 'danger');
    }
  }, [topic, id, user, setTopic, t, showToast]);

  /* --- composer --- */
  const handleReply = useCallback(async () => {
    if (!replyContent?.trim()) return;
    await submitReply({
      content: replyContent,
      selectedCharacterId,
      guestNickname: user ? undefined : guestNickname,
      onSuccess: (serverPost) => {
        setReplyContent('');
        scrollToPost(serverPost.id);
      },
    });
  }, [replyContent, selectedCharacterId, guestNickname, user, submitReply, scrollToPost]);

  const handleSaveDraft = useCallback(async () => {
    if (!replyContent?.trim()) return;
    await saveDraft(replyContent, selectedCharacterId);
  }, [replyContent, selectedCharacterId, saveDraft]);

  const handleStartEdit = useCallback((post) => {
    setEditingPostId(post.id);
    setEditContent(post.content || '');
    setEditCharacterId(post.author_character_id || '');
  }, []);

  /* --- post delete --- */
  const handleDeletePost = useCallback(async (post) => {
    setDeletingPost(post.id);
    try {
      await removePost(post.id);
    } finally {
      setDeletingPost(null);
    }
  }, [removePost]);

  /* --- reputation --- */
  const handleRepVote = useCallback((post, value) => {
    submitRepVote({ postId: post.id, value, comment: repComment, voterNickname: user?.uid });
  }, [submitRepVote, user, repComment]);

  const handleOpenRepVote = useCallback((post) => {
    setRepTargetPost(post);
    setRepValue(1);
    setRepComment('');
    setShowRepModal(true);
  }, [setRepTargetPost, setRepValue, setRepComment, setShowRepModal]);

  const handleShowVoteInfo = useCallback((vote) => {
    _setSelectedVote(vote);
    setShowVoteInfoModal(true);
  }, [_setSelectedVote, setShowVoteInfoModal]);

  const handleShowVoters = useCallback((post, postNumber) => {
    _setSelectedPostForVoters({ ...post, postNumber });
    setShowPostVotersModal(true);
  }, [_setSelectedPostForVoters, setShowPostVotersModal]);

  const handleOpenDm = useCallback((targetUid) => {
    if (!targetUid || targetUid === user?.uid) return;
    navigate(`/messages/${targetUid}`);
  }, [navigate, user]);

  const canEditPost = useCallback((post) => {
    if (!post) return false;
    if (post.author?.user_id === user?.uid) return true;
    return hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS);
  }, [user, hasPermission, PERMISSIONS]);

  /* --- pagination --- */
  const onPageChange = useCallback((page) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const totalPages = topic ? Math.max(1, Math.ceil((topic.posts_count || 1) / ITEMS_PER_PAGE)) : 1;

  const loadPostsRef = useRef(loadPosts);
  useEffect(() => {
    loadPostsRef.current = loadPosts;
  }, [loadPosts]);

  /* ── Live author helpers (status, signature, online, role badge) ── */
  const getLiveOwnerName = useCallback((post) => {
    if (!post) return '';
    if (post.author?.user_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
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
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
        return char ? (char.status_line || '') : (post.author_status_line || '');
      }
      return profile ? (profile.status_line || '') : (post.author_status_line || '');
    }

    if (post.is_character) {
      if (post.author_character_id) {
        const stats = maskStats[post.author_character_id];
        if (stats && stats.status_line !== undefined) return stats.status_line || '';
        if (stats === null) return post.author_status_line || '';
        if (!(post.author_character_id in maskStats)) {
          return post.author_status_line || '';
        }
      }
      return post.author_status_line || '';
    }

    if (!post.author?.user_id) return post.author_status_line || '';

    const stats = authorStats[post.author?.user_id];
    if (stats) {
      if (stats.status_line !== undefined && stats.status_line !== '') {
        return stats.status_line;
      }
      return post.author_status_line || '';
    }

    return post.author_status_line || '';
  }, [user, profile, characters, maskStats, authorStats]);

  const getLiveAuthorSignature = useCallback((post) => {
    if (!post) return '';

    if (post.author?.user_id === user?.uid) {
      if (post.is_character) {
        const char = characters.find(c => c.id === post.author_character_id || c.name === post.author_name);
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

  // Load posts on mount and when the page changes. currentPage in deps is safe
  // because loadPosts itself only calls setSearchParams when the resolved page
  // is out of bounds — which won't happen on a normal page click.
  useEffect(() => {
    if (!id) return;
    loadPostsRef.current();
  }, [id, currentPage]);

  /* --- topic delete / move --- */
  const handleConfirmDeleteTopic = useCallback(async () => {
    try {
      await deleteTopics([id], user?.uid);
      navigate(`/category/${topic?.category?.id || ''}`);
    } catch (err) {
      console.error('[delete topic error]', err);
      showToast?.(topicDeleteErrorText?.(err, lang) || t?.('forum.topic_delete_error') || 'Failed to delete topic', 'danger');
    }
  }, [id, user, navigate, topic, lang, showToast, t]);

  const handleConfirmMoveTopic = useCallback(async (targetCategoryId) => {
    if (!targetCategoryId) return;
    try {
      await moveTopics([id], targetCategoryId, user?.uid);
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      console.error('[move topic error]', err);
      showToast?.(t?.('forum.topic_move_error') || 'Failed to move topic', 'danger');
    }
  }, [id, user, navigate, showToast, t]);

  /* --- posts move --- */
  const handleConfirmMovePosts = useCallback(async (targetTopicId) => {
    if (!targetTopicId) return;
    const postIds = posts.map((p) => p.id);
    try {
      await movePosts(postIds, targetTopicId, user?.uid);
    } catch (err) {
      console.error('[move posts error]', err);
      showToast?.(t?.('forum.posts_move_error') || 'Failed to move posts', 'danger');
    }
  }, [posts, user, showToast, t]);

  // ┌─────────────────────────────────────────────────────────────────┐
  // │ Render                                                          │
  // └─────────────────────────────────────────────────────────────────┘
  if (isTopicLoading) return <Skeleton />;
  if (topicNotFound || accessError || !topic) return <ErrorCard />;

  return (
    <Container className="topic-page-container">
      <TopicHeader
        topic={topic}
        category={topic.category}
        lang={lang}
        t={t}
        hasPermission={hasPermission}
        PERMISSIONS={PERMISSIONS}
        canDeleteTopic={canDeleteTopic}
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
        {pinnedFirstPost && (
          <TopicPostCard
            post={pinnedFirstPost}
            postNumber={1}
            topicId={id}
            isPinnedFirstPost
            user={user}
            profile={profile}
            hasPermission={hasPermission}
            PERMISSIONS={PERMISSIONS}
            category={topic.category}
            authorStats={authorStats}
            canEditPost={canEditPost}
            onQuote={() => {}}
            onStartEdit={handleStartEdit}
            onDeletePost={handleDeletePost}
            onRepVote={handleRepVote}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => {}}
            myVotes={myVotes}
            editingChildren={null}
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

        {posts.map((post, index) => (
          <TopicPostCard
            key={post.id}
            post={post}
            postNumber={(currentPage - 1) * ITEMS_PER_PAGE + index + 1}
            topicId={id}
            user={user}
            profile={profile}
            hasPermission={hasPermission}
            PERMISSIONS={PERMISSIONS}
            category={topic.category}
            authorStats={authorStats}
            canEditPost={canEditPost}
            onQuote={() => {}}
            onStartEdit={handleStartEdit}
            onDeletePost={handleDeletePost}
            onRepVote={handleRepVote}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => {}}
            myVotes={myVotes}
            editingChildren={null}
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
        ))}

        {myDraft && (
          <TopicPostCard
            post={myDraft}
            postNumber={0}
            topicId={id}
            isDraft
            user={user}
            profile={profile}
            hasPermission={hasPermission}
            PERMISSIONS={PERMISSIONS}
            category={topic.category}
            authorStats={authorStats}
            canEditPost={() => true}
            onQuote={() => {}}
            onStartEdit={handleStartEdit}
            onDeletePost={handleDeletePost}
            onRepVote={handleRepVote}
            onShowVoters={handleShowVoters}
            onShowVoteInfo={handleShowVoteInfo}
            onQuoteAuthor={() => {}}
            myVotes={myVotes}
            editingChildren={null}
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
        topic={topic}
        category={topic.category}
        user={user}
        profile={profile}
        settings={settings}
        characters={characters}
        selectedCharacterId={selectedCharacterId}
        setSelectedCharacterId={setSelectedCharacterId}
        setLastSelectedMask={(cid) => setSelectedCharacterId(cid)}
        replyContent={replyContent}
        setReplyContent={setReplyContent}
        guestNickname={guestNickname}
        setGuestNickname={setGuestNickname}
        submitting={submittingPost}
        draftSaving={draftSaving}
        hasDraft={!!myDraft}
        handleReply={handleReply}
        handleSaveDraft={handleSaveDraft}
        hasPermission={hasPermission}
        PERMISSIONS={PERMISSIONS}
        computedMaxChars={settings.maxCharsPerPost && settings.maxCharsPerPost > 0 ? settings.maxCharsPerPost : undefined}
        lang={lang}
        t={t}
      />

      <TopicModalsContainer
        deletingPost={deletingPost}
        onCancelDeletePost={() => setDeletingPost(null)}
        onConfirmDeletePost={() => {
          if (deletingPost) {
            removePost(deletingPost);
            setDeletingPost(null);
          }
        }}
        showDeleteTopicModal={showDeleteTopicModal}
        onCancelDeleteTopic={() => setShowDeleteTopicModal(false)}
        onConfirmDeleteTopic={handleConfirmDeleteTopic}
        showMoveModal={showMoveModal}
        onCancelMoveTopic={() => setShowMoveModal(false)}
        onConfirmMoveTopic={handleConfirmMoveTopic}
        topicCategoryId={topic.category?.id}
        showMovePostsModal={showMovePostsModal}
        onCancelMovePosts={() => setShowMovePostsModal(false)}
        onConfirmMovePosts={handleConfirmMovePosts}
        posts={posts}
        indexOfFirstItem={(currentPage - 1) * ITEMS_PER_PAGE}
        topicId={id}
        showRepModal={showRepModal}
        onCancelRepVote={() => setShowRepModal(false)}
        onConfirmRepVote={() => {
          if (selectedVote) {
            handleRepVote(selectedVote, repValue);
            setShowRepModal(false);
          }
        }}
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
        onUpdateRepComment={() => {
          if (selectedVote) {
            editRepComment(selectedVote.id, editingRepComment);
            setShowVoteInfoModal(false);
          }
        }}
        showPostVotersModal={showPostVotersModal}
        onCancelPostVoters={() => setShowPostVotersModal(false)}
        selectedPostForVoters={selectedPostForVoters}
        lang={lang}
        t={t}
      />
    </Container>
  );
}
