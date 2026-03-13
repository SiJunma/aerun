import React from 'react';
import { format } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import ForumAuthorName from './ForumAuthorName';
import ForumAuthorAvatar from './ForumAuthorAvatar';

const AuthorMeta = ({
  date,
  authorId,
  authorCharacterId,
  isCharacter,
  authorName,
  lang,
  showAvatar = true,
  className = ""
}) => {
  const formatTime = (dateValue) => {
    if (!dateValue) return '—';
    try {
      const d = dateValue.toDate ? dateValue.toDate() : new Date(dateValue);
      return format(d, 'd MMM yyyy, HH:mm', { locale: lang === 'ru' ? ru : enUS });
    } catch {
      return '—';
    }
  };

  return (
    <div className={`d-flex align-items-center gap-2 text-muted ${className}`} style={{ fontSize: '0.875rem' }}>
      <span className="text-nowrap">{formatTime(date)}</span>
      <span className="d-none d-sm-inline opacity-50">·</span>
      
      <div className="d-flex align-items-center gap-2">
        {showAvatar && authorId && (
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
