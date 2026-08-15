import React from 'react';
import { Image } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';

// In-memory cache for avatar URLs
const avatarCache = new Map();

/**
 * Shared component to display an author's avatar.
 * Uses the frozen/provided avatar directly without spawning real-time Firestore listeners.
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

  const cacheKey = isCharacter && characterId ? `char_${characterId}` : `user_${userId}`;
  if (initialAvatar && cacheKey) {
    avatarCache.set(cacheKey, initialAvatar);
  }

  const cachedAvatar = avatarCache.get(cacheKey);
  const placeholder = `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(fallbackName || 'Guest')}&size=${size}`;
  const finalAvatar = initialAvatar || cachedAvatar || placeholder;

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
        loading="lazy"
        decoding="async"
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

