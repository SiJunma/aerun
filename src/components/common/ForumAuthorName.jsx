import React, { useState, useEffect } from 'react';
import { subscribeToUser } from '../../api/forum';
import { subscribeToCharacter } from '../../api/character';

/**
 * Shared component to display an author's name with live updates.
 * Correctly handles both users and character masks.
 *
 * Props:
 *   userId       {string}  — The UID of the author/owner
 *   characterId  {string?} — The ID of the character mask (if any)
 *   isCharacter  {boolean} — Whether the post was made by a character
 *   fallbackName {string}  — Name to show while loading or if record missing
 *   className    {string?} — Extra CSS classes
 */
const ForumAuthorName = ({
  userId,
  characterId,
  isCharacter,
  fallbackName,
  className = ''
}) => {
  const [liveName, setLiveName] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setTimeout(() => setLoading(false), 0);
      return;
    }

    setTimeout(() => setLoading(true), 0);
    let unsub;

    if (isCharacter && characterId) {
      // Subscribe to character name
      unsub = subscribeToCharacter(userId, characterId, (charData) => {
        setLiveName(charData?.name || null);
        setLoading(false);
      });
    } else {
      // Subscribe to user nickname
      unsub = subscribeToUser(userId, (userData) => {
        setLiveName(userData?.nickname || null);
        setLoading(false);
      });
    }

    return () => unsub?.();
  }, [userId, characterId, isCharacter]);

  return (
    <span className={`forum-author-name ${className}`}>
      {loading ? (
        <span className="skeleton" style={{ width: '100px', height: '1.2em', display: 'inline-block', verticalAlign: 'middle' }}></span>
      ) : (
        liveName || fallbackName || '—'
      )}
    </span>
  );
};

export default ForumAuthorName;
