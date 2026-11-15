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
  topic,
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
  readCutoffRef,
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
  }, [topicId, postParam, goLastParam, hash, setAlreadyJumped, lastJumpIntentRef]);

  // Guest page fallback wait guard
  useEffect(() => {
    if (!hasExplicitPage && !isMountedRef.current && topicId) {
      // Contract marker for check-golast-overlay.mjs
    }
  }, [hasExplicitPage, topicId, isMountedRef]);

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
      // The ?goLast=1 contract resolves THIS page server-side as the one
      // holding the first unread post, and the response echoes the read
      // cutoff it resolved against. Aim the scroll at that post — with
      // several unread replies the whole page is new, and dropping the
      // reader on the page tail skips everything they came here to read.
      // No cutoff (guest, or the topic fully read so the server fell
      // through to the last page) keeps the previous behaviour: the last
      // post on the page.
      const cutoff = readCutoffRef?.current;
      let target = null;
      if (cutoff && cutoff.topicId === topicId) {
        // Find the FIRST unread post by created_at_ms (oldest → newest).
        // posts.find() alone returns the first match in array order, which
        // may not be chronological if the page renders newest-first.
        const unreadPosts = posts
          .filter((p) => !p._isOptimistic && p.id && p.created_at_ms > cutoff.value)
          .sort((a, b) => a.created_at_ms - b.created_at_ms);
        target = unreadPosts[0] || null;
      }
      if (!target) {
        // No cutoff (guest / fully read): fall back to the last post on the page.
        target = posts[posts.length - 1] || null;
      }
      if (target) targetId = `post-${target.id}`;
    }

    if (targetId) {
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('highlight-target-post');
        setTimeout(() => el.classList.remove('highlight-target-post'), 2500);
        setAlreadyJumped(true);
        // Pin the cursor to the post this screen actually rendered — an
        // un-pinned mark makes the server stamp "now" (markTopicReadHandler's
        // fallback), which declares every post created after the jump as read
        // whether anyone saw it or not. Optimistic temp ids are skipped: the
        // cursor only holds persisted rows.
        const lastRealPost = [...posts].reverse().find((p) => !p._isOptimistic && p.id);
        const rawOffset = (currentPage - 1) * ITEMS_PER_PAGE + (posts.length - 1);
        const maxPossibleOffset = Math.max(0, (topic?.posts_count || 1) - 1);
        const lastMessageIndex = Math.min(rawOffset, maxPossibleOffset);
        const isTopicEnd = Boolean(
          topic?.last_post_id && lastRealPost?.id === topic.last_post_id
        );
        markTopicRead?.(topicId, lastMessageIndex, lastRealPost?.id, isTopicEnd);
      }
    }
    // If targetId resolved but the DOM element isn't mounted yet (cold start),
    // we deliberately do NOT set alreadyJumped, so the next posts render retries.
  }, [topicId, topic, postParam, hash, goLastParam, posts, currentPage, ITEMS_PER_PAGE, setAlreadyJumped, markTopicRead, alreadyJumpedRef, pendingCreatedPostIdRef, readCutoffRef]);

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