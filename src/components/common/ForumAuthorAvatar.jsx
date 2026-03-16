import React, { useState, useEffect } from 'react';
import { Image } from 'react-bootstrap';
import { subscribeToUser } from '../../api/forum';
import { subscribeToCharacter } from '../../api/character';

/**
 * Shared component to display an author's avatar with live updates.
 * Handles both users and character masks.
 *
 * Props:
 *   userId       {string}  — The UID of the author/owner
 *   characterId  {string?} — The ID of the character mask (if any)
 *   isCharacter  {boolean} — Whether to show character avatar
 *   fallbackName {string}  — Used for ui-avatars if no image found
 *   size         {number}  — Size in pixels
 *   className    {string?} — Extra CSS classes
 */
const ForumAuthorAvatar = ({
  userId,
  characterId,
  isCharacter,
  fallbackName,
  initialAvatar,
  size = 32,
  roundedCircle = false,
  className = ''
}) => {
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setTimeout(() => setLoading(false), 0);
      return;
    }

    setTimeout(() => setLoading(true), 0);
    let unsub;

    if (isCharacter && characterId) {
      unsub = subscribeToCharacter(userId, characterId, (charData) => {
        setAvatarUrl(charData?.avatar_url || null);
        setLoading(false);
      });
    } else {
      unsub = subscribeToUser(userId, (userData) => {
        setAvatarUrl(userData?.avatar_url || null);
        setLoading(false);
      });
    }

    return () => unsub?.();
  }, [userId, characterId, isCharacter]);

  if (loading) {
    return (
      <div 
        className={`skeleton skeleton-avatar ${className}`} 
        style={{ width: size, height: size, borderRadius: roundedCircle ? '50%' : '0.5rem' }} 
      />
    );
  }

  const placeholder = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName || '?')}&background=random&size=${size}`;
  const finalAvatar = avatarUrl || initialAvatar || placeholder;

  return (
    <Image
      src={finalAvatar}
      roundedCircle={roundedCircle}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'cover' }}
      alt={fallbackName || 'Avatar'}
      referrerPolicy="no-referrer"
      onError={(e) => {
        e.target.onerror = null;
        e.target.src = placeholder;
      }}
    />
  );
};

export default ForumAuthorAvatar;
