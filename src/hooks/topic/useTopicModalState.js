import { useCallback, useState } from 'react';
import { voteOnPost, updateReputationComment } from '../../api/reputation';
import { updateTopic } from '../../api/forum';

/**
 * useTopicModalState: Custom hook for managing all modal state and handlers.
 *
 * Encapsulates: modalState, setModalState, handleStartEdit, handleCancelEdit,
 * handleSaveEdit, handleConfirmDeletePost, handleConfirmDeleteTopic,
 * handleConfirmMoveTopic, handleConfirmMovePosts, handleOpenRepVote,
 * handleConfirmRepVote, handleShowVoters, handleShowVoteInfo,
 * handleUpdateRepComment
 */
export const useTopicModalState = ({
  topicId,
  topic,
  currentUser,
  profile,
  myVotes,
  setMyVotes,
  recordActivity,
  lang,
  _t,
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
  mutationEditPost,
  setTopic,
  deleteTopics,
  moveTopics,
  movePosts,
  navigate,
  isMountedRef,
  loadPosts,
  scheduleForumStateRefresh,
}) => {
  const [modalState, setModalState] = useState({
    deletingPost: null,
    showDeleteTopicModal: false,
    showMoveModal: false,
    showMovePostsModal: false,
    showRepModal: false,
    repTargetPost: null,
    repTargetPostNumber: null,
    repValue: 1,
    repComment: '',
    showVoteInfoModal: false,
    selectedVote: null,
    isEditingRepComment: false,
    editingRepComment: '',
    savingRepComment: false,
    showPostVotersModal: false,
    selectedPostForVoters: null,
    editingPostId: null,
    editContent: '',
    editCharacterId: '',
    editTopicTitle: '',
    editTopicDescription: '',
    editPinFirstPost: false,
    savingEdit: false,
  });

  const handleStartEdit = useCallback((post, isFirst = false) => {
    setModalState((prev) => ({
      ...prev,
      editingPostId: post.id,
      editContent: post.content || '',
      editCharacterId: post.author_character_id || '',
      ...(isFirst && {
        editTopicTitle: topic?.title || '',
        editTopicDescription: topic?.description || '',
        // The DTO field is first_post_pinned (the in-topic pin of the opening
        // post) — `pinned` is the topic's own category pin, and `is_pinned`
        // does not exist on the wire.
        editPinFirstPost: !!topic?.first_post_pinned,
      }),
    }));
  }, [setModalState, topic]);

  const handleCancelEdit = useCallback(() => {
    setModalState((prev) => ({
      ...prev,
      editingPostId: null,
      editContent: '',
      editCharacterId: '',
    }));
  }, [setModalState]);

  const handleSaveEdit = useCallback(async (postId) => {
    if (modalState.savingEdit) return;
    if (!modalState.editContent.trim()) {
      showToast(t('forum.enter_post_content'), 'danger');
      return;
    }
    setModalState((prev) => ({ ...prev, savingEdit: true }));
    try {
      const post = posts.find((p) => p.id === postId) || (pinnedFirstPost?.id === postId ? pinnedFirstPost : null);
      const updated = await mutationEditPost({
        postId,
        content: modalState.editContent.trim(),
        characterId: modalState.editCharacterId,
        existingRolls: post?.rolls || {},
      });

      // Identity preservation: an edit rewrites CONTENT, never authorship.
      // buildAuthorDTO resolves from the CURRENT session (user/profile/
      // characters), so it is only valid when the edited post belongs to
      // the current user. For guest posts and moderated edits of other
      // members' posts the stored identity must survive — the server never
      // touches authorship on edit and answers with the authoritative DTO.
      const isOwnAccountPost = Boolean(currentUser?.uid) && post?.author?.user_id === currentUser.uid;
      const serverAuthor = updated?.author || null;
      const localAuthorDTO = isOwnAccountPost ? buildAuthorDTO(modalState.editCharacterId) : null;
      const nextAuthor = (prevAuthor) => ({
        ...prevAuthor,
        ...(serverAuthor || {}),
        ...(localAuthorDTO || {}),
      });
      const identityFields = isOwnAccountPost
        ? {
            author_character_id: modalState.editCharacterId || null,
            is_character: Boolean(modalState.editCharacterId),
          }
        : {};

      setPosts((prev) => prev.map((p) => {
        if (p.id !== postId) return p;
        return {
          ...p,
          ...updated,
          content: updated?.content,
          ...identityFields,
          author: nextAuthor(p.author),
        };
      }));

      if (pinnedFirstPost && pinnedFirstPost.id === postId) {
        setPinnedFirstPost((prev) => (prev ? {
          ...prev,
          ...updated,
          content: updated?.content,
          ...identityFields,
          author: nextAuthor(prev.author),
        } : prev));
      }

      // The first post is edited from TWO places: page 1's first card (it
      // lives in `posts` there) and the pinned card on page 2+ (it lives in
      // `pinnedFirstPost`, NOT in `posts`). isTopicFirstPost answers "is this
      // page-1 index 0" by design — it exists to keep a page-2 REPLY from
      // being mistaken for the whole-topic first post — so it alone returned
      // false for the pinned-card edit, and the save silently dropped the
      // topic fields (title/description/pin) on pages 2+.
      const isPinnedCard = Boolean(pinnedFirstPost && pinnedFirstPost.id === postId);
      const isFirst = isPinnedCard || isTopicFirstPost({ id: postId }, posts, currentPage, ITEMS_PER_PAGE);
      if (isFirst && topic) {
        const topicUpdates = {};
        if (modalState.editTopicTitle) topicUpdates.title = modalState.editTopicTitle;
        if (modalState.editTopicDescription !== undefined) topicUpdates.description = modalState.editTopicDescription;
        // Always send a boolean for the opening post: the server's
        // updateTopicForm carries first_post_pinned and an absent key would
        // leave the checkbox state ambiguous.
        topicUpdates.first_post_pinned = Boolean(modalState.editPinFirstPost);

        if (Object.keys(topicUpdates).length > 0) {
          await updateTopic(topicId, topicUpdates, currentUser?.uid);
          setTopic((prev) => (prev ? { ...prev, ...topicUpdates } : prev));
        }
      }

      setModalState((prev) => ({ ...prev, editingPostId: null, editContent: '', editCharacterId: '' }));
      showToast(t('forum.post_updated'), 'success');

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
      showToast(t('forum.edit_post_error'), 'danger');
    } finally {
      if (isMountedRef.current) setModalState((prev) => ({ ...prev, savingEdit: false }));
    }
  }, [topicId, currentUser, lang, showToast, posts, pinnedFirstPost, currentPage, ITEMS_PER_PAGE, isTopicFirstPost, buildAuthorDTO, mutationEditPost, setPosts, setPinnedFirstPost, setTopic, topic, isMountedRef, modalState]);


  const handleConfirmDeleteTopic = async () => {
    if (!topic || !modalState.showDeleteTopicModal) return;
    try {
      await deleteTopics([topicId], currentUser?.uid);
      // The category index (topics_count/posts_count/last_post_*) is a
      // client-cached projection — without this refresh the deleted topic
      // keeps rendering in the category's Last Post column until the next
      // unrelated refresh cycle.
      scheduleForumStateRefresh?.();
      navigate(`/category/${topic.category?.id || topic.category_id}`);
    } catch (err) {
      console.error('[delete topic error]', err);
      showToast(t('forum.delete_topic_error'), 'danger');
    }
  };

  const handleConfirmMoveTopic = async (targetCategoryId) => {
    if (!targetCategoryId) return;
    try {
      await moveTopics([topicId], targetCategoryId, currentUser?.uid);
      // Same stale-projection surface as the delete: the moved topic must
      // leave the old category's Last Post and appear in the new one.
      scheduleForumStateRefresh?.();
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      console.error('[move topic error]', err);
      showToast(t('forum.move_topic_error'), 'danger');
    }
  };

  // Parameter order matches MovePostsModal.onConfirm: (postIds, targetTopicId).
  // The swapped order once sent the TOPIC id as post_ids and the post-id
  // array as target_topic_id — a validation 400 on every move.
  // Parameter order matches MovePostsModal.onConfirm: (postIds, targetTopicId).
  // The swapped order once sent the TOPIC id as post_ids and the post-id
  // array as target_topic_id — a validation 400 on every move.
  const handleConfirmMovePosts = async (postIds, targetTopicId) => {
    if (!targetTopicId || !Array.isArray(postIds) || postIds.length === 0) return;
    try {
      // Moving the topic's opening post does NOT delete the topic (owner
      // ruling 2026-11-01): the server re-files the opener onto the next
      // earliest post and the page reloads in place. The page leaves only
      // when the move takes EVERY visible post — an emptied topic has no
      // content left to show.
      const topicNowEmpty = (topic?.posts_count || 0) - postIds.length <= 0;
      const categoryId = topic?.category_id;
      const movedCount = postIds.length;
  
      await movePosts(postIds, topicId, targetTopicId, currentUser?.uid);
      scheduleForumStateRefresh?.();
      showToast(t('forum.posts_moved'), 'success');
  
      if (topicNowEmpty) {
        if (categoryId) {
          navigate(`/category/${categoryId}`);
        } else {
          navigate('/');
        }
        return;
      }
  
      // Shrink the donor counter and resync: loadPosts re-fetches the posts
      // (the moved ones disappear), the last-post projection and author
      // stats — everything straight from the server.
      const currentCount = topic?.posts_count || posts.length;
      const newCount = Math.max(1, currentCount - movedCount);
      const newTotalPages = Math.max(1, Math.ceil(newCount / ITEMS_PER_PAGE));
  
      setTopic((prev) => (prev ? { ...prev, posts_count: newCount } : prev));
  
      if (currentPage > newTotalPages) {
        navigate(`/topic/${topicId}?page=${newTotalPages}`);
      } else {
        await loadPosts?.(currentPage);
      }
    } catch (err) {
      console.error('[move posts error]', err);
      showToast(err.message || t('forum.move_posts_error'), 'danger');
    }
  };
  const handleOpenRepVote = useCallback((post, postNumber) => {
    // Legacy parity guards: authenticated non-spectator, not own post,
    // not already voted by this user.
    if (!post) return;
    if (!currentUser || profile?.role === 'spectator') return;
    if (!post.author?.user_id || post.author?.user_id === currentUser.uid) return;
    if (myVotes?.[post.id]) return;
    setModalState((prev) => ({
      ...prev,
      repTargetPost: post,
      repTargetPostNumber: postNumber ?? null,
      repValue: 1,
      repComment: '',
      showRepModal: true,
    }));
  }, [setModalState, currentUser, profile, myVotes]);

  const handleConfirmRepVote = useCallback(async () => {
    const repTargetPost = modalState.repTargetPost;
    const repValue = modalState.repValue;
    if (!repTargetPost || !currentUser?.uid || !repTargetPost.author?.user_id) return;
    setModalState((prev) => ({ ...prev, submittingRep: true }));
    try {
      await voteOnPost(
        currentUser.uid,
        repTargetPost.author?.user_id,
        repTargetPost.id,
        topicId,
        repValue,
        modalState.repComment,
        topic?.title,
        modalState.repTargetPostNumber,
        profile?.nickname || currentUser.displayName || 'User'
      );

      // Optimistic update for posts — the rep badge must re-render without a reload.
      setPosts((prev) => prev.map((p) => (
        p.id === repTargetPost.id
          ? { ...p, karma: (p.karma || 0) + repValue }
          : p
      )));

      // Optimistic update for the pinned first post if it's the target.
      setPinnedFirstPost((prev) => (prev && prev.id === repTargetPost.id
        ? { ...prev, karma: (prev.karma || 0) + repValue }
        : prev));

      // Optimistic update for authorStats (the author's reputation).
      const repAuthorId = repTargetPost.author?.user_id;
      setAuthorStats?.((prev) => {
        if (!repAuthorId || !prev || !(repAuthorId in prev) || !prev[repAuthorId]) return prev;
        const stats = prev[repAuthorId];
        return {
          ...prev,
          [repAuthorId]: {
            ...stats,
            reputation: (stats.reputation || 0) + repValue,
          },
        };
      });

      setModalState((prev) => ({ ...prev, showRepModal: false }));

      // Record the own vote so the voted badge shows immediately.
      setMyVotes?.((prev) => ({
        ...prev,
        [repTargetPost.id]: {
          value: repValue,
          comment: modalState.repComment,
          voter_nickname: profile?.nickname || currentUser.displayName || 'User',
          topic_title: topic?.title || '',
          post_number: modalState.repTargetPostNumber,
          created_at: { toDate: () => new Date() },
        },
      }));

      recordActivity?.();
      showToast(t('forum.reputation_updated'));
    } catch (err) {
      console.error('[rep vote error]', err);
      showToast(err.message || 'Failed to submit vote', 'danger');
    } finally {
      if (isMountedRef.current) {
        setModalState((prev) => ({
          ...prev,
          submittingRep: false,
          repTargetPost: null,
          repTargetPostNumber: null,
        }));
      }
    }
  }, [topicId, currentUser, modalState, setModalState, showToast, lang, isMountedRef, topic, setPosts, setPinnedFirstPost, setAuthorStats, setMyVotes, profile, recordActivity]);

  const handleShowVoters = useCallback((post, postNum) => {
    setModalState((prev) => ({ ...prev, selectedPostForVoters: { id: post.id, postNumber: postNum }, showPostVotersModal: true }));
  }, [setModalState]);

  const handleShowVoteInfo = useCallback((vote) => {
    setModalState((prev) => ({ ...prev, selectedVote: vote, showVoteInfoModal: true }));
  }, [setModalState]);

  const handleUpdateRepComment = useCallback(async () => {
    if (!modalState.selectedVote?.id) return;
    setModalState((prev) => ({ ...prev, savingRepComment: true }));
    try {
      await updateReputationComment(modalState.selectedVote, modalState.editingRepComment);
      const updatedVote = { ...modalState.selectedVote, comment: modalState.editingRepComment };
      setModalState((prev) => ({
        ...prev,
        selectedVote: prev.selectedVote ? { ...prev.selectedVote, comment: modalState.editingRepComment } : null,
        isEditingRepComment: false,
      }));
      // Keep the voted-badge entry in sync (legacy parity).
      setMyVotes?.((prev) => ({
        ...prev,
        [modalState.selectedVote.post_id]: updatedVote,
      }));
      showToast(t('forum.reputation_comment_updated'));
    } catch (err) {
      console.error('[update rep comment error]', err);
      showToast(err.message || 'Failed to update reputation comment', 'danger');
    } finally {
      if (isMountedRef.current) setModalState((prev) => ({ ...prev, savingRepComment: false }));
    }
  }, [modalState, setModalState, showToast, lang, isMountedRef, setMyVotes]);

  return {
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
  };
};

