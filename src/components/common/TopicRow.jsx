import React from 'react';
import { Link } from 'react-router-dom';
import { Form, Image } from 'react-bootstrap';
import { Pin, Lock } from 'lucide-react';
import ForumAuthorName from './ForumAuthorName';
import ForumAuthorAvatar from './ForumAuthorAvatar';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

const TopicRow = ({ 
  topic, 
  user, 
  lang, 
  isManaging = false, 
  isSelected = false, 
  onSelect = () => {},
  showCategory = false,
  categoryName = ''
}) => {
  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '—';
    }
  };

  const lastVisitKey = `lastVisit_${topic.id}`;
  const lastVisit = localStorage.getItem(lastVisitKey);
  const lastPostMs = topic.last_post_at?.toMillis?.() ?? 0;
  const hasUnread = topic.last_post_author_id !== user?.uid && (!lastVisit || lastPostMs > parseInt(lastVisit, 10));

  const POSTS_PER_PAGE = 20;
  const totalPages = Math.ceil((topic.posts_count || 1) / POSTS_PER_PAGE);

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
      <span className="mini-pagination ms-2 d-none d-sm-inline-flex gap-1 align-items-center">
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
      <td>
        <div className="d-flex align-items-start gap-2">
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
              >
                {topic.title}
              </Link>
              {renderMiniPagination()}
            </div>
            {topic.description && (
              <div className="text-muted small mb-1 text-truncate" style={{ maxWidth: 480 }}>
                {topic.description}
              </div>
            )}
            <div className="d-flex align-items-center gap-1 flex-wrap">
              <small className="text-muted d-flex align-items-center gap-1">
                <ForumAuthorName
                  userId={topic.author_id}
                  characterId={topic.author_character_id}
                  isCharacter={!!topic.is_character}
                  fallbackName={topic.author_name}
                  className="fw-semibold text-secondary"
                />
                <span>·</span>
                {formatTime(topic.created_at)}
              </small>
              {showCategory && categoryName && (
                <>
                  <span className="text-muted small">·</span>
                  <Link to={`/category/${topic.category_id}`} className="text-decoration-none small text-primary opacity-75 hover-opacity-100">
                    {categoryName}
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="text-center">
        {Math.max(0, (topic.posts_count || 1) - 1)}
      </td>
      <td>
        {topic.last_post_at ? (
          <div className="d-flex flex-column flex-md-row align-items-start align-items-md-center gap-1 gap-md-2 small">
            <Link
              to={`/topic/${topic.id}?goLast=1`}
              className="text-decoration-none text-muted last-post-time text-nowrap"
            >
              {hasUnread && (
                <span
                  title={lang === 'ru' ? 'Новые сообщения' : 'New posts'}
                  className="unread-dot me-1"
                />
              )}
              {formatTime(topic.last_post_at)}
            </Link>
            
            <div className="d-flex align-items-center gap-2">
              {topic.last_post_author_id && (
                <ForumAuthorAvatar
                  userId={topic.last_post_author_id}
                  characterId={topic.last_post_author_character_id}
                  isCharacter={!!topic.last_post_is_character}
                  fallbackName={topic.last_post_author || topic.author_name}
                  size={20}
                  roundedCircle={true}
                  className="shadow-sm"
                />
              )}

              <div className="text-truncate" style={{ maxWidth: 100 }}>
                <span className="fw-semibold text-secondary">
                  {topic.last_post_author || topic.author_name}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <span className="text-muted small">—</span>
        )}
      </td>
    </tr>
  );
};

export default TopicRow;
