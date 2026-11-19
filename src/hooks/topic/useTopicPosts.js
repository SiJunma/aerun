import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchSecuredPosts } from '../../api/forum';
import { toMillis } from '../../utils/dates';
import { getPendingOptimisticPosts, clearPendingOptimisticPost } from '../../utils/optimisticPostQueue';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * useTopicPosts: Custom hook for managing topic posts, pagination fetching,
 * optimistic posts reconciliation, and author statistics.
 */
export const useTopicPosts = ({
  topicId,
  currentPage,
  itemsPerPage,
  searchParams,
  setSearchParams,
  navigate,
  showToast,
  currentUser,
  setProfile,
  readMap,
  initialVisitMap,
  updateLocalTopicLastPost,
  topicRef
}) => {
  const [posts, setPosts] = useState([]);
  const [pinnedFirstPost, setPinnedFirstPost] = useState(null);
  const [authorStats, setAuthorStats] = useState({});
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [postsLoadError, setPostsLoadError] = useState(null);

  const { t } = useI18n();

  const activeFetchIdRef = useRef(0);
  const activeFetchPromiseRef = useRef(null);
  const isFetchingPostsRef = useRef(false);
  const loadedPageRef = useRef(null);
  const skipNextLoadForPageRef = useRef(null);
  const readCutoffRef = useRef(null);
  const locatingPostIdRef = useRef(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadPosts = useCallback(async (overridePage, silent = false) => {
    setPostsLoadError(null);
    const hasPageParam = searchParams.has('page');
    const isGoLast = searchParams.get('goLast') === '1';
    const queryPostId = searchParams.get('post');

    let pageToFetch = overridePage !== undefined ? overridePage : currentPage;
    let lastVisitMs = null;
    let targetPostId = null;

    if (overridePage === undefined && !hasPageParam) {
      if (queryPostId) {
        targetPostId = queryPostId;
        pageToFetch = 1;
      } else if (isGoLast) {
        pageToFetch = 'last';
        const lastVisitRaw = initialVisitMap?.[topicId] ?? readMap?.[topicId];
        const lastVisitVal = lastVisitRaw?.timestamp || lastVisitRaw;
        if (!lastVisitVal) {
          // Нет записи о визите → всё считается непрочитанным.
          // Чистый page=last без last_visit заставляет бэкенд вычислить
          // countBefore = totalCount - 1, что гарантированно даёт
          // последнюю страницу и последний пост темы.
          lastVisitMs = null;
        } else {
          // Есть запись о визите → тема прочитана, просим последнюю страницу явно,
          // чтобы старый last_visit не сместил выбор на страницу с первым
          // «непрочитанным» (которое уже давно прочитано).
          lastVisitMs = Date.now();
        }
      }
    }

    // skipNextLoadForPageRef guard: if this exact page was already resolved by
    // a previous setSearchParams tick (targetPostId / goLast=1 deep link), skip
    // the duplicate fetch to avoid a second network request and a skeleton flash.
    if (skipNextLoadForPageRef.current === pageToFetch) {
      skipNextLoadForPageRef.current = null;
      return [];
    }

    // In-flight deduplication: if an identical request is already traveling over
    // the network, reuse its promise instead of issuing a second parallel GET.
    const fetchKey = `${topicId}:${pageToFetch}:${itemsPerPage}:${targetPostId || ''}:${lastVisitMs || ''}`;
    if (activeFetchPromiseRef.current && activeFetchPromiseRef.current.key === fetchKey) {
      return activeFetchPromiseRef.current.promise;
    }

    const currentFetchId = ++activeFetchIdRef.current;
    isFetchingPostsRef.current = pageToFetch;
    // Каждая новая загрузка страницы — Loading-состояние: скелетон вместо
    // постов старой страницы, пока не пришёл ответ (F-01, F-04).
    // Тихая перезагрузка (приход чужого поста на той же странице) не мигает
    // скелетоном: страница остаётся на экране (stale-while-revalidate).
    if (!silent && isMountedRef.current) setIsPageLoading(true);

    const performFetch = async () => {
      try {
        return await fetchSecuredPosts(topicId, pageToFetch, itemsPerPage, lastVisitMs, targetPostId);
      } finally {
        if (activeFetchPromiseRef.current?.key === fetchKey) {
          activeFetchPromiseRef.current = null;
        }
      }
    };

    activeFetchPromiseRef.current = {
      key: fetchKey,
      promise: performFetch(),
    };

    try {
      const {
        posts: data,
        pinnedPost,
        page: resolvedPage,
        lastPost,
        readCutoff,
        targetFound,
        movedToTopicId,
        deleted
      } = await activeFetchPromiseRef.current.promise;

      // Discard stale responses from superseded requests
      if (currentFetchId !== activeFetchIdRef.current) {
        return [];
      }

      if (deleted) {
        if (isMountedRef.current) {
          setIsPageLoading(false);
        }
        return { deleted: true };
      }

      if (pageToFetch === 'last' && readCutoff) {
        readCutoffRef.current = { topicId, value: toMillis(readCutoff) };
      }

      if (lastPost && topicRef?.current) {
        updateLocalTopicLastPost?.(
          topicId,
          topicRef.current.category_id,
          topicRef.current.title,
          lastPost,
          topicRef.current.posts_count
        );
      }

      if (targetPostId) {
        if (movedToTopicId && movedToTopicId !== topicId) {
          locatingPostIdRef.current = null;
          navigate(`/topic/${movedToTopicId}?post=${targetPostId}`);
          return [];
        }
        if (targetFound === false) {
          locatingPostIdRef.current = null;
          showToast?.(t('forum.original_post_deleted'), 'warning');
          setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.delete('post');
            return next;
          }, { replace: true, preventScrollReset: true });
        } else if (resolvedPage) {
          skipNextLoadForPageRef.current = resolvedPage;
          setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            if (next.get('page') !== resolvedPage.toString()) {
              next.set('page', resolvedPage.toString());
            }
            return next;
          }, { replace: true, preventScrollReset: true });
          // The skip exists for ONE consumer: effect 16 re-running after the
          // page parameter changes. When the resolved page IS the page we are
          // already on, the URL write does not move `currentPage`, effect 16
          // never re-runs, and a skip left armed here would silently eat the
          // next unrelated fetch — the live refetch — dropping the very
          // update the reader is watching for. Disarm it immediately.
          if (resolvedPage === currentPage) {
            skipNextLoadForPageRef.current = null;
          }
        }
      } else if (resolvedPage && pageToFetch === 'last') {
        skipNextLoadForPageRef.current = resolvedPage;
        setSearchParams(prev => {
          const next = new URLSearchParams(prev);
          if (next.get('page') !== resolvedPage.toString()) {
            next.set('page', resolvedPage.toString());
          }
          return next;
        }, { replace: true, preventScrollReset: true });
        // Same disarm: a resolved page equal to the current one produces no
        // effect-16 re-run to consume the skip.
        if (resolvedPage === currentPage) {
          skipNextLoadForPageRef.current = null;
        }
      }

      const activePage = resolvedPage || (typeof pageToFetch === 'number' ? pageToFetch : 1);

      if (currentPage === activePage || pageToFetch === 'last' || targetPostId) {
        const curTopic = topicRef?.current;
        const queuedPosts = getPendingOptimisticPosts(topicId);

        // Remove from queue any post now confirmed by the server
        queuedPosts.forEach(q => {
          if (data.some(d => d.id === q.id || (q._tempId && d.id === q._tempId))) {
            clearPendingOptimisticPost(topicId, q.id);
          }
        });
        const activeQueued = getPendingOptimisticPosts(topicId);

        // Guard against premature redirect to page 1 if an optimistic post is pending on this page
        if (data.length === 0 && activePage > 1 && curTopic && activeQueued.length === 0) {
          const validMaxPage = Math.max(1, Math.ceil((curTopic.posts_count || 1) / itemsPerPage));
          if (activePage > validMaxPage) {
            setSearchParams(prev => {
              const next = new URLSearchParams(prev);
              next.set('page', validMaxPage.toString());
              return next;
            }, { replace: true });
            return [];
          }
        }

        if (!isMountedRef.current) return data;

        setPosts(prev => {
          const pending = [...prev.filter(p => p._isOptimistic), ...activeQueued];
          const uniqueOptimistic = pending.filter(p => !data.some(d => d.id === p.id));
          if (uniqueOptimistic.length === 0) return data;
          return [...data, ...uniqueOptimistic];
        });

        if (pinnedPost) {
          setPinnedFirstPost(pinnedPost);
        }

        // Reconcile the signed-in member's own post count from the server,
        // the same way authorStats is reconciled below. profile.post_count
        // is otherwise maintained ONLY by optimistic +/-1 in TopicPage, so a
        // rapid create+delete can leave it one short of the server until a
        // reload (B-05). Math.max, not the raw server value: a post created
        // locally but not yet in this server list must not make the counter
        // flicker down by one.
        if (typeof setProfile === 'function' && currentUser?.uid) {
          let ownServerPostCount = null;
          data.forEach(p => {
            if (p.author?.user_id === currentUser.uid) {
              const c = p.author?.posts_count ?? 0;
              ownServerPostCount = ownServerPostCount === null ? c : Math.max(ownServerPostCount, c);
            }
          });
          if (ownServerPostCount !== null) {
            setProfile(prev => (prev ? { ...prev, post_count: Math.max(ownServerPostCount, prev.post_count || 0) } : prev));
          }
        }

        setAuthorStats(prev => {
          const next = { ...prev };
          data.forEach(p => {
            if (p.author?.user_id) {
              const serverPostCount = p.author?.posts_count ?? 0;
              const cachedPostCount = next[p.author?.user_id]?.post_count ?? 0;
              const postCount = p.author?.user_id === currentUser?.uid
                ? Math.max(serverPostCount, cachedPostCount)
                : serverPostCount || cachedPostCount;
              const sig = p.author_signature || p.signature || p.settings?.signature || '';
              next[p.author?.user_id] = {
                ...(next[p.author?.user_id] || {}),
                post_count: postCount,
                reputation: p.author?.reputation ?? next[p.author?.user_id]?.reputation ?? 0,
                status_line: p.author_status_line !== undefined ? p.author_status_line : (next[p.author?.user_id]?.status_line ?? ''),
                role: p.author_role_id || next[p.author?.user_id]?.role || 'player',
                settings: sig
                  ? { ...(next[p.author?.user_id]?.settings || {}), signature: sig }
                  : (next[p.author?.user_id]?.settings || { signature: '' })
              };
            }
          });
          return next;
        });

        loadedPageRef.current = activePage;
        setIsPageLoading(false);
      }

      return data;
    } catch (err) {
      if (currentFetchId !== activeFetchIdRef.current) return [];
      console.error('[loadPosts error]', err);
      if (isMountedRef.current) {
        setPostsLoadError(err);
        setIsPageLoading(false);
      }
      return [];
    } finally {
      if (isFetchingPostsRef.current === pageToFetch) {
        isFetchingPostsRef.current = false;
      }
      if (isMountedRef.current) {
        setIsPageLoading(false);
      }
    }
  }, [
    topicId,
    currentPage,
    itemsPerPage,
    searchParams,
    setSearchParams,
    navigate,
    showToast,
    currentUser?.uid,
    setProfile,
    readMap,
    initialVisitMap,
    updateLocalTopicLastPost,
    topicRef,
    t
  ]);

  return {
    posts,
    setPosts,
    pinnedFirstPost,
    setPinnedFirstPost,
    authorStats,
    setAuthorStats,
    isPageLoading,
    setIsPageLoading,
    postsLoadError,
    loadPosts,
    isFetchingPostsRef,
    loadedPageRef,
    skipNextLoadForPageRef,
    readCutoffRef,
    locatingPostIdRef
  };
};

export default useTopicPosts;
