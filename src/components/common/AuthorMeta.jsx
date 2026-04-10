import React from 'react';
import Timestamp from './Timestamp';
import ForumAuthorName from './ForumAuthorName';
import ForumAuthorAvatar from './ForumAuthorAvatar';

const AuthorMeta = ({
  date,
  authorId,
  authorCharacterId,
  isCharacter,
  authorName,
  authorAvatar,
  showAvatar = true,
  className = ""
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

  return (
    <div className={`d-flex align-items-center gap-2 text-muted ${className}`} style={{ fontSize: '0.875rem' }}>
      <span className="text-nowrap">{formatTime(date)}</span>
      <span className="d-none d-sm-inline">·</span>
      
      <div className="d-flex align-items-center gap-2">
        {showAvatar && (
          <ForumAuthorAvatar
            userId={authorId}
            characterId={authorCharacterId}
            isCharacter={isCharacter}
            fallbackName={authorName}
            initialAvatar={authorAvatar}
            size={20}
            roundedCircle={true}
            className="shadow-sm"
          />
        )}
        <ForumAuthorName
          userId={authorId}
          characterId={authorCharacterId}
          isCharacter={isCharacter}
          fallbackName={authorName}
          className="fw-semibold text-secondary"
        />
      </div>
    </div>
  );
};

export default AuthorMeta;
