import { useState, useRef, useCallback } from 'react';
import { createPost, updatePost, deletePost } from '../../api/forum';
import { voteOnPost, updateReputationComment } from '../../api/reputation';
import { createInFlight, newIdempotencyKey } from '../../utils/inflight';
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
    tempId: providedTempId,
    onSuccess,
    onError
  }) => {
    if (!content?.trim()) return null;

    const savedReplyContent = content.trim();
    if (!replyInFlightRef.current.begin()) return null;

    setSubmittingPost(true);
    recordActivity?.();

    // USE THE CALLER'S temp id when given: the optimistic card on the page
    // was appended under THAT id, and the reconcile below (onSuccess)
    // replaces by it. A second, hook-local id made the replacement miss —
    // the page's optimistic card stayed "pending" beside the server row,
    // and the next posts merge kept both: the moved-opener duplicate.
    const tempId = providedTempId || `temp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const idempotencyKey = newIdempotencyKey();

    try {
      // SEC-08: the raw reply content — with [dice=N] tags UNREWRITTEN —
      // is the body. processDiceRolls only rewrites them into [roll=id]
      // references so the optimistic card has something to paint; its
      // `rolls` map is provisional and never becomes the request body.
      // The server (forum.MintDice) re-parses the raw tags and generates
      // the real values with crypto/rand.
      const payload = {
        topic_id: topicId,
        content: savedReplyContent,
        character_id: selectedCharacterId || null,
        guest_nickname: !currentUser ? (guestNickname?.trim() || undefined) : undefined
      };

      const serverPost = await createPost(payload, idempotencyKey);

      // Positional signature: (topicId, uid) — see src/api/unsent-replies.js.
      // An object call silently no-ops (uid would be undefined).
      clearUnsentReply(topicId, currentUser?.uid);
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
      // createInFlight().begin() returns a BOOLEAN — the latch is released
      // via end() on the latch object itself, not via a token handle.
      replyInFlightRef.current.end();
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
      // SEC-08: edit sends the RAW body, exactly as on create. The
      // server freezes existing values and throws each fresh [dice=N]
      // tag with crypto/rand. Client-side merging of optimistic maps
      // was the forgery shape this step removes.
      const updated = await updatePost(postId, content.trim(), {
        author_character_id: characterId || ''
      });

      // Toasts belong to the caller (useTopicModalState.handleSaveEdit) —
      // toasting here AND there produced duplicate "Post updated" toasts.
      return updated;
    } catch (err) {
      console.error('[updatePost error]', err);
      throw err;
    }
  }, []);

  // Remove existing post
  const removePost = useCallback(async (postId) => {
    try {
      const result = await deletePost({ id: postId }, currentUser?.uid);
      scheduleForumStateRefresh?.();
      // Toasts belong to the caller — the delete flow decides between the
      // success text and the ghost-post notice.
      return result;
    } catch (err) {
      console.error('[deletePost error]', err);
      throw err;
    }
  }, [scheduleForumStateRefresh, currentUser?.uid]);

  // Submit reputation vote on post
  const submitRepVote = useCallback(async ({
    postId,
    targetUid,
    value,
    comment,
    voterNickname
  }) => {
    if (!postId || !currentUser?.uid || !targetUid) return;
    setSubmittingRep(true);
    try {
      await voteOnPost(currentUser.uid, targetUid, postId, topicId, value, comment, undefined, undefined, voterNickname);
      recordActivity?.();
      showToast?.(lang === 'ru' ? 'Голос за репутацию учтен' : 'Reputation vote recorded', 'success');
    } catch (err) {
      console.error('[voteOnPost error]', err);
      showToast?.(err.message || 'Failed to submit vote', 'danger');
      throw err;
    } finally {
      setSubmittingRep(false);
    }
  }, [currentUser?.uid, topicId, recordActivity, showToast, lang]);

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
