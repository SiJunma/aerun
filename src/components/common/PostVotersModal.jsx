import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ThumbsDown, User as UserIcon, RefreshCw } from 'lucide-react';
import { Spinner, Button } from 'react-bootstrap';
import ForumModal from './ForumModal';
import Timestamp from './Timestamp';
import { fetchPostVoters } from '../../api/reputation';
import { resolveAvatarUrl } from '../../api/avatars';

/**
 * PostVotersModal
 * Displays all evaluations and comments left for a specific post.
 */
const PostVotersModal = ({
  show,
  onHide,
  postId,
  postNumber,
  lang = 'ru'
}) => {
  const { t } = useI18n();
  const [voters, setVoters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadVoters = useCallback(async () => {
    if (!postId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPostVoters(postId, 50);
      setVoters(data?.voters || []);
    } catch (err) {
      console.error('[PostVotersModal] Failed to load voters:', err);
      setError(t('post_voters.load_error'));
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    if (show && postId) {
      loadVoters();
    } else {
      setVoters([]);
      setError(null);
    }
  }, [show, postId, loadVoters]);

  const modalTitle = t('post_voters.title', { postNumber: postNumber || '' });

  return (
    <ForumModal
      show={show}
      onHide={onHide}
      title={modalTitle}
      className="premium-modal post-voters-modal shadow-lg"
      size="md"
    >
      <div className="post-voters-scroll">
        {loading && (
          <div className="d-flex flex-column align-items-center justify-content-center py-4 gap-2 text-muted">
            <Spinner animation="border" size="sm" />
            <span className="small">{t('post_voters.loading')}</span>
          </div>
        )}

        {!loading && error && (
          <div className="text-center py-3">
            <div className="text-danger small mb-2">{error}</div>
            <Button variant="outline-secondary" size="sm" onClick={loadVoters}>
              <RefreshCw size={13} className="me-1" />
              {t('post_voters.retry')}
            </Button>
          </div>
        )}

        {!loading && !error && voters.length === 0 && (
          <div className="text-center py-4 text-muted small">
            {t('post_voters.none')}
          </div>
        )}

        {!loading && !error && voters.length > 0 && (
          <div className="d-flex flex-column gap-3">
            {voters.map((voter, idx) => {
              const isPositive = (voter.value ?? 1) > 0;
              const hasAvatar = !!voter.avatar_url;
              const voterName = voter.voter_nickname || t('post_voters.user');

              return (
                <div key={voter.log_id || voter.id || `voter-${idx}`} className="post-voter-card">
                  <div className="d-flex align-items-center gap-3">
                    {/* Avatar with Badge Overlay */}
                    <div className="post-voter-avatar-wrapper">
                      {hasAvatar ? (
                        <img
                          src={resolveAvatarUrl(voter.avatar_url)}
                          alt={voterName}
                          className="post-voter-avatar"
                        />
                      ) : (
                        <div className="post-voter-avatar-placeholder">
                          <UserIcon size={20} className="text-muted" />
                        </div>
                      )}

                      <div className={`post-voter-avatar-badge ${isPositive ? 'positive' : 'negative'}`}>
                        {isPositive ? (
                          <Heart size={10} className="post-voter-badge-heart" fill="currentColor" />
                        ) : (
                          <ThumbsDown size={10} className="post-voter-badge-minus" />
                        )}
                      </div>
                    </div>

                    {/* Nickname & Timestamp (Stacked on mobile, row on desktop) */}
                    <div className="d-flex flex-column flex-sm-row justify-content-sm-between align-items-start align-items-sm-baseline flex-grow-1 min-w-0">
                      {voter.voter_id ? (
                        <Link
                          to={`/profile/${voter.voter_id}`}
                          className="post-voter-name"
                          onClick={onHide}
                        >
                          {voterName}
                        </Link>
                      ) : (
                        <span className="post-voter-name text-muted">
                          {t('post_voters.anonymous')}
                        </span>
                      )}

                      <Timestamp date={voter.created_at} className="post-voter-date ms-0 ms-sm-2" />
                    </div>
                  </div>

                  {/* Dotted Divider & Italic Comment (only if comment exists) */}
                  {voter.comment && voter.comment.trim() && (
                    <>
                      <div className="post-voter-divider" />
                      <div className="post-voter-comment">
                        {voter.comment}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ForumModal>
  );
};

export default PostVotersModal;
