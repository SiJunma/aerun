import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import { deletedDisplayName } from '../../utils/identity';

/**
 * Shared component to display an author's name.
 * Uses the frozen/provided name directly without spawning real-time Firestore listeners.
 */
const ForumAuthorName = ({
  fallbackName,
  className = '',
  onClick
}) => {
  const { lang } = useI18n();
  // A post/topic whose author was removed carries no author_name in the payload
  // (forum_authors.go leaves it undecorated), so an empty name IS the removed
  // case. Fall through to the shared placeholder rather than a bare em-dash, so
  // a deleted author reads the same here as it does in the DM inbox (bug M2).
  const name = fallbackName || deletedDisplayName(lang);

  return (
    <span 
      className={`forum-author-name ${className}`} 
      onClick={onClick ? () => onClick(name) : undefined}
      style={onClick ? { cursor: 'pointer' } : {}}
    >
      {name}
    </span>
  );
};

export default ForumAuthorName;

