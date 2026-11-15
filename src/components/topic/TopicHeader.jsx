import React from 'react';
import { Pin, Lock, Settings, Trash2, ArrowRightLeft } from 'lucide-react';
import ForumBreadcrumbs from '../common/ForumBreadcrumbs';
import ForumPagination from '../common/ForumPagination';
import ForumAuthorName from '../common/ForumAuthorName';
import Timestamp from '../common/Timestamp';
import { resolveField } from '../../utils/text';

/**
 * TopicHeader: Topic title, metadata, breadcrumbs, and topic management actions dropdown.
 * The top pagination lives inside the header's action group (legacy monolith parity) —
 * the subscription bell intentionally lives in the BOTTOM actions bar only.
 */
export const TopicHeader = ({
  topic,
  category,
  lang,
  t,
  hasPermission,
  PERMISSIONS,
  canDeleteTopic,
  currentPage,
  totalPages,
  onPageChange,
  onPinToggle,
  onLockToggle,
  onOpenMoveModal,
  onOpenMovePostsModal,
  onOpenDeleteModal
}) => {
  if (!topic) return null;

  const categoryTitle = category ? resolveField(category.title, lang) : '...';

  return (
    <>
      <nav
        id="topic-breadcrumbs-top"
        aria-label="breadcrumb"
      >
        <ForumBreadcrumbs
          items={[
            ...(category ? [{ label: categoryTitle, to: `/category/${category.id}` }] : []),
            { label: topic?.title || '...', active: true }
          ]}
        />
      </nav>

      <header
        id="topic-header"
        className="topic-header"
      >
        <div className="topic-head">
          <div className="topic-title-row">
            {topic.is_pinned && <Pin size={20} className="topic-indicator topic-pinned" fill="currentColor" />}
            {topic.is_locked && <Lock size={20} className="topic-indicator topic-locked" />}
            <h1 className="topic-title">{topic.title}</h1>
          </div>
          {topic.description && (
            <p className="topic-description">
              {topic.description}
            </p>
          )}
        </div>

        <div className="topic-header-layout">
          {/* Metadata Group */}
          <div className="topic-meta">
            <span className="topic-meta__item">
              {t('forum.author')}:{' '}
              <ForumAuthorName
                author={topic.author}
                userId={topic.author?.user_id}
                characterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                fallbackName={topic.author_name || topic.guest_nickname}
                className="topic-author-name"
              />
            </span>
            <span className="topic-meta-separator">·</span>
            <span className="topic-meta__item text-nowrap">
              {t('forum.replies')}:{' '}
              <strong>{Math.max(0, (topic.posts_count || 1) - 1)}</strong>
            </span>
            <span className="topic-meta-separator">·</span>
            <Timestamp date={topic.created_at} />
          </div>

          {/* Actions Group (Right Side) */}
          <div id="topic-actions-top" className="topic-actions">
            {(hasPermission(PERMISSIONS.PIN_TOPICS) ||
              hasPermission(PERMISSIONS.CLOSE_TOPICS) ||
              hasPermission(PERMISSIONS.MOVE_TOPICS) ||
              canDeleteTopic) && (
              <details className="topic-manage">
                <summary className="topic-manage-link">
                  <Settings size={14} />
                  <span>{t('forum.manage_topic')}</span>
                  <span className="topic-manage-caret" aria-hidden="true" />
                </summary>

                <div className="topic-manage-menu">
                  {hasPermission(PERMISSIONS.PIN_TOPICS) && (
                    <button type="button" onClick={onPinToggle} className="topic-manage-menu__item">
                      <Pin size={14} />
                      {topic.is_pinned ? t('forum.unpin') : t('forum.pin')}
                    </button>
                  )}
                  {hasPermission(PERMISSIONS.CLOSE_TOPICS) && (
                    <button type="button" onClick={onLockToggle} className="topic-manage-menu__item">
                      <Lock size={14} />
                      {topic.is_locked ? t('forum.open') : t('forum.close')}
                    </button>
                  )}
                  {hasPermission(PERMISSIONS.MOVE_TOPICS) && (
                    <button type="button" onClick={onOpenMoveModal} className="topic-manage-menu__item">
                      <ArrowRightLeft size={14} />
                      {t('forum.move_topic')}
                    </button>
                  )}
                  {hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS) && (
                    <button type="button" onClick={onOpenMovePostsModal} className="topic-manage-menu__item">
                      <ArrowRightLeft size={14} />
                      {t('forum.move_posts')}
                    </button>
                  )}
                  {canDeleteTopic && (
                    <>
                      <hr className="topic-manage-menu__divider" />
                      <button type="button" onClick={onOpenDeleteModal} className="topic-manage-menu__item topic-manage-menu__item--danger">
                        <Trash2 size={14} />
                        {t('forum.delete_topic')}
                      </button>
                    </>
                  )}
                </div>
              </details>
            )}

            {/* Top pagination — lives inside the header's action group (legacy parity) */}
            {totalPages > 1 && (
              <ForumPagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={onPageChange}
                className="forum-pagination-topic"
              />
            )}
          </div>
        </div>
      </header>
    </>
  );
};

export default TopicHeader;
