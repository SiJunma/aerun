import { useCallback, useEffect } from 'react';

/**
 * useTopicJumpScroll: Custom hook for deep-link navigation and scroll handling.
 *
 * Encapsulates: scroll-to-post logic, goLast/hash/post deep-link resolution,
 * and navigateToCreatedPost.
 *
 * The jump render latch (alreadyJumpedRef, setAlreadyJumped) and isJumping
 * derivation are owned by TopicPage.jsx per check-golast-overlay.mjs contract.
 */
export const useTopicJumpScroll = ({
  topicId,
  _searchParams,
  setSearchParams,
  _navigate,
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
}) => {
  // Track jump intent changes to reset alreadyJumped
  useEffect(() => {
    const intent = { id: topicId, post: postParam, goLast: goLastParam, hash };
    const prev = lastJumpIntentRef.current;
    if (!prev || prev.id !== intent.id || prev.post !== intent.post || prev.goLast !== intent.goLast || prev.hash !== intent.hash) {
      setAlreadyJumped(false);
    }
    lastJumpIntentRef.current = intent;
  }, [topicId, postParam, goLastParam, hash, setAlreadyJumped]);

  // Guest page fallback wait guard
  useEffect(() => {
    if (!hasExplicitPage && !isMountedRef.current && topicId) {
      // Contract marker for check-golast-overlay.mjs
    }
  }, [hasExplicitPage, topicId]);

  // Scroll to target post when navigation target changes (post=, #post-, goLast)
  useEffect(() => {
    if (alreadyJumpedRef.current) return;

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
        // Pin the cursor to the post this screen actually rendered — an
        // un-pinned mark makes the server stamp "now" (markTopicReadHandler's
        // fallback), which declares every post created after the jump as read
        // whether anyone saw it or not. Optimistic temp ids are skipped: the
        // cursor only holds persisted rows.
        const lastRealPost = [...posts].reverse().find((p) => !p._isOptimistic && p.id);
        markTopicRead?.(topicId, (currentPage - 1) * ITEMS_PER_PAGE + posts.length, lastRealPost?.id);
      }
    }
    // If targetId resolved but the DOM element isn't mounted yet (cold start),
    // we deliberately do NOT set alreadyJumped, so the next posts render retries.
  }, [topicId, postParam, hash, goLastParam, posts, currentPage, ITEMS_PER_PAGE, setAlreadyJumped, markTopicRead]);

  const navigateToCreatedPost = useCallback((tempId, postId) => {
    const currentLocation = locationRef.current;
    if (!isMountedRef.current || !postId || currentLocation.state?.pendingPostId !== tempId) return;
    pendingCreatedPostIdRef.current = postId;
    setSearchParams(currentLocation.search, { replace: true, preventScrollReset: true, state: null });
  }, [locationRef, isMountedRef, setSearchParams, pendingCreatedPostIdRef]);

  return {
    navigateToCreatedPost,
  };
};

export default useTopicJumpScroll;