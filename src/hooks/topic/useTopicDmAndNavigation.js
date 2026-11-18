import { useCallback } from 'react';

/**
 * useTopicDmAndNavigation: Custom hook for DM navigation and page change handlers.
 *
 * Encapsulates: handleOpenDm, onPageChange
 */
export const useTopicDmAndNavigation = ({
  navigate,
  searchParams,
  setSearchParams,
  user,
}) => {
  const handleOpenDm = useCallback((targetUid) => {
    if (!targetUid || targetUid === user?.uid) return;
    navigate(`/messages/${targetUid}`);
  }, [navigate, user]);

  const onPageChange = useCallback((page, shouldScrollTop = false) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', String(page));
    next.delete('goLast');
    setSearchParams(next, { replace: true });
    if (shouldScrollTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [searchParams, setSearchParams]);

  return {
    handleOpenDm,
    onPageChange,
  };
};

export default useTopicDmAndNavigation;