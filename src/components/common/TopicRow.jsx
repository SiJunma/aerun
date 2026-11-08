import React from 'react';
import { Link } from 'react-router-dom';
import { Pin, Lock, MessageSquare } from 'lucide-react';
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
  // Prefer the SERVER's unread flag when present, but local session visits
  // (effectiveLastVisitMs >= lastPostMs) take immediate precedence over a stale
  // snapshot so the indicator turns off the instant the member reads the topic.
  const serverUnread = typeof topic.unread === 'boolean' ? topic.unread : null;
  const isLocallyRead = effectiveLastVisitMs >= lastPostMs;
  const isUnreadByServer = serverUnread !== null ? serverUnread : true;
  const isUnreadByState = isUnreadByServer && !isLocallyRead;
  const hasUnread = !!user && profile?.role !== 'pending' && topic.last_post_author_ref?.user_id !== user?.uid && isUnreadByState;

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
      <span className="mini-pagination">
        <span>[</span>
        {pages.map((p, i) => (
          <React.Fragment key={i}>
            {p === '...' ? (
              <span>...</span>
            ) : (
              <Link
                to={`/topic/${topic.id}?page=${p}`}
                className="mini-page-link"
              >
                {p}
              </Link>
            )}
          </React.Fragment>
        ))}
        <span>]</span>
      </span>
    );
  };

  const stateClasses = [
    topic.is_pinned ? 'is-pinned' : '',
    topic.is_locked ? 'is-locked' : '',
    hasUnread ? 'is-unread' : isUnreadByState ? 'is-new' : 'is-read',
    isSelected ? 'is-selected' : '',
    isManaging ? 'is-managing' : '',
    showCategoryInColumn ? 'has-category' : '',
  ].filter(Boolean).join(' ');

  return (
    <article
      id={`topic-${topic.id}`}
      className={`topic-item ${stateClasses}`}
      data-topic-id={topic.id}
      data-category-id={topic.category_id}
    >
      {isManaging && (
        <div className="topic-select">
          <input
            type="checkbox"
            className="topic-select-input"
            checked={isSelected}
            onChange={() => onSelect(topic.id)}
          />
        </div>
      )}
      <div className="topic-main">
        <div className="topic-head">
          {topic.is_pinned && (
            <span className="topic-icon topic-pinned" aria-hidden="true"><Pin size={14} fill="currentColor" /></span>
          )}
          {topic.is_locked && (
            <span className="topic-icon topic-locked" aria-hidden="true"><Lock size={14} /></span>
          )}
          <h3 className="topic-title">
            <Link to={`/topic/${topic.id}`} title={t('stats.to_first_post')}>
              {topic.title}
            </Link>
          </h3>
          {renderMiniPagination()}
        </div>
        {topic.description && (
          <p className="topic-description">{topic.description}</p>
        )}
        <div className="topic-meta">
          <div className="topic-author">
            <AuthorMeta
              date={topic.created_at}
              author={topic.author}
              showAvatar={false}
              lang={lang}
            />
          </div>
          {showCategory && categoryName && (
            <div className={`topic-category ${showCategoryInColumn ? 'topic-category--inline' : ''}`}>
              <Link to={`/category/${topic.category_id}`}>
                {categoryName}
              </Link>
            </div>
          )}
        </div>
        <div className="topic-mobile-stats">
          <span><MessageSquare size={12} /> {Math.max(0, (topic.posts_count || 1) - 1)}</span>
        </div>
      </div>
      {showCategoryInColumn && (
        <div
          className="topic-category"
          data-label={lang === 'ru' ? 'Категория' : 'Category'}
        >
          <Link to={`/category/${topic.category_id}`}>
            {categoryName}
          </Link>
        </div>
      )}
      <div className="topic-replies" data-label={lang === 'ru' ? 'Ответов' : 'Replies'}>
        <span className="topic-count">{Math.max(0, (topic.posts_count || 1) - 1)}</span>
      </div>
      <div className="topic-last-post" data-label={lang === 'ru' ? 'Последнее' : 'Last Post'}>
        <LastPostInfo
          topicId={topic.id}
          lastPostAt={topic.last_post_at}
          author={topic.last_post_author_ref}
          hasUnread={hasUnread}
          lastReadOffset={lastReadOffset}
          postsCount={topic.posts_count}
          lang={lang}
        />
      </div>
    </article>
  );
};

export default TopicRow;
