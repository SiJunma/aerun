import React from 'react';

/**
 * Shared component to display an author's name.
 * Uses the frozen/provided name directly without spawning real-time Firestore listeners.
 */
const ForumAuthorName = ({
  fallbackName,
  className = '',
  onClick
}) => {
  const name = fallbackName || '—';

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

