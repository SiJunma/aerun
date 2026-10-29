import React from 'react';
import { Card, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { Pin, Edit } from 'lucide-react';
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
  onShowVoters,
  onShowVoteInfo,
  onQuoteAuthor,
  myVotes = {},
  editingChildren = null,
  onOpenDm,
  onOpenRepVote,
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

  const authorDataForDm = authorId === user?.uid ? profile : authorStats[authorId];
  const isDeletedAuthor = authorDataForDm === null || post.author?.deleted === true || post.author_deleted === true;
  const isBannedAuthor = (authorDataForDm?.role_id || post.author_role_id) === 'banned';
  const canDm = !!(
    user &&
    authorId &&
    authorId !== user.uid &&
    hasPermission?.(PERMISSIONS.USE_DIRECT_MESSAGES) &&
    profile?.status !== 'pending' &&
    !isDeletedAuthor &&
    !isBannedAuthor
  );

  const postRepValue = post.reputation || 0;
  const postRepVotesCount = post.reputation_votes_count || 0;
  const userVote = post.my_vote ?? myVotes[post.id];

  const reputationColor = postRepValue > 0 ? 'text-success' : postRepValue < 0 ? 'text-danger' : 'text-muted';

  return (
    <Card
      id={`post-${post.id}`}
      className={`mb-4 shadow-sm border-0 post-card card ${isPinnedFirstPost ? 'pinned-first-post-card' : ''} ${isDraft ? 'draft-post-card' : ''}`}
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

              {/* 2. Status */}
              {liveStatus === 'LOADING' ? (
                <div className="skeleton mb-2 mx-auto" style={{ width: '80%', height: '14px' }}></div>
              ) : liveStatus ? (
                <div className="text-primary mb-2 w-100 px-2 text-center" style={{ fontStyle: 'italic', lineHeight: '1.2', fontSize: '0.875rem' }}>
                  {liveStatus}
                </div>
              ) : null}

              {/* 3. Avatar */}
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

              {/* 4. Posts Count */}
              {post.author?.user_id && (
                <div className="text-muted mt-1 opacity-75" style={{ fontSize: '0.775rem' }}>
                  {t?.('profile.posts_count') || lang === 'ru' ? 'Posts' : 'Posts'}: <strong>{postCount}</strong>
                </div>
              )}

              {/* 5. Reputation */}
              {post.author?.user_id && (
                <div className="text-muted" style={{ fontSize: '0.775rem' }}>
                  {t?.('profile.reputation') || lang === 'ru' ? 'Reputation' : 'Reputation'}: <strong>{reputation}</strong>
                </div>
              )}

              {/* 6. Role/Mask */}
              <div className="mt-2 mb-2 text-center w-100">{getRoleBadge?.(post)}</div>

              {/* Desktop profile links */}
              {(() => {
                const authorDataForLinks = post.author?.user_id === user?.uid ? profile : authorStats[post.author?.user_id];
                if (!authorDataForLinks) return null;

                return (
                  <div className="mt-auto border-top w-100 d-flex gap-3 justify-content-center border-top-dashed align-items-center" style={{ height: '34px' }}>
                    <Link to={`/profile/${post.author?.user_id}`} className="footer-link text-decoration-none px-0">
                      {t?.('profile.view_profile') || 'Profile'}
                    </Link>
                    {canDm && onOpenDm && (
                      <Link to={`/messages/${post.author?.user_id}`} className="footer-link text-decoration-none px-0" onClick={() => onOpenDm(post.author?.user_id)}>
                        {lang === 'ru' ? 'PM' : 'PM'}
                      </Link>
                    )}
                  </div>
                );
              })()}
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
                  size={60}
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
                    onClick={post.author?.deleted ? undefined : onQuoteAuthor}
                  />
                </div>
                {liveStatus && (
                  <div className="text-primary author-res-status" style={{ fontStyle: 'italic', lineHeight: '1.2' }}>
                    {liveStatus}
                  </div>
                )}
              </div>
              <div className="text-end author-stats-group ms-auto">
                <div className="d-flex flex-column align-items-end gap-1">
                  {post.author?.user_id && (
                    <div className="text-muted author-res-stat">
                      {lang === 'ru' ? 'Постов' : 'Posts'}: <strong className="ms-1">{postCount}</strong>
                    </div>
                  )}
                  {post.author?.user_id && (
                    <div className="text-muted author-res-stat">
                      {lang === 'ru' ? 'Реп' : 'Rep'}: <strong className="ms-1">{reputation}</strong>
                    </div>
                  )}
                  <div className="author-res-info-lite text-end">
                    {getRoleBadge?.(post, 'mb-0')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Content Area */}
          <div className="d-flex flex-column flex-grow-1" style={{ minHeight: '100%', minWidth: 0 }}>
            {/* Header Strip: Time, # */}
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
                    <span className="text-nowrap text-muted">{post.created_at}</span>
                  </a>
                )}
              </small>
              {postNumber !== undefined && (
                <div className="text-muted small opacity-50 post-number-indicator">#{postNumber}</div>
              )}
            </div>

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

              {/* Reputation section at bottom - matches reference HTML */}
              {(postRepVotesCount > 0 || postRepValue !== 0) && (
                <div className="mt-3 d-flex justify-content-end align-items-center gap-2 reputation-section">
                  {/* Eye button: view who voted */}
                  <button
                    type="button"
                    className="rep-eye-btn"
                    title={lang === 'ru' ? 'Посмотреть кто голосовал' : 'View who evaluated'}
                    onClick={() => onShowVoters?.(post, postNumber)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="lucide lucide-eye"
                      aria-hidden="true"
                    >
                      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
                      <circle cx={12} cy={12} r={3}></circle>
                    </svg>
                  </button>

                  {/* Award + value */}
                  <div
                    className="small d-flex align-items-center gap-1 rep-badge-voted rep-trigger"
                    title={userVote
                      ? (lang === 'ru' ? 'Вы оценили этот пост (Нажмите чтобы посмотреть ваш голос)' : 'You evaluated this post (Click to view your vote)')
                      : (lang === 'ru' ? 'Посмотреть кто голосовал' : 'View who evaluated')}
                    onClick={userVote ? () => onShowVoteInfo?.(userVote) : () => onOpenRepVote?.(post, postNumber)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={postRepValue > 0 ? 'currentColor' : 'currentColor'}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`lucide lucide-award ${reputationColor}`}
                      aria-hidden="true"
                    >
                      <path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"></path>
                      <circle cx={12} cy={8} r={6}></circle>
                    </svg>
                    <strong>{postRepValue}</strong>
                    <span className="ms-1" style={{ fontWeight: 500, opacity: 0.9 }}>
                      {postRepValue > 0 ? `(+${postRepValue})` : postRepValue !== 0 ? `(${postRepValue})` : '(+1)'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer Actions Strip */}
            {!isEditing && (
              <div className="px-2 px-md-4 mt-auto d-flex flex-wrap justify-content-between align-items-center gap-3 border-top border-top-dashed" style={{ height: '34px' }}>
                <div className="d-flex d-md-none gap-3">
                  <a className="author-res-footer-link" href={`/profile/${authorId}`} data-discover="true">
                    {t?.('profile.view_profile') || 'Profile'}
                  </a>
                  {canDm && onOpenDm && (
                    <a className="author-res-footer-link" href={`/messages/${authorId}`} data-discover="true" onClick={() => onOpenDm(authorId)}>
                      {lang === 'ru' ? 'PM' : 'PM'}
                    </a>
                  )}
                </div>
                <div className="d-none d-md-block"></div>
                <div className="d-flex gap-2 gap-md-3">
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
