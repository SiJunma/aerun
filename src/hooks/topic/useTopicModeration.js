import { useCallback, useState } from 'react';

/**
 * useTopicModeration: Custom hook for topic moderation actions.
 *
 * Encapsulates: subscription toggle, pin toggle, lock toggle,
 * delete topic, move topic, move posts.
 */
export const useTopicModeration = ({
  topicId,
  topic,
  currentUser,
  _lang,
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
}) => {
  const [togglingSub, setTogglingSub] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(!!(topic?.subscribed));

  const handleToggleSubscription = useCallback(async () => {
    if (!currentUser?.uid) return;
    setTogglingSub(true);
    try {
      const active = await toggleSubscription(topicId, currentUser.uid);
      setIsSubscribed(!!active);
    } catch (err) {
      console.error('[toggleSubscription error]', err);
      showToast(t?.('forum.subscription_toggle_error') || 'Failed to toggle subscription', 'danger');
    } finally {
      if (isMountedRef.current) setTogglingSub(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, currentUser?.uid, toggleSubscription, showToast, t, isMountedRef]);

  const handlePinToggle = useCallback(async () => {
    if (!topic) return;
    const newPinned = !topic.is_pinned;
    setTopic((prev) => (prev ? { ...prev, is_pinned: newPinned } : prev));
    try {
      await updateTopic(topicId, { is_pinned: newPinned }, currentUser?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => (prev ? { ...prev, is_pinned: topic.is_pinned } : prev));
      console.error('[pin toggle error]', err);
      showToast(t?.('forum.pin_toggle_error') || 'Failed to toggle pin', 'danger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, topicId, currentUser?.uid, updateTopic, setTopic, showToast, t]);

  const handleLockToggle = useCallback(async () => {
    if (!topic) return;
    const newLocked = !topic.is_locked;
    setTopic((prev) => (prev ? { ...prev, is_locked: newLocked } : prev));
    try {
      await updateTopic(topicId, { is_locked: newLocked }, currentUser?.uid, topic.author?.user_id);
    } catch (err) {
      setTopic((prev) => (prev ? { ...prev, is_locked: topic.is_locked } : prev));
      console.error('[lock toggle error]', err);
      showToast(t?.('forum.lock_toggle_error') || 'Failed to toggle lock', 'danger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, topicId, currentUser?.uid, updateTopic, setTopic, showToast, t]);

  const handleConfirmDeleteTopic = useCallback(async () => {
    try {
      await deleteTopics([topicId], currentUser?.uid);
      navigate(`/category/${topic?.category?.id || ''}`);
    } catch (err) {
      console.error('[delete topic error]', err);
      showToast(t?.('forum.delete_topic_error') || 'Failed to delete topic', 'danger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, topic, currentUser?.uid, deleteTopics, navigate, showToast, t]);

  const handleConfirmMoveTopic = useCallback(async (targetCategoryId) => {
    if (!targetCategoryId) return;
    try {
      await moveTopics([topicId], targetCategoryId, currentUser?.uid);
      navigate(`/category/${targetCategoryId}`);
    } catch (err) {
      console.error('[move topic error]', err);
      showToast(t?.('forum.topic_move_error') || 'Failed to move topic', 'danger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, currentUser?.uid, moveTopics, navigate, showToast, t]);

  const handleConfirmMovePosts = useCallback(async (postIds, targetTopicId) => {
    if (!targetTopicId || !Array.isArray(postIds) || postIds.length === 0) return;
    try {
      await movePosts(postIds, topicId, targetTopicId, currentUser?.uid);
      showToast(t?.('forum.posts_move_success') || 'Posts moved', 'success');
    } catch (err) {
      console.error('[move posts error]', err);
      showToast(t?.('forum.posts_move_error') || 'Failed to move posts', 'danger');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, movePosts, showToast, t]);

  return {
    togglingSub,
    isSubscribed,
    setIsSubscribed,
    handleToggleSubscription,
    handlePinToggle,
    handleLockToggle,
    handleConfirmDeleteTopic,
    handleConfirmMoveTopic,
    handleConfirmMovePosts,
  };
};

export default useTopicModeration;