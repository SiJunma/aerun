import { useRef, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthProvider';
import { useToast } from '../../contexts/ToastProvider';
import { subscribeToCharacters } from '../../api/character';
import { useTopicData } from './useTopicData';
import { useTopicPosts } from './useTopicPosts';

/**
 * useTopicPageCore: Custom hook for the core page infrastructure.
 *
 * Encapsulates: useAuth, useTopicData, useTopicPosts, mounted/location refs,
 * and the direct stats subscription (read-contract requirement).
 */
export const useTopicPageCore = ({
  topicId,
  searchParams,
  setSearchParams,
  navigate,
  lang,
}) => {
  const {
    user,
    profile,
    setProfile,
    settings = {},
    recordActivity,
    readMap = {},
    initialVisitMap = {},
    updateLocalTopicLastPost,
    updateLocalTopicPostsCount,
    hasPermission,
    PERMISSIONS,
    isUserOnline,
    categories = [],
    setLastSelectedMask,
    markTopicRead,
    scheduleForumStateRefresh,
  } = useAuth();
  const { showToast } = useToast();

  // The member's masks. `useAuth` never carried this list — the legacy
  // monolith subscribed to it on the page itself (api/character.js's shared
  // loop), and the refactor's assumption that auth provides it left every
  // mask dropdown with a single "post as user" entry.
  const [characters, setCharacters] = useState([]);
  useEffect(() => {
    const unsub = subscribeToCharacters(user?.uid, setCharacters);
    return () => unsub();
  }, [user?.uid]);

  const ITEMS_PER_PAGE_DEFAULT = 20;
  const ITEMS_PER_PAGE = settings?.postsPerPage ?? ITEMS_PER_PAGE_DEFAULT;
  const currentPage = parseInt(searchParams.get('page') || '1', 10);

  const isMountedRef = useRef(true);
  const locationRef = useRef(searchParams);
  useEffect(() => {
    locationRef.current = searchParams;
  }, [searchParams]);

  const topicRef = useRef(null);
  const replyRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 1. Topic metadata & freshness
  const {
    topic,
    topicNotFound,
    topicRestricted,
    topicRestrictedMessage,
    accessError,
    accessErrRaw,
    isTopicLoading,
    setTopic,
    prevTopicStatsRef,
  } = useTopicData(topicId);

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
    isPageLoading,
    postsLoadError,
    isFetchingPostsRef,
    skipNextLoadForPageRef,
    loadedPageRef,
    readCutoffRef,
    locatingPostIdRef,
  } = useTopicPosts({
    topicId,
    currentPage,
    itemsPerPage: ITEMS_PER_PAGE,
    searchParams,
    setSearchParams,
    navigate,
    showToast,
    lang,
    currentUser: user,
    setProfile,
    readMap,
    initialVisitMap,
    updateLocalTopicLastPost,
    topicRef,
  });

  return {
    // Auth
    user,
    profile,
    setProfile,
    characters,
    settings,
    recordActivity,
    readMap,
    initialVisitMap,
    updateLocalTopicLastPost,
    hasPermission,
    PERMISSIONS,
    isUserOnline,
    categories,
    setLastSelectedMask,
    markTopicRead,
    updateLocalTopicPostsCount,
    // Toast
    showToast,
    // Pagination
    ITEMS_PER_PAGE,
    currentPage,
    // Refs
    isMountedRef,
    locationRef,
    topicRef,
    replyRef,
    // Data
    topic,
    topicNotFound,
    topicRestricted,
    topicRestrictedMessage,
    accessError,
    accessErrRaw,
    isTopicLoading,
    setTopic,
    prevTopicStatsRef,
    // Auth extras
    scheduleForumStateRefresh,
    // Posts
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
    readCutoffRef,
    locatingPostIdRef,
  };
};

export default useTopicPageCore;