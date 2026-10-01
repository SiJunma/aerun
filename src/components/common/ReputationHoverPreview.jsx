import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Overlay, Popover, Badge } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { fetchPostVoters } from '../../api/reputation';
import { useAuth } from '../../contexts/AuthProvider';

/**
 * ReputationHoverPreview
 * Shows a popover with the list of users who voted on a post when the user hovers over the trigger.
 * Stays open when hovering over the popover content.
 *
 * Props:
 *  - postId        {string}   required – Firestore post document ID
 *  - targetUid     {string}   required – Author of the post
 *  - children      {ReactNode} – the trigger element (e.g. the reputation badge)
 *  - lang          {string}   – 'ru' | 'en'
 *  - disabled      {boolean}  – if true, no overlay is shown (just renders children)
 */
const ReputationHoverPreview = ({ postId, targetUid, children, lang = 'ru', disabled = false }) => {
  const { user } = useAuth();
  const [show, setShow] = useState(false);
  const [voters, setVoters] = useState(null);   // null = not fetched, [] = empty
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const fetchedForRef = useRef(null);           // postId that was last fetched

  const triggerRef = useRef(null);
  const hideTimeoutRef = useRef(null);
  const showTimeoutRef = useRef(null);

  const handleMouseEnter = useCallback(async () => {
    if (disabled) return;

    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }

    if (showTimeoutRef.current) return; // already scheduling show

    showTimeoutRef.current = setTimeout(async () => {
      setShow(true);
      if (fetchedForRef.current === postId) return; // already cached

      fetchedForRef.current = postId;
      setLoading(true);
      setError(false);
      try {
        const data = await fetchPostVoters(postId, 10);
        setVoters(data.voters || []);
        setTotal(data.total || 0);
      } catch (e) {
        console.error('[ReputationHoverPreview] fetch error:', e);
        setError(true);
        fetchedForRef.current = null; // allow retry
      } finally {
        setLoading(false);
      }
    }, 200); // 200ms delay to avoid accidental triggers
  }, [postId, disabled]);

  const handleMouseLeave = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }

    if (hideTimeoutRef.current) return;

    hideTimeoutRef.current = setTimeout(() => {
      setShow(false);
    }, 300); // 300ms window to move the mouse into the popover
  }, []);

  const keepOpen = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (showTimeoutRef.current) clearTimeout(showTimeoutRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  if (disabled) return children;

  const popover = (
    <Popover
      id={`rep-preview-${postId}`}
      className="rep-preview-popover"
      onMouseEnter={keepOpen}
      onMouseLeave={handleMouseLeave}
    >
      <Popover.Body className="p-0">
        <div className="rep-preview-inner">
          {loading && (
            <div className="rep-preview-status text-muted small">
              {lang === 'ru' ? 'Загрузка...' : 'Loading...'}
            </div>
          )}

          {!loading && error && (
            <div className="rep-preview-status text-muted small">
              {lang === 'ru' ? 'Не удалось загрузить' : 'Failed to load'}
            </div>
          )}

          {!loading && !error && voters !== null && voters.length === 0 && (
            <div className="rep-preview-status text-muted small">
              {lang === 'ru' ? 'Голосов пока нет' : 'No votes yet'}
            </div>
          )}

          {!loading && !error && voters && voters.length > 0 && (
            <>
              <div className="rep-preview-title small text-muted px-3 pt-2 pb-1">
                {lang === 'ru' ? 'Проголосовали:' : 'Voted:'}
              </div>
              <ul className="rep-preview-list">
                {voters.map((v, i) => (
                  <li key={v.voter_id ?? `anon-${i}`} className="rep-preview-item">
                    <Badge
                      bg={v.value > 0 ? 'success' : 'danger'}
                      className="rep-preview-badge"
                    >
                      {v.value > 0 ? '+1' : '−1'}
                    </Badge>
                    {v.voter_id ? (
                      <div className="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
                        <Link
                          to={`/profile/${v.voter_id}`}
                          className="rep-preview-name"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {v.voter_nickname || v.voter_id}
                        </Link>
                        {targetUid && user && (
                          <Link
                            to={`/profile/${targetUid}?tab=reputation&log=${v.voter_id}_post_${postId}`}
                            className="rep-preview-detail-link ms-auto"
                            title={lang === 'ru' ? 'Посмотреть комментарий в профиле' : 'View comment in profile'}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MessageSquare size={12} />
                          </Link>
                        )}
                      </div>
                    ) : (
                      <span className="rep-preview-name text-muted">
                        {lang === 'ru' ? 'Аноним' : 'Anonymous'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {total > voters.length && (
                <div className="rep-preview-more small text-muted px-3 pb-2 pt-1 border-top mt-1">
                  {lang === 'ru'
                    ? `+${total - voters.length} ещё`
                    : `+${total - voters.length} more`}
                </div>
              )}
            </>
          )}
        </div>
      </Popover.Body>
    </Popover>
  );

  return (
    <>
      <span
        ref={triggerRef}
        className="rep-preview-trigger"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {children}
      </span>

      <Overlay
        show={show}
        target={triggerRef.current}
        placement="top"
        flip
      >
        {({ placement, arrowProps, show: _show, popper: _popper, ...props }) => {
          // Prevent React/Popper warning about ref by passing a wrapped overlay element
          return React.cloneElement(popover, {
            ...props,
            arrowProps,
            placement,
            style: {
              ...props.style,
              position: 'absolute',
            }
          });
        }}
      </Overlay>
    </>
  );
};

export default ReputationHoverPreview;
