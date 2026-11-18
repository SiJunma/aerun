import React from 'react';
/**
 * Mini pagination of a topic row: [ 1 2 3 … 9 ].
 * Shared by TopicRow (active/new/subscriptions lists) and the inline
 * category-page rows (CategoryPage). Self-sufficient: reads page size
 * from settings so callers pass only the topic.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthProvider';
import Skeleton from './Skeleton';

const TopicMiniPagination = ({ topic, skeleton = false }) => {
  const { settings } = useAuth();
  if (skeleton) {
    return (
      <span className="mini-pagination">
        <span>[</span>
        <Skeleton width="22%" height="1rem" className="forum-skeleton-stat" />
        <Skeleton width="14%" height="1rem" className="forum-skeleton-stat" />
        <Skeleton width="22%" height="1rem" className="forum-skeleton-stat" />
        <span>...</span>
        <Skeleton width="14%" height="1rem" className="forum-skeleton-stat" />
        <span>]</span>
      </span>
    );
  }
  const itemsPerPage = settings?.postsPerPage || 20;
  const totalPages = Math.ceil((topic.posts_count || 1) / itemsPerPage);
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

export default TopicMiniPagination;