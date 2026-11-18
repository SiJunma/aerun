import { useCallback } from 'react';

/**
 * useTopicNavigation: Custom hook for smooth scrolling, focusing on posts,
 * highlighting targets, and scrolling to the reply form.
 */
export const useTopicNavigation = () => {
  const scrollToPost = useCallback((postId, { behavior = 'smooth', block = 'start', highlight = true } = {}) => {
    if (!postId) return false;
    const el = document.getElementById(`post-${postId}`);
    if (el) {
      el.scrollIntoView({ behavior, block });
      if (highlight) {
        el.classList.add('highlight-target-post');
        setTimeout(() => {
          el.classList.remove('highlight-target-post');
        }, 2500);
      }
      return true;
    }
    return false;
  }, []);

  const scrollToReply = useCallback((replyRef) => {
    if (replyRef?.current) {
      replyRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    const formEl = document.getElementById('reply-composer-form');
    if (formEl) {
      formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    return false;
  }, []);

  return {
    scrollToPost,
    scrollToReply
  };
};

export default useTopicNavigation;
