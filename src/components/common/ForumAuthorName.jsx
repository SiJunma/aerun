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

  useEffect(() => {
    if (!userId) return;

    let unsub;

    if (isCharacter && characterId) {
      // Subscribe to character name
      unsub = subscribeToCharacter(userId, characterId, (charData) => {
        if (charData?.name) {
          setLiveName(charData.name);
        } else {
          setLiveName(null);
        }
      });
    } else {
      // Subscribe to user nickname
      unsub = subscribeToUser(userId, (userData) => {
        if (userData?.nickname) {
          setLiveName(userData.nickname);
        } else {
          setLiveName(null);
        }
      });
    }

    return () => unsub?.();
  }, [userId, characterId, isCharacter]);

  return (
    <span className={`forum-author-name ${className}`}>
      {liveName || fallbackName || '—'}
    </span>
  );
};

export default ForumAuthorName;
