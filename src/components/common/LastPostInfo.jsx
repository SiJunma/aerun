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
  hasUnread,
  lang,
  className = ""
}) => {
  if (!lastPostAt) return <span className="text-muted small">—</span>;

  return (
    <Link
      to={`/topic/${topicId}?goLast=1`}
      className={`text-decoration-none d-flex align-items-center gap-1 text-muted ${className}`}
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
        lang={lang}
        className="w-100"
      />
    </Link>
  );
};

export default LastPostInfo;
