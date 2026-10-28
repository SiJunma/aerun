import React from 'react';
import { Button } from 'react-bootstrap';
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
      <div className="pagination-top">
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={onPageChange}
        />
      </div>
    );
  }

  // Bottom position
  return (
    <div className="mt-4 mb-4 px-2 px-md-0">
      {showSubscription && onToggleSubscription && (
        <div className="d-flex justify-content-end mb-3">
          <Button
            variant={isSubscribed ? 'primary' : 'outline-primary'}
            size="sm"
            className="d-flex align-items-center gap-2 rounded-pill px-3 shadow-sm"
            onClick={onToggleSubscription}
            disabled={togglingSub}
          >
            {isSubscribed ? <BellOff size={14} /> : <Bell size={14} />}
            {isSubscribed ? t?.('notifications.unfollow') || 'Unfollow' : t?.('notifications.follow') || 'Follow'}
          </Button>
        </div>
      )}
      <div className="d-flex justify-content-center pagination-bottom">
        <ForumPagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={(page) => onPageChange(page, true)}
          centered
        />
      </div>
    </div>
  );
};

export default TopicActionsBar;
