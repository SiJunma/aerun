import React from 'react';
import Timestamp from './Timestamp';
import ForumAuthorName from './ForumAuthorName';
import ForumAuthorAvatar from './ForumAuthorAvatar';

const AuthorMeta = ({
  date,
  author,          // nested AuthorRef DTO {kind, user_id, display_name, avatar_url, character_id}
  authorId,
  authorCharacterId,
  isCharacter,
  authorName,
  authorAvatar,
  showAvatar = true,
  className = "",
  onClick
}) => {
  const formatTime = (dateValue) => {
    if (!dateValue) return '—';
    try {
      const d = dateValue.toDate ? dateValue.toDate() : new Date(dateValue);
      return <Timestamp date={d} />;
    } catch {
      return '—';
    }
  };

  // The nested DTO is the contract; the explicit flat props stay as the
  // backward-compat fallback so call sites that have not been migrated keep
  // working unchanged. ?? (nullish, not truthiness) so an empty resolved value
  // is respected rather than silently replaced.
  const resolvedName = author?.display_name ?? authorName;
  const resolvedAvatar = author?.avatar_url ?? authorAvatar;
  const resolvedCharacterId = authorCharacterId ?? author?.character_id;
  const resolvedUserId = authorId ?? author?.user_id;
  const resolvedIsCharacter = isCharacter ?? (author?.kind === 'account' && !!author?.character_id);

  const avatarSize = 20;

  return (
    <div className={`author-meta ${className}`}>
      <span className="author-meta__date">{formatTime(date)}</span>

      <span className="author-meta__identity">
        {showAvatar && (
          <ForumAuthorAvatar
            author={author}
            userId={resolvedUserId}
            characterId={resolvedCharacterId}
            isCharacter={resolvedIsCharacter}
            fallbackName={resolvedName}
            initialAvatar={resolvedAvatar}
            size={avatarSize}
            roundedCircle={true}
            className="author-meta__avatar"
          />
        )}
        <ForumAuthorName
          author={author}
          fallbackName={resolvedName}
          className="author-meta__name"
          onClick={onClick}
        />
      </span>
    </div>
  );
};

export default AuthorMeta;
