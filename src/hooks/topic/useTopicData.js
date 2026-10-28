import { useState, useEffect, useRef } from 'react';
import { subscribeToTopicStats } from '../../api/forum';
import { usePageTitle } from '../../contexts/TitleProvider';

/**
 * useTopicData: Custom hook for subscribing to topic metadata and live stats.
 *
 * Responsibilities:
 * - Subscribes to live topic stats via subscribeToTopicStats(id).
 * - Manages topic state, topicNotFound, accessError, and raw error objects.
 * - Prevents reference cascades when topic data hasn't structurally changed.
 * - Automatically keeps the browser page title synchronized.
 */
export const useTopicData = (id) => {
  const { setPageTitle } = usePageTitle();
  const [topic, setTopic] = useState(null);
  const [topicNotFound, setTopicNotFound] = useState(false);
  const [accessError, setAccessError] = useState(null);
  const [accessErrRaw, setAccessErrRaw] = useState(null);
  const [isTopicLoading, setIsTopicLoading] = useState(() => Boolean(id));
  const [prevId, setPrevId] = useState(id);

  if (prevId !== id) {
    setPrevId(id);
    setTopic(null);
    setTopicNotFound(false);
    setAccessError(null);
    setAccessErrRaw(null);
    setIsTopicLoading(Boolean(id));
  }

  const prevTopicStatsRef = useRef(null);

  useEffect(() => {
    if (!id) return;

    let unsubStats = null;
    let cancelled = false;

    unsubStats = subscribeToTopicStats(id, (stats, err) => {
      if (cancelled) return;
      setIsTopicLoading(false);

      if (err) {
        setAccessError(err.message || 'Access denied');
        setAccessErrRaw(err);
        return;
      }

      if (!stats) {
        setTopic(null);
        setTopicNotFound(true);
        if (unsubStats) {
          unsubStats();
          unsubStats = null;
        }
        return;
      }

      setTopic((prev) => {
        if (!prev || prev.id !== stats.id) {
          prevTopicStatsRef.current = {
            id: stats.id,
            posts_count: stats.posts_count,
            last_post_at: stats.last_post_at,
            last_post_id: stats.last_post_id
          };
          return stats;
        }

        // Nothing moved: keep the existing reference so no render cascades
        if (
          prev.posts_count === stats.posts_count &&
          prev.last_post_id === stats.last_post_id &&
          prev.last_post_at_ms === stats.last_post_at_ms &&
          prev.is_locked === stats.is_locked &&
          prev.is_pinned === stats.is_pinned &&
          prev.title === stats.title
        ) {
          return prev;
        }

        return {
          ...prev,
          ...stats,
        };
      });

      setTopicNotFound(false);
    });

    return () => {
      cancelled = true;
      if (unsubStats) {
        unsubStats();
        unsubStats = null;
      }
    };
  }, [id]);

  // Synchronize document title with topic title
  useEffect(() => {
    if (topic?.title) {
      setPageTitle(topic.title);
    }
  }, [topic?.title, setPageTitle]);

  return {
    topic,
    setTopic,
    topicNotFound,
    accessError,
    accessErrRaw,
    isTopicLoading,
    prevTopicStatsRef
  };
};

export default useTopicData;
