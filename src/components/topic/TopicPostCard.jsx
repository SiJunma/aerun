import React from 'react';
import { Card, Button, Badge, Dropdown } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { Pin, TrendingUp, TrendingDown, MoreHorizontal, Trash2, Edit } from 'lucide-react';
import ForumAuthorAvatar from '../common/ForumAuthorAvatar';
import ForumAuthorName from '../common/ForumAuthorName';
import Timestamp from '../common/Timestamp';
import BBCode from '../common/BBCode';

/**
 * TopicPostCard: Unified, highly performant post card matching SPEC_forum-topic-view-theme-dom.md.
 * Eliminates desktop/mobile duplicated DOM via clean responsive CSS classes.
 */
export const TopicPostCard = ({
  post,
  postNumber,
  topicId,
  isPinnedFirstPost = false,
  isDraft = false,
  isEditing = false,
  user,
  profile,
  hasPermission,
  PERMISSIONS,
  category,
  authorStats = {},
  getLiveAuthorStatus,
  getLiveAuthorSignature,
  isAuthorOnline,
  getRoleBadge,
  canEditPost,
  onQuote,
  onStartEdit,
  onDeletePost,
  onRepVote,
  onShowVoters,
  onShowVoteInfo,
  onQuoteAuthor,
  myVotes = {},
  editingChildren = null,
  lang,
  t,
  showToast
}) => {
  if (!post) return null;

  const authorId = post.author?.user_id || post.author_id;
  const authorData = authorId === user?.uid ? profile : authorStats[authorId];
  const postCount = authorData?.post_count ?? post.author?.posts_count ?? 0;
  const reputation = authorData?.reputation ?? post.author?.reputation ?? 0;
  const liveStatus = getLiveAuthorStatus?.(post);
  const liveSignature = getLiveAuthorSignature?.(post);
  const isOnline = isAuthorOnline?.(post);

  const canEdit = canEditPost?.(post);
  const canReply = hasPermission?.(PERMISSIONS.POST_REPLY, { category });

  return (
    <Card
      id={`post-${post.id}`}
      className={`mb-4 shadow-sm border-0 post-card ${isPinnedFirstPost ? 'pinned-first-post-card' : ''} ${isDraft ? 'draft-post-card' : ''}`}
    >
      {/* Pinned marker strip */}
      {isPinnedFirstPost && (
        <div className="pinned-first-post-strip d-flex align-items-center gap-2 px-3 py-1">
          <Pin size={13} fill="currentColor" />
          <span className="fw-semibold" style={{ fontSize: '0.75rem' }}>
            {t?.('forum.first_post_pinned_label') || 'Pinned First Post'}
          </span>
        </div>
      )}

      {/* Draft marker strip */}
      {isDraft && (
        <div className="draft-post-strip d-flex align-items-center gap-2 px-3 py-1 bg-warning text-dark">
          <span className="fw-semibold small">
            {lang === 'ru' ? 'Черновик (виден только вам)' : 'Draft (visible only to you)'}
          </span>
        </div>
      )}

      <Card.Body className="p-0">
        <div className="d-flex flex-column flex-md-row flex-md-nowrap">
          {/* Author Sidebar */}
          <div className="author-sidebar border-end p-2 px-md-2 pt-md-2 pb-md-0 text-center d-flex flex-column align-items-center">
            {/* Desktop Author Column */}
            <div className="d-none d-md-flex flex-column align-items-center w-100 h-100">
              <div className="fw-bold text-center mb-1 text-truncate w-100">
                <ForumAuthorName
                  userId={authorId}
                  characterId={post.author_character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  fallbackName={post.author_name}
                  onClick={onQuoteAuthor}
                />
              </div>

              {liveStatus === 'LOADING' ? (
                <div className="skeleton mb-2 mx-auto" style={{ width: '80%', height: '14px' }}></div>
              ) : liveStatus ? (
                <div className="text-primary mb-2 w-100 px-2 text-center" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                  {liveStatus}
                </div>
              ) : null}

              <div className="mb-2">
                <ForumAuthorAvatar
                  userId={authorId}
                  characterId={post.author_character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  initialAvatar={post.author_avatar}
                  size={150}
                  className="rounded shadow-sm"
                  isOnline={isOnline}
                />
              </div>

              <div className="mt-2 mb-2 text-center w-100">
                {getRoleBadge?.(post)}
              </div>

              {/* Author Stats (Posts & Rep) */}
              {authorId && (
                <div className="small text-muted mb-2 text-center w-100">
                  <div>
                    {lang === 'ru' ? 'Сообщений' : 'Posts'}: <strong>{postCount}</strong>
                  </div>
                  <div>
                    {lang === 'ru' ? 'Репутация' : 'Reputation'}: <strong>{reputation}</strong>
                  </div>
                </div>
              )}

              {authorId && (
                <div className="mt-auto border-top w-100 d-flex gap-3 justify-content-center border-top-dashed align-items-center" style={{ height: '34px' }}>
                  <Link to={`/profile/${authorId}`} className="footer-link text-decoration-none px-0">
                    {t?.('profile.view_profile') || 'Profile'}
                  </Link>
                </div>
              )}
            </div>

            {/* Mobile Author Row */}
            <div className="d-md-none d-flex flex-row align-items-center gap-2 w-100">
              <div className="author-avatar-wrapper flex-shrink-0 hide-on-extra-small-mobile">
                <ForumAuthorAvatar
                  userId={authorId}
                  characterId={post.author_character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  initialAvatar={post.author_avatar}
                  size={50}
                  className="rounded shadow-sm"
                  isOnline={isOnline}
                />
              </div>
              <div className="flex-grow-1 text-start overflow-hidden">
                <div className="fw-bold text-truncate author-res-nickname">
                  <ForumAuthorName
                    userId={authorId}
                    characterId={post.author_character_id}
                    isCharacter={!!post.is_character}
                    author={post.author}
                    fallbackName={post.author_name}
                    onClick={onQuoteAuthor}
                  />
                </div>
                {liveStatus && (
                  <div className="text-muted small text-truncate" style={{ fontSize: '0.75rem' }}>
                    {liveStatus}
                  </div>
                )}
              </div>
              <div className="text-end author-stats-group ms-auto">
                <div className="d-flex flex-column align-items-end gap-1">
                  {authorId && (
                    <div className="text-muted author-res-stat small" style={{ fontSize: '0.75rem' }}>
                      {lang === 'ru' ? 'Постов' : 'Posts'}: <strong>{postCount}</strong>
                    </div>
                  )}
                  {getRoleBadge?.(post, 'mb-0')}
                </div>
              </div>
            </div>
          </div>

          {/* Content Area */}
          <div className="d-flex flex-column flex-grow-1" style={{ minHeight: '100%', minWidth: 0 }}>
            {/* Header Strip: Timestamp & Post Number */}
            <div className="post-header-strip px-2 px-md-4 py-1 d-flex justify-content-between align-items-center">
              <small className="text-muted">
                {post._isOptimistic ? (
                  <Timestamp date={post.created_at} className="text-muted" />
                ) : (
                  <a
                    href={`/topic/${topicId}?post=${post.id}`}
                    className="text-decoration-none text-muted hover-link"
                    onClick={(e) => {
                      e.preventDefault();
                      const url = `${window.location.origin}/topic/${topicId}?post=${post.id}`;
                      navigator.clipboard.writeText(url);
                      showToast?.(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
                    }}
                  >
                    <Timestamp date={post.created_at} className="text-muted" />
                  </a>
                )}
                {post.edited_at && !post._isOptimistic && (
                  <span className="d-block d-md-inline-block ms-md-2 opacity-50">
                    ({lang === 'ru' ? 'ред.' : 'edited'} <Timestamp date={post.edited_at} />)
                  </span>
                )}
              </small>

              {postNumber !== undefined && (
                <div className="text-muted small opacity-50 post-number-indicator">
                  #{postNumber}
                </div>
              )}
            </div>

            {/* Post Body Area */}
            <div className="px-2 px-md-4 py-2 flex-grow-1 d-flex flex-column">
              <div className="flex-grow-1">
                {isEditing && editingChildren ? (
                  editingChildren
                ) : (
                  <>
                    <div className="post-content">
                      <BBCode rolls={post.rolls} authorId={authorId}>
                        {post.content}
                      </BBCode>
                    </div>

                    {liveSignature && (
                      <div className="mt-4 pt-3 border-top small text-muted opacity-75 post-signature" style={{ fontStyle: 'italic', borderTopStyle: 'dashed' }}>
                        <BBCode>{liveSignature}</BBCode>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Footer Actions Strip */}
            {!isEditing && (
              <div className="px-2 px-md-4 mt-auto d-flex flex-wrap justify-content-between align-items-center gap-3 border-top border-top-dashed post-footer-links" style={{ height: '38px' }}>
                {/* Left side: Voters badge & Rep buttons */}
                <div className="d-flex align-items-center gap-2">
                  {/* Voters count badge */}
                  {(post.reputation_votes_count > 0 || post.reputation !== 0) && (
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-decoration-none text-muted small"
                      onClick={() => onShowVoters?.(post, postNumber)}
                      title={lang === 'ru' ? 'Посмотреть кто голосовал' : 'View voters'}
                    >
                      <Badge bg={post.reputation > 0 ? 'success' : post.reputation < 0 ? 'danger' : 'secondary'} className="px-2 py-1">
                        {post.reputation > 0 ? `+${post.reputation}` : post.reputation}
                      </Badge>
                    </Button>
                  )}

                  {/* Vote Buttons (if not author and not already voted) */}
                  {user && authorId && authorId !== user.uid && !myVotes[post.id] && onRepVote && (
                    <div className="d-flex align-items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline-success"
                        className="py-0 px-1 border-0"
                        onClick={() => onRepVote(post, 1, postNumber)}
                        title={lang === 'ru' ? 'Повысить репутацию' : 'Upvote'}
                      >
                        <TrendingUp size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        className="py-0 px-1 border-0"
                        onClick={() => onRepVote(post, -1, postNumber)}
                        title={lang === 'ru' ? 'Понизить репутацию' : 'Downvote'}
                      >
                        <TrendingDown size={14} />
                      </Button>
                    </div>
                  )}

                  {/* Voted badge click to view vote info */}
                  {myVotes[post.id] && (
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 text-decoration-none"
                      onClick={() => onShowVoteInfo?.(myVotes[post.id])}
                    >
                      <Badge bg={myVotes[post.id].value > 0 ? 'success' : 'danger'} className="px-2 py-1 opacity-75">
                        {myVotes[post.id].value > 0 ? `+${myVotes[post.id].value}` : myVotes[post.id].value}
                      </Badge>
                    </Button>
                  )}
                </div>

                {/* Right side: Action buttons (Quote, Edit, Delete) */}
                <div className="d-flex align-items-center gap-2">
                  {canEdit && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0 text-decoration-none"
                      onClick={() => onStartEdit?.(post, postNumber === 1)}
                    >
                      {lang === 'ru' ? 'Редактировать' : 'Edit'}
                    </Button>
                  )}

                  {onDeletePost && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0 text-decoration-none text-danger opacity-75"
                      onClick={() => onDeletePost?.(post)}
                    >
                      {lang === 'ru' ? 'Удалить' : 'Delete'}
                    </Button>
                  )}

                  {canReply && onQuote && (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0 text-decoration-none fw-semibold"
                      onClick={() => onQuote?.(post)}
                    >
                      {lang === 'ru' ? 'Цитировать' : 'Quote'}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
};

export default TopicPostCard;
