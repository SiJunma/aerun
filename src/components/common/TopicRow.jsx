import React from 'react';
import { Link } from 'react-router-dom';
import { Pin, Lock, MessageSquare } from 'lucide-react';
import LastPostInfo from './LastPostInfo';
import AuthorMeta from './AuthorMeta';
import TopicMiniPagination from './TopicMiniPagination';
import { useAuth } from '../../contexts/AuthProvider';
import { useI18n } from '../../contexts/I18nProvider';
import { toMillis, unreadFloor } from '../../utils/dates';
import Skeleton from './Skeleton';

const TopicRow = ({ 
  topic, 
  user, 
  lang, 
  isManaging = false, 
  isSelected = false, 
  onSelect = () => {},
  showCategory = false,
  categoryName = '',
  showCategoryInColumn = false,
  skeleton = false,
}) => {
  const { t } = useI18n();
  const { readMap, profile } = useAuth();
  if (skeleton) {
    // Скелетон-ветка живого компонента: та же оболочка (.topic-item →
    // .topic-main → .topic-head/.topic-meta/.topic-mobile-stats/.topic-replies/
    // .topic-last-post), контент — полосками. Хуки читают только контекст (без
    // API-запросов), id и живых ссылок/кнопок нет.
    return (
      <article className={`topic-item ${showCategoryInColumn ? 'has-category' : ''}`}>
        <div className="topic-main">
          <div className="topic-head">
            <h6 className="topic-title">
              <Skeleton width="55%" height="1rem" />
            </h6>
            <TopicMiniPagination skeleton />
          </div>
          <div className="topic-meta">
            <div className="topic-author">
              <Skeleton width="40%" height="1rem" className="forum-skeleton-gap" />
              <Skeleton width="20%" height="1rem" />
            </div>
          </div>
          <div className="topic-mobile-stats">
            <span><Skeleton width={12} height={12} /> <Skeleton width="30%" height="1rem" /></span>
          </div>
        </div>
        {showCategoryInColumn && (
          <div className="topic-category" data-label={t('topic_row.category')}>
            <Skeleton width="60%" height="1rem" />
          </div>
        )}
        <div className="topic-replies" data-label={t('topic_row.replies')}>
          <span className="topic-count"><Skeleton width={30} height="1rem" className="forum-skeleton-stat" /></span>
        </div>
        <div className="topic-last-post last-post-strip" data-label={t('topic_row.last_post')}>
          <div className="forum-skeleton-last">
            <Skeleton variant="avatar" width={32} height={32} className="forum-skeleton-avatar" />
            <div className="forum-skeleton-last-lines">
              <Skeleton width="70%" height="0.9rem" className="forum-skeleton-gap" />
              <Skeleton width="40%" height="0.7rem" />
            </div>
          </div>
        </div>
      </article>
    );
  }
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
          <h6 className="topic-title">
            <Link to={`/topic/${topic.id}`} title={t('stats.to_first_post')}>
              {topic.title}
            </Link>
          </h6>
          <TopicMiniPagination topic={topic} />
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
        </div>
        <div className="topic-mobile-stats">
          <span><MessageSquare size={12} /> {Math.max(0, (topic.posts_count || 1) - 1)}</span>
          {/* Mobile-only category line: the dedicated .topic-category column
              is hidden on mobile, so the name lives next to the post count. */}
          {showCategory && categoryName && (
            <Link to={`/category/${topic.category_id}`} className="topic-mobile-category">
              {categoryName}
            </Link>
          )}
        </div>
      </div>
      {showCategoryInColumn && (
        <div
          className="topic-category"
          data-label={t('topic_row.category')}
        >
          <Link to={`/category/${topic.category_id}`}>
            {categoryName}
          </Link>
        </div>
      )}
      <div className="topic-replies" data-label={t('topic_row.replies')}>
        <span className="topic-count">{Math.max(0, (topic.posts_count || 1) - 1)}</span>
      </div>
      <div className="topic-last-post last-post-strip" data-label={t('topic_row.last_post')}>
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
