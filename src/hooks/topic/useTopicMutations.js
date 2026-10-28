import { useState, useRef, useCallback } from 'react';
import { createPost, updatePost, deletePost } from '../../api/forum';
import { voteOnPost, updateReputationComment } from '../../api/reputation';
import { createInFlight, newIdempotencyKey } from '../../utils/inflight';
import { processDiceRolls } from '../../utils/dice';
import {
  saveUnsentReply,
  clearUnsentReply,
  isTopicUnavailableError,
  REASON_TOPIC_CLOSED,
  REASON_TOPIC_UNAVAILABLE
} from '../../api/unsent-replies';

/**
 * useTopicMutations: Custom hook for creating, updating, deleting posts
 * and submitting reputation votes with optimistic updates and error rescues.
 */
export const useTopicMutations = ({
  topicId,
  currentUser,
  _currentProfile,
  showToast,
  lang,
  recordActivity,
  scheduleForumStateRefresh
}) => {
  const [submittingPost, setSubmittingPost] = useState(false);
  const [submittingRep, setSubmittingRep] = useState(false);
  const replyInFlightRef = useRef(createInFlight());
  const rescueWrittenRef = useRef(null);

  // Submit reply with optimistic post generation
  const submitReply = useCallback(async ({
    content,
    selectedCharacterId,
    _selectedChar,
    guestNickname,
    onSuccess,
    onError
  }) => {
    if (!content?.trim()) return null;

    const savedReplyContent = content.trim();
    const token = replyInFlightRef.current.begin();
    if (!token) return null;

    setSubmittingPost(true);
    recordActivity?.();

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const idempotencyKey = newIdempotencyKey();

    try {
      const { content: processedContent, rolls } = processDiceRolls(savedReplyContent);

      const payload = {
        topic_id: topicId,
        content: processedContent,
        character_id: selectedCharacterId || null,
        rolls: rolls && Object.keys(rolls).length > 0 ? rolls : undefined,
        guest_nickname: !currentUser ? (guestNickname?.trim() || undefined) : undefined
      };

      const serverPost = await createPost(payload, idempotencyKey);

      clearUnsentReply({ topicId, uid: currentUser?.uid });
      scheduleForumStateRefresh?.();

      onSuccess?.(serverPost, tempId);
      return serverPost;
    } catch (err) {
      console.error('[createPost error]', err);

      if (currentUser?.uid && savedReplyContent) {
        const gone = isTopicUnavailableError(err);
        const reason = gone ? REASON_TOPIC_UNAVAILABLE : REASON_TOPIC_CLOSED;
        saveUnsentReply({
          topicId,
          uid: currentUser.uid,
          content: savedReplyContent,
          reason
        });
        rescueWrittenRef.current = { topicId, reason };
      }

      onError?.(err, tempId, savedReplyContent);
      throw err;
    } finally {
      token.release();
      setSubmittingPost(false);
    }
  }, [
    topicId,
    currentUser,
    recordActivity,
    scheduleForumStateRefresh
  ]);

  // Edit existing post
  const editPost = useCallback(async ({
    postId,
    content,
    characterId,
    existingRolls
  }) => {
    if (!content?.trim()) return null;
    try {
      const { content: processedContent, rolls: freshRolls } = processDiceRolls(content.trim());
      const mergedRolls = { ...(existingRolls || {}), ...(freshRolls || {}) };

      const updated = await updatePost(postId, {
        content: processedContent,
        character_id: characterId || null,
        rolls: Object.keys(mergedRolls).length > 0 ? mergedRolls : undefined
      });

      showToast?.(lang === 'ru' ? 'Сообщение обновлено' : 'Post updated', 'success');
      return updated;
    } catch (err) {
      console.error('[updatePost error]', err);
      showToast?.(lang === 'ru' ? 'Ошибка при редактировании сообщения' : 'Error editing post', 'danger');
      throw err;
    }
  }, [showToast, lang]);

  // Remove existing post
  const removePost = useCallback(async (postId) => {
    try {
      await deletePost(postId);
      scheduleForumStateRefresh?.();
      showToast?.(lang === 'ru' ? 'Сообщение удалено' : 'Post deleted', 'success');
    } catch (err) {
      console.error('[deletePost error]', err);
      showToast?.(err.message || 'Error deleting post', 'danger');
      throw err;
    }
  }, [scheduleForumStateRefresh, showToast, lang]);

  // Submit reputation vote on post
  const submitRepVote = useCallback(async ({
    postId,
    value,
    comment,
    voterNickname
  }) => {
    if (!postId || !currentUser?.uid) return;
    setSubmittingRep(true);
    try {
      await voteOnPost(currentUser.uid, postId, value, comment, voterNickname);
      recordActivity?.();
      showToast?.(lang === 'ru' ? 'Голос за репутацию учтен' : 'Reputation vote recorded', 'success');
    } catch (err) {
      console.error('[voteOnPost error]', err);
      showToast?.(err.message || 'Failed to submit vote', 'danger');
      throw err;
    } finally {
      setSubmittingRep(false);
    }
  }, [currentUser?.uid, recordActivity, showToast, lang]);

  // Edit reputation comment
  const editRepComment = useCallback(async (voteId, newComment) => {
    try {
      await updateReputationComment(voteId, newComment);
      showToast?.(lang === 'ru' ? 'Комментарий к репутации обновлен' : 'Reputation comment updated');
    } catch (err) {
      console.error('[updateReputationComment error]', err);
      showToast?.(err.message || 'Failed to update reputation comment', 'danger');
      throw err;
    }
  }, [showToast, lang]);

  return {
    submittingPost,
    submittingRep,
    rescueWrittenRef,
    submitReply,
    editPost,
    removePost,
    submitRepVote,
    editRepComment
  };
};

export default useTopicMutations;
