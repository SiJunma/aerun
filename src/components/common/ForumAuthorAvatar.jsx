import React from 'react';
import { Image } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { resolveAvatarUrl } from '../../api/avatars';

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

  const validCharId = isCharacter && characterId && typeof characterId === 'string' && characterId.trim() !== '' ? characterId.trim() : null;
  const validUserId = userId && typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : null;
  const cacheKey = validCharId ? `char_${validCharId}` : (validUserId ? `user_${validUserId}` : null);

  if (initialAvatar && cacheKey) {
    avatarCache.set(cacheKey, initialAvatar);
  }

  const cachedAvatar = cacheKey ? avatarCache.get(cacheKey) : null;
  const placeholder = `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(fallbackName || 'Guest')}&size=${size}`;
  // Every author snapshot (topics, posts, drafts, last-post info) arrives here,
  // so this is the single place that has to turn a stored avatar reference into
  // something loadable — the importer writes a host-agnostic /api/files path,
  // while DiceBear and legacy data URLs are already absolute.
  const finalAvatar = resolveAvatarUrl(initialAvatar || cachedAvatar) || placeholder;

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

