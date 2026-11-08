import React from 'react';
import { Link } from 'react-router-dom';
import AuthorMeta from './AuthorMeta';

const LastPostInfo = ({
  topicId,
  lastPostAt,
  author,          // nested last-post AuthorRef DTO {kind, user_id, display_name, avatar_url, character_id}
  hasUnread,
  lang,
  className = ""
}) => {
  if (!lastPostAt) return <span className="last-post-empty">—</span>;

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
        ? (lang === 'ru' ? 'К первому непрочитанному сообщению' : 'To first unread message')
        : (lang === 'ru' ? 'К последнему сообщению' : 'To last message')
      }
    >
      {hasUnread && (
        <span
          title={lang === 'ru' ? 'Новые сообщения' : 'New posts'}
          className="unread-dot"
        />
      )}
      <AuthorMeta
        date={lastPostAt}
        author={author}
        lang={lang}
        className="last-post-meta"
      />
    </Link>
  );
};

export default LastPostInfo;