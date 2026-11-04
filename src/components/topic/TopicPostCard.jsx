import React from 'react';
import { Card, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { Pin, Edit, Award, Send, FilePen, Dices } from 'lucide-react';
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
  topic,
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
  canDeleteTopic,
  onQuote,
  onStartEdit,
  onDeletePost,
  onPublishDraft,
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

  const authorId = post.author?.user_id || post.author?.user_id;
  const authorData = authorId === user?.uid ? profile : authorStats[authorId];
  const postCount = authorData?.post_count ?? post.author?.posts_count ?? 0;
  const reputation = authorData?.reputation ?? post.author?.reputation ?? 0;
  const liveStatus = getLiveAuthorStatus?.(post);
  const liveSignature = getLiveAuthorSignature?.(post);
  const isOnline = isAuthorOnline?.(post);

  const topicLocked = !!(topic?.is_locked);
  const canModerateLocked = hasPermission?.(PERMISSIONS.CLOSE_TOPICS);

  // Delete rights: respect topic lock, self/other delete permissions, and never
  // allow deleting the topic's first post unless the user can delete the topic.
  const isFirstPost = postNumber === 1;
  const canDeleteSelf = hasPermission?.(PERMISSIONS.DELETE_SELF_POST);
  const canDeleteOthers = hasPermission?.(PERMISSIONS.DELETE_OTHERS_POSTS);
  const canDelete = (!topicLocked || canModerateLocked)
    && (post.is_draft
      || (authorId === user?.uid ? canDeleteSelf : canDeleteOthers))
    && !(isFirstPost && !canDeleteTopic);

  const canEdit = canEditPost?.(post) && (!topicLocked || canModerateLocked);

  // Reputation voting is gated on authentication and the USE_REPUTATION permission.
  const canVote = user && hasPermission?.(PERMISSIONS.USE_REPUTATION);

  // Reputation values must be declared BEFORE `voteBadge` — the JSX below
  // evaluates `{postRepValue}` eagerly, and a later `const` would throw a
  // TDZ ReferenceError on the very first render of the card.
  const postRepValue = post.karma || 0;
  const postRepVotesCount = post.reputation_votes_count || 0;
  const userVote = post.my_vote ?? myVotes[post.id];

  const voteBadge = canVote ? (
    <div
      className="text-muted small d-flex align-items-center gap-1 rep-trigger"
      title={lang === 'ru' ? 'Репутация сообщения (Нажмите чтобы оценить)' : 'Post reputation (Click to evaluate)'}
      onClick={() => onOpenRepVote?.(post, postNumber)}
    >
      <Award size={14} className="text-accent" />
      <strong>{postRepValue}</strong>
    </div>
  ) : (
    /* Guest or missing permission: show value but block voting */
    <div
      className="text-muted small d-flex align-items-center gap-1 rep-badge-own"
      title={lang === 'ru' ? 'Репутация сообщения (Нет права на оценку)' : 'Post reputation (Voting not allowed)'}
    >
      <Award size={14} className="text-muted" style={{ opacity: 0.65 }} />
      <strong>{postRepValue}</strong>
    </div>
  );
  const canReply = hasPermission?.(PERMISSIONS.POST_REPLY, { category });

  const authorDataForDm = authorId === user?.uid ? profile : authorStats[authorId];
  const isDeletedAuthor = authorDataForDm === null || post.author?.deleted === true || post.author?.deleted === true;
  // `post.author` — the server AuthorRef DTO — carries no role at all, so the
  // old `post.author?.role_id` fallback was always undefined; the role comes
  // from the authorStats row or nothing.
  const isBannedAuthor = authorDataForDm?.role === 'banned';
  const canDm = !!(
    user &&
    authorId &&
    authorId !== user.uid &&
    hasPermission?.(PERMISSIONS.USE_DIRECT_MESSAGES) &&
    profile?.status !== 'pending' &&
    !isDeletedAuthor &&
    !isBannedAuthor
  );


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

      <Card.Body className="p-0">
        <div className="d-flex flex-column flex-md-row flex-md-nowrap">
          {/* Author Sidebar */}
          <div className="author-sidebar border-end p-2 px-md-2 pt-md-2 pb-md-0 text-center d-flex flex-column align-items-center">
            {/* Desktop Author Column */}
            <div className="d-none d-md-flex flex-column align-items-center w-100 h-100">
              <div className="fw-bold text-center mb-1 text-truncate w-100">
                <ForumAuthorName
                  userId={authorId}
                  characterId={post.author?.character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  fallbackName={post.author?.display_name}
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
                  characterId={post.author?.character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  initialAvatar={post.author?.avatar_url}
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
                  characterId={post.author?.character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  initialAvatar={post.author?.avatar_url}
                  size={60}
                  className="rounded shadow-sm"
                  isOnline={isOnline}
                />
              </div>
              <div className="flex-grow-1 text-start overflow-hidden">
                <div className="fw-bold text-truncate author-res-nickname">
                  <ForumAuthorName
                    userId={authorId}
                    characterId={post.author?.character_id}
                    isCharacter={!!post.is_character}
                    author={post.author}
                    fallbackName={post.author?.display_name}
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
              {!isDraft && (
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
              )}
              {isDraft ? (
                <>
                  <span className="badge bg-secondary" style={{ letterSpacing: '0.05em', fontSize: '0.7rem' }}>
                    <FilePen size={11} className="me-1" />
                    DRAFT
                  </span>
                  <span className="text-muted small fst-italic">
                    {lang === 'ru' ? 'только вам' : 'only visible to you'}
                  </span>
                </>
              ) : postNumber !== undefined ? (
                <div className="text-muted small opacity-50 post-number-indicator">#{postNumber}</div>
              ) : null}
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

              {/* Reputation section at bottom - matches reference HTML.
                  A draft has no karma at all — it is not published yet. */}
              {!isDraft && (post.author?.user_id || (post.rolls && Object.keys(post.rolls).length > 0)) && (
                <div className="mt-3 d-flex justify-content-between align-items-center gap-2 reputation-section">
                  {/* Dice throws sit LEFT; the karma controls stay RIGHT.
                      Guest posts render the throws too — they simply have no
                      karma controls, so the row is dice-only for them. The
                      LEFT SLOT IS ALWAYS RENDERED (empty when the post has no
                      throws) — with justify-content-between a missing left
                      child would collapse the karma badge to the left edge. */}
                  <div>
                    {post.rolls && Object.keys(post.rolls).length > 0 && (
                      <div className="small d-flex align-items-center gap-1" style={{ color: 'var(--secondary-color)' }}>
                        <Dices size={14} />
                        <span>{lang === 'ru' ? `Всего бросков: ${Object.keys(post.rolls).length}` : `Dice thrown: ${Object.keys(post.rolls).length}`}</span>
                      </div>
                    )}
                  </div>
                  <div className="d-flex justify-content-end align-items-center gap-2">
                  {/* Eye button: view who voted - only show when there are votes */}
                  {(postRepVotesCount > 0 || postRepValue !== 0) && (
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
                  )}

                  {/* Post reputation badge */}
                  {post.author?.user_id === user?.uid ? (
                      /* Own post: always show disabled award badge regardless of vote state */
                      <div
                        className="text-muted small d-flex align-items-center gap-1 rep-badge-own"
                        title={lang === 'ru' ? 'Репутация сообщения (Вы не можете голосовать за свой пост)' : 'Post reputation (You cannot vote for your own post)'}
                      >
                        <Award
                          size={14}
                          className="text-muted"
                          style={{ opacity: 0.65 }}
                        />
                        <strong>{postRepValue}</strong>
                      </div>
                    ) : userVote ? (
                      /* Already voted (current user voted) */
                      <div
                        className="small d-flex align-items-center gap-1 rep-badge-voted rep-trigger"
                        title={lang === 'ru' ? 'Вы уже оценили этот пост (Нажмите чтобы посмотреть ваш голос)' : 'You evaluated this post (Click to view your vote)'}
                        onClick={() => onShowVoteInfo?.(userVote)}
                      >
                        <Award
                          size={14}
                          className="text-success"
                        />
                        <strong>{postRepValue}</strong>
                        <span className="ms-1" style={{ fontWeight: 500, opacity: 0.9 }}>
                          {myVotes[post.id].value > 0 ? '(+1)' : '(-1)'}
                        </span>
                      </div>
                    ) : myVotes[post.id] ? (
                      /* Has voted (another user voted) - but this shouldn't happen since myVotes is per-user */
                      <div
                        className="small d-flex align-items-center gap-1 rep-badge-voted rep-trigger"
                        title={lang === 'ru' ? 'Вы уже оценили этот пост' : 'You evaluated this post'}
                      >
                        <Award
                          size={14}
                          className="text-accent"
                        />
                        <strong>{postRepValue}</strong>
                        <span className="ms-1" style={{ fontWeight: 500, opacity: 0.9 }}>
                          ({myVotes[post.id].value > 0 ? '+1' : '-1'})
                        </span>
                      </div>
                    ) : (
                      /* Can vote — gated by canVote badge computed above */
                      voteBadge
                    )}
                  </div>
                  </div>
              )}
            </div>

            {/* Footer Actions Strip */}
            {!isEditing && (
              <div className="px-2 px-md-4 mt-auto d-flex flex-wrap justify-content-between align-items-center gap-3 border-top border-top-dashed post-footer-links" style={{ height: '34px' }}>
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
                  {canDelete && onDeletePost && (
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

                  {isDraft ? (
                    <Button
                      variant="link"
                      size="sm"
                      className="footer-link p-0 text-decoration-none fw-semibold text-success"
                      onClick={() => onPublishDraft?.(post.id)}
                    >
                      <Send size={12} className="me-1" />
                      {lang === 'ru' ? 'Опубликовать' : 'Publish'}
                    </Button>
                  ) : canReply && onQuote && (
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
