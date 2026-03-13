import React from 'react';
import { Link } from 'react-router-dom';
import { Form, Image } from 'react-bootstrap';
import { Pin, Lock } from 'lucide-react';
import ForumAuthorName from './ForumAuthorName';
import LastPostInfo from './LastPostInfo';
import AuthorMeta from './AuthorMeta';

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
      <td style={{ minWidth: '280px', maxWidth: '100vw' }}>
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
            <div className="d-flex flex-column flex-sm-row align-items-start align-items-sm-center gap-1 mt-1">
              <AuthorMeta
                date={topic.created_at}
                authorId={topic.author_id}
                authorCharacterId={topic.author_character_id}
                isCharacter={!!topic.is_character}
                authorName={topic.author_name}
                lang={lang}
              />
              {showCategory && categoryName && (
                <div className="d-flex align-items-center gap-1">
                  <span className="text-muted small d-none d-sm-inline">·</span>
                  <Link to={`/category/${topic.category_id}`} className="text-decoration-none small text-primary opacity-75 hover-opacity-100">
                    {categoryName}
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
      <td className="text-center">
        {Math.max(0, (topic.posts_count || 1) - 1)}
      </td>
      <td>
        <LastPostInfo
          topicId={topic.id}
          lastPostAt={topic.last_post_at}
          authorId={topic.last_post_author_id}
          authorCharacterId={topic.last_post_author_character_id}
          isCharacter={!!topic.last_post_is_character}
          authorName={topic.last_post_author || topic.author_name}
          hasUnread={hasUnread}
          lang={lang}
        />
      </td>
    </tr>
  );
};

export default TopicRow;
