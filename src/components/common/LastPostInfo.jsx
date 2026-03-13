import React from 'react';
import { Link } from 'react-router-dom';
import ForumAuthorAvatar from './ForumAuthorAvatar';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';

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
  const formatTime = (timestamp) => {
    if (!timestamp) return '—';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return format(date, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '—';
    }
  };

  if (!lastPostAt) return <span className="text-muted small">—</span>;

  return (
    <Link
      to={`/topic/${topicId}?goLast=1`}
      className={`text-decoration-none d-flex flex-column flex-md-row align-items-start align-items-md-center gap-1 gap-md-2 text-muted small ${className}`}
    >
      <span className="text-nowrap d-flex align-items-center">
        {hasUnread && (
          <span
            title={lang === 'ru' ? 'Новые сообщения' : 'New posts'}
            className="unread-dot me-1"
          />
        )}
        {formatTime(lastPostAt)}
      </span>

      <div className="d-flex align-items-center gap-2">
        {authorId && (
          <ForumAuthorAvatar
            userId={authorId}
            characterId={authorCharacterId}
            isCharacter={isCharacter}
            fallbackName={authorName}
            size={20}
            roundedCircle={true}
            className="shadow-sm"
          />
        )}
        <div className="text-truncate" style={{ maxWidth: 100 }}>
          <span className="fw-semibold text-secondary">
            {authorName}
          </span>
        </div>
      </div>
    </Link>
  );
};

export default LastPostInfo;
