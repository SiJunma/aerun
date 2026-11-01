import React from 'react';
import { Dropdown } from 'react-bootstrap';
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
      <ForumBreadcrumbs
        items={[
          ...(category ? [{ label: categoryTitle, to: `/category/${category.id}` }] : []),
          { label: topic?.title || '...', active: true }
        ]}
      />

      <div className="mb-4 topic-header-area">
        <div className="mb-2">
          <div className="d-flex align-items-center gap-2 mb-1">
            {topic.is_pinned && <Pin size={20} className="topic-indicator topic-pinned" fill="currentColor" />}
            {topic.is_locked && <Lock size={20} className="topic-indicator topic-locked" />}
            <h1 className="h2 mb-0">{topic.title}</h1>
          </div>
          {topic.description && (
            <p className="text-muted mb-0 opacity-75 topic-description" style={{ fontSize: '0.875rem' }}>
              {topic.description}
            </p>
          )}
        </div>

        <div className="d-flex flex-column flex-md-row justify-content-between align-items-md-end align-items-center gap-3">
          {/* Metadata Group */}
          <div className="d-flex align-items-center gap-2 flex-wrap flex-md-nowrap text-muted opacity-75 topic-meta-bar" style={{ fontSize: '0.875rem' }}>
            <span className="text-nowrap">
              {t('forum.author')}:{' '}
              <ForumAuthorName
                author={topic.author}
                userId={topic.author?.user_id}
                characterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                fallbackName={topic.author_name || topic.guest_nickname}
                className="fw-semibold text-primary"
              />
            </span>
            <span>·</span>
            <span className="text-nowrap">
              {lang === 'ru' ? 'Ответы' : 'Replies'}:{' '}
              <strong>{Math.max(0, (topic.posts_count || 1) - 1)}</strong>
            </span>
            <span>·</span>
            <Timestamp date={topic.created_at} />
          </div>

          {/* Actions Group (Right Side) */}
          <div className="d-flex flex-column flex-md-row align-items-center gap-2 gap-md-3">
            {(hasPermission(PERMISSIONS.PIN_TOPICS) ||
              hasPermission(PERMISSIONS.CLOSE_TOPICS) ||
              hasPermission(PERMISSIONS.MOVE_TOPICS) ||
              canDeleteTopic) && (
              <Dropdown>
                <Dropdown.Toggle
                  variant="link"
                  size="sm"
                  id="admin-topic-controls"
                  className="topic-manage-link d-flex align-items-center gap-1 text-decoration-none"
                >
                  <Settings size={14} />
                  <span>{t('forum.manage_topic')}</span>
                </Dropdown.Toggle>

                <Dropdown.Menu className="shadow-sm border-0">
                  {hasPermission(PERMISSIONS.PIN_TOPICS) && (
                    <Dropdown.Item onClick={onPinToggle} className="d-flex align-items-center gap-2">
                      <Pin size={14} />
                      {topic.is_pinned ? (lang === 'ru' ? 'Открепить' : 'Unpin') : (lang === 'ru' ? 'Закрепить' : 'Pin')}
                    </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.CLOSE_TOPICS) && (
                    <Dropdown.Item onClick={onLockToggle} className="d-flex align-items-center gap-2">
                      <Lock size={14} />
                      {topic.is_locked ? (lang === 'ru' ? 'Открыть' : 'Open') : (lang === 'ru' ? 'Закрыть' : 'Close')}
                    </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.MOVE_TOPICS) && (
                    <Dropdown.Item onClick={onOpenMoveModal} className="d-flex align-items-center gap-2">
                      <ArrowRightLeft size={14} />
                      {t('forum.move_topic')}
                    </Dropdown.Item>
                  )}
                  {hasPermission(PERMISSIONS.EDIT_OTHERS_POSTS) && (
                    <Dropdown.Item onClick={onOpenMovePostsModal} className="d-flex align-items-center gap-2">
                      <ArrowRightLeft size={14} />
                      {t('forum.move_posts')}
                    </Dropdown.Item>
                  )}
                  {canDeleteTopic && (
                    <>
                      <Dropdown.Divider />
                      <Dropdown.Item onClick={onOpenDeleteModal} className="text-danger d-flex align-items-center gap-2">
                        <Trash2 size={14} />
                        {t('forum.delete_topic')}
                      </Dropdown.Item>
                    </>
                  )}
                </Dropdown.Menu>
              </Dropdown>
            )}

            {/* Top pagination — lives inside the header's action group (legacy parity) */}
            {totalPages > 1 && (
              <div className="pagination-top">
                <ForumPagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={onPageChange}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default TopicHeader;
