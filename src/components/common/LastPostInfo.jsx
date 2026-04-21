import React from 'react';
import { Link } from 'react-router-dom';
import AuthorMeta from './AuthorMeta';
import { useAuth } from '../../contexts/AuthProvider';

const LastPostInfo = ({
  topicId,
  lastPostAt,
  authorId,
  authorCharacterId,
  isCharacter,
  authorName,
  authorAvatar,
  hasUnread,
  lastReadOffset = null,
  postsCount = 1,
  lang,
  className = ""
}) => {
  const { settings } = useAuth();
  if (!lastPostAt) return <span className="text-muted small">—</span>;

  const ITEMS_PER_PAGE = settings?.postsPerPage || 20;
  let targetUrl = `/topic/${topicId}?goLast=1`;
  
  if (hasUnread) {
    if (lastReadOffset !== null) {
      const nextIndex = lastReadOffset + 1;
      const targetPage = Math.ceil((nextIndex + 1) / ITEMS_PER_PAGE);
      targetUrl = `/topic/${topicId}?page=${targetPage}&goLast=1`;
    }
  } else {
    const lastPage = Math.max(1, Math.ceil(postsCount / ITEMS_PER_PAGE));
    targetUrl = `/topic/${topicId}?page=${lastPage}&goLast=1`;
  }

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
