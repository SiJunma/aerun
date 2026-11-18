import React from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../contexts/I18nProvider';
import AuthorMeta from './AuthorMeta';

const LastPostInfo = ({
  topicId,
  lastPostAt,
  author,          // nested last-post AuthorRef DTO {kind, user_id, display_name, avatar_url, character_id}
  hasUnread,
  className = ""
}) => {
  const { t } = useI18n();
  if (!lastPostAt) return <span className="text-muted small">—</span>;

  // The page is resolved SERVER-side (?goLast=1): getSecuredPosts counts posts
  // up to the stored visit timestamp, so deleted posts, inflated read offsets
  // or stale posts_count cannot shift the target. Client-side offset math
  // clamped to the last page whenever the offset had drifted (e.g. after
  // deletions), dropping the user pages past the actual first unread post.
  // When everything is read, the server falls through to the last page.
  const targetUrl = `/topic/${topicId}?goLast=1`;

  return (
    <Link
      to={targetUrl}
      className={`last-post-link-meta ${className}`}
      title={hasUnread
        ? t('last_post.to_first_unread')
        : t('last_post.to_last')
      }
    >
      {hasUnread && (
        <span
          title={t('last_post.new_posts')}
          className="unread-dot me-1"
        />
      )}
      <AuthorMeta
        date={lastPostAt}
        author={author}
        className="last-post-meta"
      />
    </Link>
  );
};

export default LastPostInfo;