import React from 'react';
import { Bell, BellOff } from 'lucide-react';
import ForumPagination from '../common/ForumPagination';

/**
 * TopicActionsBar: Pagination bar and optional follow/unfollow button for top or bottom.
 */
export const TopicActionsBar = ({
  currentPage,
  totalPages,
  onPageChange,
  position = 'top',
  showSubscription = false,
  isSubscribed = false,
  togglingSub = false,
  onToggleSubscription = null,
  t
}) => {
  if (position === 'top') {
    if (totalPages <= 1) return null;
    return (
      <ForumPagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        className="forum-pagination-topic"
      />
    );
  }

  // Bottom position
  return (
    <div className="topic-actions-row">
      {showSubscription && onToggleSubscription && (
        <div
          id="topic-actions-bottom"
          className="topic-actions"
        >
          <button
            type="button"
            className={`topic-actions-subscription ${isSubscribed ? 'is-subscribed' : ''}`}
            onClick={onToggleSubscription}
            disabled={togglingSub}
          >
            {isSubscribed ? <BellOff size={14} /> : <Bell size={14} />}
            {isSubscribed ? t?.('notifications.unfollow') || 'Unfollow' : t?.('notifications.follow') || 'Follow'}
          </button>
        </div>
      )}
      <nav
        id="topic-pagination-bottom"
        className="topic-pagination topic-pagination-bottom"
      >
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={(page) => onPageChange(page, true)}
          centered
        />
      </nav>
    </div>
  );
};

export default TopicActionsBar;
