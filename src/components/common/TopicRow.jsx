import React from 'react';
import { Link } from 'react-router-dom';
import { Form, Image } from 'react-bootstrap';
import { Pin, Lock, MessageSquare } from 'lucide-react';
import ForumAuthorName from './ForumAuthorName';
import LastPostInfo from './LastPostInfo';
import AuthorMeta from './AuthorMeta';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { toMillis, unreadFloor } from '../../utils/dates';

const TopicRow = ({ 
  topic, 
  user, 
  lang, 
  isManaging = false, 
  isSelected = false, 
  onSelect = () => {},
  showCategory = false,
  categoryName = '',
  showCategoryInColumn = false
}) => {
  const { t } = useI18n();
  const { readMap, profile, settings } = useAuth();
  const lastVisitRaw = readMap[topic.id];
  const lastReadOffset = lastVisitRaw?.offset ?? null;
  // Handle both Firestore Timestamp (from server) and plain number (optimistic local update)
  const lastVisitValue = lastVisitRaw?.timestamp || lastVisitRaw;
  // `created_at` arrives as a plain "YYYY-MM-DD" day string from the profile DTO,
  // while the read map holds a Firestore Timestamp or an optimistic number, so
  // both terms go through the shared normaliser. Reading the day with
  // `?.toMillis?.()` as this line once did yields undefined, which floors the whole
  // unread count at the epoch instead of failing loudly.
  const effectiveLastVisitMs = unreadFloor(lastVisitValue, profile?.created_at);
  const lastPostMs = toMillis(topic.last_post_at);
  // Prefer the SERVER's unread flag when present. topicPayload now emits `unread`
  // from the same predicate that drives the badge and /new-replies, so this row
  // and those counters cannot disagree. The per-device readMap is only a FALLBACK
  // for guests and payloads that predate the field: after the PocketBase
  // migration a topic read server-side but stale in localStorage kept its dot
  // forever, and "mark all read" could not reach it. The author/role guards stay
  // because the server flag never marks my own last post unread anyway.
  const serverUnread = typeof topic.unread === 'boolean' ? topic.unread : null;
  const isUnreadByState = serverUnread !== null ? serverUnread : lastPostMs > effectiveLastVisitMs;
  const hasUnread = !!user && profile?.role_id !== 'pending' && topic.last_post_author_id !== user?.uid && isUnreadByState;

  const ITEMS_PER_PAGE = settings?.postsPerPage || 20;
  const totalPages = Math.ceil((topic.posts_count || 1) / ITEMS_PER_PAGE);

  const renderMiniPagination = () => {
    if (totalPages <= 1) return null;

    const pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1, 2, 3);
      pages.push('...');
      pages.push(totalPages);
    }

    return (
      <span className="mini-pagination ms-2 d-inline-flex gap-1 align-items-center">
        <span className="text-muted" style={{ fontSize: '0.75rem' }}>[</span>
        {pages.map((p, i) => (
          <React.Fragment key={i}>
            {p === '...' ? (
              <span className="text-muted" style={{ fontSize: '0.75rem' }}>...</span>
            ) : (
              <Link 
                to={`/topic/${topic.id}?page=${p}`} 
                className="mini-page-link text-decoration-none"
              >
                {p}
              </Link>
            )}
          </ React.Fragment>
        ))}
        <span className="text-muted" style={{ fontSize: '0.75rem' }}>]</span>
      </span>
    );
  };

  return (
    <tr className={`${isSelected ? 'table-active' : ''} topic-row-hover`}>
      {isManaging && (
        <td>
          <Form.Check 
            type="checkbox"
            checked={isSelected}
            onChange={() => onSelect(topic.id)}
          />
        </td>
      )}
      <td data-label={lang === 'ru' ? 'Тема' : 'Topic'}>
        <div className="d-flex align-items-start gap-2 topic-main-cell">
          <div className="flex-grow-1">
            <div className="d-flex align-items-center flex-wrap gap-2 mb-1">
              {topic.is_pinned && (
                <Pin size={14} className="topic-indicator topic-pinned" fill="currentColor" />
              )}
              {topic.is_locked && (
                <Lock size={14} className="topic-indicator topic-locked" />
              )}
              <Link
                to={`/topic/${topic.id}`}
                className="fw-bold d-block text-decoration-none h6 mb-0 topic-title-link"
                title={t('stats.to_first_post')}
              >
                {topic.title}
              </Link>
              {renderMiniPagination()}
            </div>
            {topic.description && (
              <div className="text-muted small mb-1 topic-desc-text">
                {topic.description}
              </div>
            )}
            <div className="d-flex flex-column flex-sm-row align-items-start align-items-sm-center gap-1 mt-1">
            <div className="d-none d-md-block mt-1">
              <AuthorMeta
                date={topic.created_at}
                author={topic.author}
                authorId={topic.author_id}
                authorCharacterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                authorName={topic.author_name}
                authorAvatar={topic.author_avatar}
                showAvatar={false}
                lang={lang}
              />
            </div>
              {showCategory && categoryName && (
                <div className={`d-flex align-items-center gap-1 ${showCategoryInColumn ? 'd-md-none' : ''}`}>
                  <span className="text-muted small d-none d-sm-inline">·</span>
                  <Link to={`/category/${topic.category_id}`} className="text-decoration-none small text-primary hover-opacity-100">
                    {categoryName}
                  </Link>
                </div>
              )}
            </div>
            {/* Mobile Replies Line */}
            <div className="d-md-none mt-2 d-flex gap-3 small forum-mobile-stats text-muted">
              <span className="d-flex align-items-center gap-1">
                <MessageSquare size={12} /> {Math.max(0, (topic.posts_count || 1) - 1)}
              </span>
            </div>
          </div>
        </div>
      </td>
      {showCategoryInColumn && (
        <td className="d-none d-md-table-cell align-middle" data-label={lang === 'ru' ? 'Категория' : 'Category'}>
          <Link to={`/category/${topic.category_id}`} className="text-decoration-none small text-muted hover-opacity-100">
            {categoryName}
          </Link>
        </td>
      )}
      <td className="text-center forum-td-stat" data-label={lang === 'ru' ? 'Ответов' : 'Replies'}>
        <div className="d-flex align-items-center justify-content-center">
          <span className="topic-count-val">{Math.max(0, (topic.posts_count || 1) - 1)}</span>
        </div>
      </td>
      <td data-label={lang === 'ru' ? 'Последнее' : 'Last Post'}>
        <LastPostInfo
          topicId={topic.id}
          lastPostAt={topic.last_post_at}
          author={topic.last_post_author_ref}
          authorId={topic.last_post_author_id}
          authorCharacterId={topic.last_post_author_character_id}
          isCharacter={!!topic.last_post_is_character}
          authorName={topic.last_post_author}
          authorAvatar={topic.last_post_author_avatar}
          hasUnread={hasUnread}
          lastReadOffset={lastReadOffset}
          postsCount={topic.posts_count}
          lang={lang}
        />
      </td>
    </tr>
  );
};

export default TopicRow;
