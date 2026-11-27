import React from 'react';
import { Link } from 'react-router-dom';
import { Pin, Edit, Award, Send, FilePen, Dices, Mail, Heart, User, MessageCircle, Quote, Trash2, Share2 } from 'lucide-react';
import ForumAuthorAvatar from '../common/ForumAuthorAvatar';
import ForumAuthorName from '../common/ForumAuthorName';
import Timestamp from '../common/Timestamp';
import BBCode from '../common/BBCode';
import Skeleton from '../common/Skeleton';
import { shareOrCopy } from '../../utils/share';

/**
 * TopicPostCard: semantic DOM per SPEC_forum-topic-view-theme-dom.md.
 *
 * One DOM for desktop AND mobile (no duplicated markup): the layout lives in
 * src/styles/topic-view.css — .topic-post > .topic-post-inner > .post-author +
 * .post-body > .post-header/.post-content/.post-signature/.post-meta-row/
 * .post-footer. State modifiers: .is-draft, .is-pinned-first. No bootstrap,
 * no inline styles, no utility classes — all colors are CSS variables
 * (theme-variables.css) so each theme can override them.
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
  t,
  showToast,
  skeleton = false,
  skeletonLines = 3,
}) => {
  if (skeleton) {
    // Скелетон-ветка живого компонента: та же оболочка и классы (.topic-post →
    // .topic-post-inner → .post-author 200px + .post-body), контент — полосками.
    // Нет id/якорей, нет data-хуков, нет живых ссылок/кнопок. Предзаполненный
    // текст скрыт через visibility: hidden, чтобы сохранить высоту строк.
    const lineWidths = ['100%', '100%', '85%', '60%', '40%', '100%', '70%', '45%'];
    const contentLines = Array.from({ length: Math.max(1, skeletonLines) }, (_, i) => {
      const width = lineWidths[i % lineWidths.length];
      return <Skeleton key={i} width={width} height="1.25rem" />;
    });
    return (<>
      <article className="topic-post">
        <div className="topic-post-inner">
          <aside className="post-author">
            <div className="post-author__content">
              <div className="post-author__name">
                <Skeleton width="100%" height="1rem" />
              </div>
              <div className="post-author__status">
                <Skeleton width="60%" height="0.875rem" />
              </div>
              <div className="post-author__avatar">
                {/* Размер аватара — только из CSS (.post-author__avatar-skeleton:
                    150px на десктопе, 70px на мобиле, как живой аватар).
                    Инлайн 150×150 не слушается медиазапросов и на мобиле
                    раздувал колонку аватара в огромную плашку. */}
                <Skeleton variant="avatar" className="post-author__avatar-skeleton" />
              </div>
              <dl className="post-author__meta">
                <div className="post-author__meta-row">
                  {/* Ширины в px: на мобиле dl живёт в auto-колонке грида
                      автора, и полоски в % там схлопываются в ноль. */}
                  <Skeleton width={64} height="1rem" />
                  <Skeleton width={36} height="1rem" />
                </div>
                <div className="post-author__meta-row">
                  <Skeleton width={64} height="1rem" />
                  <Skeleton width={36} height="1rem" />
                </div>
              </dl>
              <div className="post-author__role">
                <Skeleton width={84} height="1rem" />
              </div>
            </div>
          </aside>
          <div className="post-body">
            <header className="post-header">
              {/* Таймштамп слева, номер поста справа — как в живом посте.
                  Было 35% × 30px: полоска в два раза выше строки таймштампа. */}
              <Skeleton width={180} height="0.9rem" />
              <Skeleton width={40} height="0.9rem" />
            </header>
            <div className="post-content">
              <span style={{ visibility: 'hidden' }}>{' '.repeat(180)}</span>
              {contentLines}
            </div>
            <footer className="post-footer">
              <div className="post-footer__links">
                {/* Кнопки — отдельными квадратиками, а не одной сплошной
                    полоской: в живом футере это отдельные кнопки (на мобиле
                    только иконки 16px), а отступы между ними даёт gap
                    контейнера. Размер — из CSS (.post-footer__btn-skeleton). */}
                <Skeleton className="post-footer__btn-skeleton" />
                <Skeleton className="post-footer__btn-skeleton" />
              </div>
              <div className="post-footer__spacer" />
              <div className="post-footer__actions">
                <Skeleton className="post-footer__btn-skeleton" />
                <Skeleton className="post-footer__btn-skeleton" />
                <Skeleton className="post-footer__btn-skeleton" />
              </div>
            </footer>
          </div>
        </div>
      </article>
    </>);
  }
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

  // Reputation values must be declared BEFORE the JSX below — it evaluates
  // `{postRepValue}` eagerly, and a later `const` would throw a TDZ
  // ReferenceError on the very first render of the card.
  const postRepValue = post.karma || 0;
  const postRepVotesCount = post.reputation_votes_count || 0;
  const userVote = post.my_vote ?? myVotes[post.id];
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

  return (<>
    <article
      id={`post-${post.id}`}
      data-post-id={post.id}
      className={`topic-post ${isPinnedFirstPost ? 'is-pinned-first' : ''} ${isDraft ? 'is-draft' : ''}`}
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
        <aside className="post-author">
          <div className="post-author__content">
            {/* 1. Name */}
            <div className="post-author__name">
              <ForumAuthorName
                userId={authorId}
                characterId={post.author?.character_id}
                isCharacter={!!post.author?.is_character}
                author={post.author}
                fallbackName={post.author?.display_name}
                onClick={onQuoteAuthor}
              />
            </div>

            {/* 2. Status */}
            {liveStatus === 'LOADING' ? (
              <div className="skeleton post-author__status-skeleton" />
            ) : liveStatus ? (
              <div className="post-author__status">
                <span className="post-author__status-text">{liveStatus}</span>
              </div>
            ) : null}

            {/* 3. Avatar */}
            <div className="post-author__avatar">
              <ForumAuthorAvatar
                userId={authorId}
                characterId={post.author?.character_id}
                isCharacter={!!post.author?.is_character}
                author={post.author}
                initialAvatar={post.author?.avatar_url}
                size={150}
                className="post-author__avatar-img"
                isOnline={isOnline}
              />
            </div>

            {/* 4. Stats — desktop: text labels in <dl>; mobile: icons + numbers */}
            {post.author?.user_id && (
              <>
                <dl className="post-author__meta">
                  <div className="post-author__meta-row">
                    <dt className="post-author__meta-label">
                      <span className="post-author__meta-label--full">{t('forum.posts_count_label')}:</span>
                      <span className="post-author__meta-label--short">{t('forum.posts_short')}:</span>
                    </dt>
                    <dd>{postCount}</dd>
                  </div>

                  <div className="post-author__meta-row">
                    <dt className="post-author__meta-label">
                      <span className="post-author__meta-label--full">{t('forum.reputation_label')}:</span>
                      <span className="post-author__meta-label--short">{t('forum.rep_short')}:</span>
                    </dt>
                    <dd>{reputation}</dd>
                  </div>
                </dl>

                {/* Mobile: icon-only stats */}
                <div className="post-author__stats-mobile">
                  <div className="post-author__stat">
                    <Mail size={20} />
                    <span>{postCount}</span>
                  </div>
                  <div className="post-author__stat">
                    <Heart size={20} />
                    <span>{reputation}</span>
                  </div>
                </div>
              </>
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
                    <Link
                      to={`/messages/${post.author?.user_id}`}
                      className="footer-link"
                      onClick={() => onOpenDm(post.author?.user_id)}
                    >
                      {t('forum.pm_label')}
                    </Link>
                  )}
                </div>
              );
            })()}
          </div>
        </aside>

        {/* Content Area */}
        <div className="post-body">
          {/* Header Strip: Time, # / draft */}
          <header className={`post-header ${isDraft ? 'is-draft' : ''}`}>
            {!isDraft && (
              <small className="post-meta">
                {post._isOptimistic ? (
                  <Timestamp date={post.created_at} className="post-date" />
                ) : (
                  <a
                    href={`/topic/${topicId}?post=${post.id}`}
                    className="post-date post-permalink"
                    onClick={(e) => {
                      e.preventDefault();
                      const url = `${window.location.origin}/topic/${topicId}?post=${post.id}`;
                      shareOrCopy({
                        title: topic?.title || 'Post',
                        url,
                        onCopied: () => showToast?.(t('forum.link_copied'), 'success'),
                        onError: () => showToast?.(t('forum.copy_failed'), 'danger')
                      });
                    }}
                  >
                    <Timestamp date={post.created_at} className="post-date" />
                  </a>
                )}
                {post.edited_at && !post._isOptimistic && (
                  <span className="post-edited-badge">
                    {`(${t('forum.edited_label')} `}<Timestamp date={post.edited_at} />)
                  </span>
                )}
              </small>
            )}
            {isDraft ? (
              <>
                <span className="post-draft-badge">
                  <FilePen size={11} />
                  DRAFT
                </span>
                <span className="post-draft-note">{t('forum.only_you')}</span>
              </>
            ) : postNumber !== undefined ? (
              <div className="post-number">#{postNumber}</div>
            ) : null}
          </header>

          {isEditing && editingChildren ? (
            <div className="post-editor">{editingChildren}</div>
          ) : (
            <div className="post-content">
              <BBCode rolls={post.rolls} authorId={authorId} authorRole={post.author?.role}>
                {post.content}
              </BBCode>

              {liveSignature && (
                <div className="post-signature">
                  <BBCode>{liveSignature}</BBCode>
                </div>
              )}
            </div>
          )}


          {/* Reputation section at bottom - matches reference HTML.
              A draft has no karma at all — it is not published yet.
              While editing the card shows only the editor — no karma row
              (same as the footer below). */}
          {!isDraft && !isEditing && (post.author?.user_id || (post.rolls && Object.keys(post.rolls).length > 0)) && (
            <div className="post-meta-row">
              {/* Dice throws sit LEFT; the karma controls stay RIGHT.
                  Guest posts render the throws too — they simply have no
                  karma controls, so the row is dice-only for them. The
                  LEFT SLOT IS ALWAYS RENDERED (empty when the post has no
                  throws) — with justify-content-between a missing left
                  child would collapse the karma badge to the left edge. */}
              <div className="post-dice-slot">
                {post.rolls && Object.keys(post.rolls).length > 0 && (
                  <div className="post-dice">
                    <Dices size={14} />
                    <span>{t('forum.dice_total', { count: Object.keys(post.rolls).length })}</span>
                  </div>
                )}
              </div>
              <div className="post-rep">
                {/* Eye button: view who voted - only show when there are votes */}
                {(postRepVotesCount > 0 || postRepValue !== 0) && (
                  <button
                    type="button"
                    className="rep-eye-btn"
                    title={t('forum.view_voters')}
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
                      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0"></path>
                      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path>
                      <circle cx={12} cy={12} r={3}></circle>
                    </svg>
                  </button>
                )}

                {/* Post reputation badge */}
                {post.author?.user_id === user?.uid ? (
                  /* Own post: always show disabled award badge regardless of vote state */
                  <div className="post-rep__own" title={t('forum.post_reputation_own')}>
                    <Award size={14} />
                    <strong>{postRepValue}</strong>
                  </div>
                ) : userVote ? (
                  /* Already voted (current user voted) */
                  <div
                    className="post-rep__voted"
                    title={t('forum.post_reputation_voted')}
                    onClick={() => onShowVoteInfo?.(userVote)}
                  >
                    <Award size={14} />
                    <strong>{postRepValue}</strong>
                    <span className="post-rep__value">
                      {myVotes[post.id].value > 0 ? '(+1)' : '(-1)'}
                    </span>
                  </div>
                ) : myVotes[post.id] ? (
                  /* Has voted (another user voted) — this shouldn't happen since myVotes is per-user */
                  <div
                    className="post-rep__voted"
                    title={t('forum.post_reputation_voted_readonly')}
                  >
                    <Award size={14} />
                    <strong>{postRepValue}</strong>
                    <span className="post-rep__value">
                      ({myVotes[post.id].value > 0 ? '+1' : '-1'})
                    </span>
                  </div>
                ) : canVote ? (
                  /* Can vote */
                  <div
                    className="post-rep__trigger"
                    title={t('forum.post_reputation_tooltip')}
                    onClick={() => onOpenRepVote?.(post, postNumber)}
                  >
                    <Award size={14} />
                    <strong>{postRepValue}</strong>
                  </div>
                ) : (
                  /* Guest or missing permission: show value but block voting */
                  <div
                    className="post-rep__own"
                    title={t('forum.post_reputation_no_vote')}
                  >
                    <Award size={14} />
                    <strong>{postRepValue}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Footer Actions Strip */}
          {!isEditing && (
            <footer className="post-footer">
              {/* Mobile-only links (Profile/PM): the sidebar contact is hidden
                  on mobile, so the footer carries them instead. */}
              <div className="post-footer__links">
                {authorId && (
                  <Link className="footer-link footer-link--icon" to={`/profile/${authorId}`} data-discover="true">
                    <User size={16} />
                    <span className="footer-link__label">{t?.('profile.view_profile') || 'Profile'}</span>
                  </Link>
                )}
                {canDm && onOpenDm && (
                  <Link
                    className="footer-link footer-link--icon"
                    to={`/messages/${authorId}`}
                    data-discover="true"
                    onClick={() => onOpenDm(authorId)}
                  >
                    <MessageCircle size={16} />
                    <span className="footer-link__label">{t('forum.pm_label')}</span>
                  </Link>
                )}
              </div>
              <div className="post-footer__spacer" />
              <div className="post-footer__actions">
                {canDelete && onDeletePost && (
                  <button
                    type="button"
                    className="footer-link footer-link--delete footer-link--icon"
                    onClick={() => onDeletePost?.(post)}
                  >
                    <Trash2 size={16} />
                    <span className="footer-link__label">{t('forum.delete_action')}</span>
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="footer-link footer-link--edit footer-link--icon"
                    onClick={() => onStartEdit?.(post, postNumber === 1)}
                  >
                    <Edit size={16} />
                    <span className="footer-link__label">{t('forum.edit_action')}</span>
                  </button>
                )}

                {isDraft ? (
                  <button
                    type="button"
                    className="footer-link footer-link--publication footer-link--icon"
                    onClick={() => onPublishDraft?.(post.id)}
                  >
                    <Send size={16} />
                    <span className="footer-link__label">{t('forum.publish_action')}</span>
                  </button>
                ) : canReply && onQuote && (
                  <button
                    type="button"
                    className="footer-link footer-link--quote footer-link--icon"
                    onClick={() => onQuote?.(post)}
                  >
                    <Quote size={16} />
                    <span className="footer-link__label">{t('forum.quote_action')}</span>
                  </button>
                )}
              </div>
            </footer>
          )}
        </div>
      </div>
    </article>

    {/* Inline reply slot — portal target for the singleton TopicReplyComposer.
        Lives OUTSIDE the article so the post's own padding/borders never
        bleed onto the composer. Empty when no composer is portaled here. */}
    <div
      id={`inline-reply-slot-${post.id}`}
      className="inline-reply-slot"
      data-post-id={post.id}
    />
  </>);
};

export default TopicPostCard;