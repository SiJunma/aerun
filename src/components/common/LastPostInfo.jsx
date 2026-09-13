import React from 'react';
import { Link } from 'react-router-dom';
import AuthorMeta from './AuthorMeta';

const LastPostInfo = ({
  topicId,
  lastPostAt,
  authorId,
  authorCharacterId,
  isCharacter,
  authorName,
  authorAvatar,
  hasUnread,
  lang,
  className = ""
}) => {
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
      className={`text-decoration-none d-flex align-items-center gap-1 text-muted last-post-link-meta ${className}`}
      title={hasUnread
        ? (lang === 'ru' ? 'К первому непрочитанному сообщению' : 'To first unread message')
        : (lang === 'ru' ? 'К последнему сообщению' : 'To last message')
      }
    >
      {hasUnread && (
        <span
          title={lang === 'ru' ? 'Новые сообщения' : 'New posts'}
          className="unread-dot me-1"
        />
      )}
      <AuthorMeta
        date={lastPostAt}
        authorId={authorId}
        authorCharacterId={authorCharacterId}
        isCharacter={isCharacter}
        authorName={authorName}
        authorAvatar={authorAvatar}
        lang={lang}
        className="w-100"
      />
    </Link>
  );
};

export default LastPostInfo;