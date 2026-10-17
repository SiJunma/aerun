import React from 'react';
import { useI18n } from '../../contexts/I18nProvider';
import { deletedDisplayName } from '../../utils/identity';

/**
 * Shared component to display an author's name.
 * Uses the frozen/provided name directly without spawning real-time Firestore listeners.
 */
const ForumAuthorName = ({
  author,          // nested AuthorRef DTO {kind, user_id, display_name, avatar_url, character_id}
  fallbackName,    // backward-compat: flat resolved name
  className = '',
  onClick
}) => {
  const { lang } = useI18n();
  // author?.display_name is the single source of truth: the guest's chosen
  // name, the account's resolved (mask-aware) nickname, or null for a deleted
  // account. ?? (nullish coalescing, not truthiness) so an empty name never
  // masquerades as "no author", and deletedDisplayName only appears when there
  // is no name at all — replacing the old `fallbackName || deletedDisplayName`
  // chain.
  const name = author?.display_name ?? fallbackName ?? deletedDisplayName(lang);

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

