import React from 'react';
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

  // State classes for themeable DOM
  const isFirst = postNumber === 1;
  const isTopicStarter = topic && post.author?.user_id === topic.author?.user_id;
  const isEdited = !!post.edited_at && !post._isOptimistic;
  const isDeleted = post.author?.deleted === true;
  const postStateClasses = [
    isFirst ? 'is-first' : null,
    isTopicStarter ? 'is-topic-starter' : null,
    isEdited ? 'is-edited' : null,
    isDeleted ? 'is-deleted' : null,
  ].filter(Boolean).join(' ');

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
      className="post-rep__trigger"
      title={lang === 'ru' ? 'Репутация сообщения (Нажмите чтобы оценить)' : 'Post reputation (Click to evaluate)'}
      onClick={() => onOpenRepVote?.(post, postNumber)}
    >
      <Award size={14} />
      <strong>{postRepValue}</strong>
    </div>
  ) : (
    /* Guest or missing permission: show value but block voting */
    <div
      className="post-rep__own"
      title={lang === 'ru' ? 'Репутация сообщения (Нет права на оценку)' : 'Post reputation (Voting not allowed)'}
    >
      <Award size={14} />
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
    <article
      id={`post-${post.id}`}
      data-post-id={post.id}
      data-user-id={authorId}
      className={`topic-post post-${post.id} ${postStateClasses} ${isPinnedFirstPost ? 'pinned-first-post-card' : ''} ${isDraft ? 'draft-post-card' : ''}`}
    >
      {/* Pinned marker strip */}
      {isPinnedFirstPost && (
        <div className="pinned-first-post-strip">
          <Pin size={13} fill="currentColor" />
          <span className="pinned-first-post-strip__label">
            {t?.('forum.first_post_pinned_label') || 'Pinned First Post'}
          </span>
        </div>
      )}

      <div className="topic-post-inner">
        {/* Author Sidebar */}
        <aside
          className={`post-author ${isOnline ? 'is-online' : 'is-offline'}`}
          data-user-id={authorId}
          data-group-id={authorDataForDm?.role || post.author?.role_id || ''}
        >
            <div className="post-author__content">
              <div className="post-author__name">
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
                <div className="skeleton"></div>
              ) : liveStatus ? (
                <div className="post-author__status-text">{liveStatus}</div>
              ) : null}

              {/* 3. Avatar */}
              <div className="post-author__avatar">
                <ForumAuthorAvatar
                  userId={authorId}
                  characterId={post.author?.character_id}
                  isCharacter={!!post.is_character}
                  author={post.author}
                  initialAvatar={post.author?.avatar_url}
                  size={150}
                  className="post-author__avatar-img"
                  isOnline={isOnline}
                />
              </div>

              {/* 4. Posts Count */}
              {post.author?.user_id && (
                <div className="post-author__meta">
                  {t?.('profile.posts_count') || lang === 'ru' ? 'Posts' : 'Posts'}: <strong>{postCount}</strong>
                </div>
              )}

              {/* 5. Reputation */}
              {post.author?.user_id && (
                <div className="post-author__meta">
                  {t?.('profile.reputation') || lang === 'ru' ? 'Reputation' : 'Reputation'}: <strong>{reputation}</strong>
                </div>
              )}

              {/* 6. Role/Mask */}
              <div className="post-author__role">{getRoleBadge?.(post)}</div>

              {/* Desktop profile links */}
              {(() => {
                const authorDataForLinks = post.author?.user_id === user?.uid ? profile : authorStats[post.author?.user_id];
                if (!authorDataForLinks) return null;

                return (
                  <div className="post-author__contact">
                    <Link to={`/profile/${post.author?.user_id}`} className="footer-link">
                      {t?.('profile.view_profile') || 'Profile'}
                    </Link>
                    {canDm && onOpenDm && (
                      <Link to={`/messages/${post.author?.user_id}`} className="footer-link" onClick={() => onOpenDm(post.author?.user_id)}>
                        {lang === 'ru' ? 'PM' : 'PM'}
                      </Link>
                    )}
                  </div>
                );
              })()}
            </div>
          </aside>

          {/* Content Area */}
          <section className="post-body">
            {/* Header Strip: Time, # */}
            <header className="post-header">
              {!isDraft && (
                <span className="post-meta">
                  {post._isOptimistic ? (
                    <Timestamp date={post.created_at} className="post-date" />
                  ) : (
                    <a
                      href={`/topic/${topicId}?post=${post.id}`}
                      className="post-permalink"
                      onClick={(e) => {
                        e.preventDefault();
                        const url = `${window.location.origin}/topic/${topicId}?post=${post.id}`;
                        navigator.clipboard.writeText(url);
                        showToast?.(lang === 'ru' ? 'Ссылка скопирована!' : 'Link copied!', 'success');
                      }}
                    >
                      <Timestamp date={post.created_at} className="post-date" />
                    </a>
                  )}
                  {post.edited_at && !post._isOptimistic && (
                    <span className="post-date">
                      ({lang === 'ru' ? 'ред.' : 'edited'} <Timestamp date={post.edited_at} />)
                    </span>
                  )}
                </span>
              )}
              {isDraft ? (
                <>
                  <span className="post-draft-badge">
                    <FilePen size={11} />
                    DRAFT
                  </span>
                  <span className="post-date">
                    {lang === 'ru' ? 'только вам' : 'only visible to you'}
                  </span>
                </>
              ) : postNumber !== undefined ? (
                <div className="post-number">#{postNumber}</div>
              ) : null}
            </header>

            <section className="post-content">
              <div className="post-content__body">
                {isEditing && editingChildren ? (
                  editingChildren
                ) : (
                  <>
                    <div className="post-content__text">
                      <BBCode rolls={post.rolls} authorId={authorId}>
                        {post.content}
                      </BBCode>
                    </div>

                    {liveSignature && (
                      <div className="post-signature">
                        <BBCode>{liveSignature}</BBCode>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Reputation section at bottom - matches reference HTML.
                  A draft has no karma at all — it is not published yet. */}
              {!isDraft && (post.author?.user_id || (post.rolls && Object.keys(post.rolls).length > 0)) && (
                <div className="post-meta-row reputation-section">
                  {/* Dice throws sit LEFT; the karma controls stay RIGHT.
                      Guest posts render the throws too — they simply have no
                      karma controls, so the row is dice-only for them. The
                      LEFT SLOT IS ALWAYS RENDERED (empty when the post has no
                      throws) — with justify-content-between a missing left
                      child would collapse the karma badge to the left edge. */}
                  <div>
                    {post.rolls && Object.keys(post.rolls).length > 0 && (
                      <div className="post-dice">
                        <Dices size={14} />
                        <span>{lang === 'ru' ? `Всего бросков: ${Object.keys(post.rolls).length}` : `Dice thrown: ${Object.keys(post.rolls).length}`}</span>
                      </div>
                    )}
                  </div>
                  <div className="post-rep">
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
                        className="post-rep__own"
                        title={lang === 'ru' ? 'Репутация сообщения (Вы не можете голосовать за свой пост)' : 'Post reputation (You cannot vote for your own post)'}
                      >
                        <Award
                          size={14}
                        />
                        <strong>{postRepValue}</strong>
                      </div>
                    ) : userVote ? (
                      /* Already voted (current user voted) */
                      <div
                        className="post-rep__voted"
                        title={lang === 'ru' ? 'Вы уже оценили этот пост (Нажмите чтобы посмотреть ваш голос)' : 'You evaluated this post (Click to view your vote)'}
                        onClick={() => onShowVoteInfo?.(userVote)}
                      >
                        <Award
                          size={14}
                        />
                        <strong>{postRepValue}</strong>
                        <span className="post-rep__value">
                          {myVotes[post.id].value > 0 ? '(+1)' : '(-1)'}
                        </span>
                      </div>
                    ) : myVotes[post.id] ? (
                      /* Has voted (another user voted) - but this shouldn't happen since myVotes is per-user */
                      <div
                        className="post-rep__voted"
                        title={lang === 'ru' ? 'Вы уже оценили этот пост' : 'You evaluated this post'}
                      >
                        <Award
                          size={14}
                        />
                        <strong>{postRepValue}</strong>
                        <span className="post-rep__value">
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
            </section>

            {/* Footer Actions Strip */}
            {!isEditing && (
              <footer className="post-footer">
                <div className="post-footer__links">
                  <a className="author-res-footer-link footer-link" href={`/profile/${authorId}`} data-discover="true">
                    {t?.('profile.view_profile') || 'Profile'}
                  </a>
                  {canDm && onOpenDm && (
                    <a className="author-res-footer-link footer-link" href={`/messages/${authorId}`} data-discover="true" onClick={() => onOpenDm(authorId)}>
                      {lang === 'ru' ? 'PM' : 'PM'}
                    </a>
                  )}
                </div>
                <div className="post-footer__spacer"></div>
                <div className="post-footer__actions">
                  {canDelete && onDeletePost && (
                    <button
                      type="button"
                      className="footer-link footer-link--delete"
                      onClick={() => onDeletePost?.(post)}
                    >
                      {lang === 'ru' ? 'Удалить' : 'Delete'}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="footer-link"
                      onClick={() => onStartEdit?.(post, postNumber === 1)}
                    >
                      {lang === 'ru' ? 'Редактировать' : 'Edit'}
                    </button>
                  )}

                  {isDraft ? (
                    <button
                      type="button"
                      className="footer-link footer-link--publication"
                      onClick={() => onPublishDraft?.(post.id)}
                    >
                      <Send size={12} />
                      {lang === 'ru' ? 'Опубликовать' : 'Publish'}
                    </button>
                  ) : canReply && onQuote && (
                    <button
                      type="button"
                      className="footer-link footer-link--publication"
                      onClick={() => onQuote?.(post)}
                    >
                      {lang === 'ru' ? 'Цитировать' : 'Quote'}
                    </button>
                  )}
                </div>
              </footer>
            )}
          </section>
      </div>
    </article>
  );
};

export default TopicPostCard;
