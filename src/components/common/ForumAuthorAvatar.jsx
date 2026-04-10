import React, { useState, useEffect } from 'react';
import { Image } from 'react-bootstrap';
import { subscribeToUser } from '../../api/auth-resources';
import { subscribeToCharacter } from '../../api/character';
import { useI18n } from '../../contexts/I18nProvider';

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
  className = '',
  isOnline = false,
}) => {
  const { lang } = useI18n();
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

  const placeholder = `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(fallbackName || 'Guest')}&size=${size}`;
  const finalAvatar = avatarUrl || initialAvatar || placeholder;

  // Dot size scales with avatar: small avatars get a smaller dot
  const dotSize = size >= 80 ? 12 : size >= 48 ? 10 : 8;
  // Negative offset to push it outside the avatar bounding box
  const dotOffset = size >= 80 ? -4 : size >= 48 ? -3 : -2;

  return (
    <div style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      <Image
        src={finalAvatar}
        roundedCircle={roundedCircle}
        width={size}
        height={size}
        className={className}
        style={{ objectFit: 'cover', display: 'block' }}
        alt={fallbackName || 'Avatar'}
        referrerPolicy="no-referrer"
        onError={(e) => {
          e.target.onerror = null;
          e.target.src = placeholder;
        }}
      />
      {isOnline && (
        <span
          className="online-status-dot"
          style={{ width: dotSize, height: dotSize, bottom: dotOffset, right: dotOffset }}
          title={lang === 'ru' ? 'В сети' : 'Online'}
        />
      )}
    </div>
  );
};

export default ForumAuthorAvatar;
