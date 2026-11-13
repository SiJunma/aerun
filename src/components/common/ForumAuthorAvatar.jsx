import React from 'react';
import { Image } from 'react-bootstrap';
import { useI18n } from '../../contexts/I18nProvider';
import { useAuth } from '../../contexts/AuthProvider';
import { resolveAvatarUrl } from '../../api/avatars';
import { identityAvatar } from '../../utils/identity';

// In-memory cache for avatar URLs
const avatarCache = new Map();

/**
 * Shared component to display an author's avatar.
 * Uses the frozen/provided avatar directly without spawning real-time Firestore listeners.
 */
const ForumAuthorAvatar = ({
  author,          // nested AuthorRef DTO: preferred avatar_url + ids
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
  const { t } = useI18n();
  const { settings } = useAuth();

  // The DTO carries the resolved ids; fall back to the explicit props so
  // existing call sites keep working unchanged.
  const authorCharId = author?.character_id && typeof author.character_id === 'string' && author.character_id.trim() !== '' ? author.character_id.trim() : null;
  const authorUserId = author?.user_id && typeof author.user_id === 'string' && author.user_id.trim() !== '' ? author.user_id.trim() : null;
  const validCharId = isCharacter && characterId && typeof characterId === 'string' && characterId.trim() !== '' ? characterId.trim() : (isCharacter ? authorCharId : null);
  const validUserId = userId && typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : authorUserId;
  const cacheKey = validCharId ? `char_${validCharId}` : (validUserId ? `user_${validUserId}` : null);

  if (initialAvatar && cacheKey) {
    avatarCache.set(cacheKey, initialAvatar);
  }

  const cachedAvatar = cacheKey ? avatarCache.get(cacheKey) : null;
  // A live member who simply never uploaded a photo keeps the initials-from-
  // their-name avatar. An author with NO name at all is a REMOVED account and
  // must draw the SAME placeholder the DM inbox draws — the single
  // identity.js helper — so a deleted author reads identically everywhere.
  const placeholderName = fallbackName ?? author?.display_name;
  const placeholder = placeholderName
    ? `https://api.dicebear.com/9.x/shapes/svg?seed=${encodeURIComponent(placeholderName)}&size=${size}`
    : identityAvatar({ name: '', avatar: '', customPlaceholder: settings?.deletedAvatar, size });
  // The DTO's avatar_url (resolved server-side) leads. For guests without a
  // custom avatar, fall back to the admin-uploaded guest placeholder, then
  // the explicit initialAvatar, then the cache; anything unresolved degrades
  // to the placeholder rather than a broken image.
  let avatarSource = author?.avatar_url;
  if (author?.kind === 'guest' && !avatarSource) {
    avatarSource = settings?.guestAvatar;
  }
  if (!avatarSource) {
    avatarSource = initialAvatar ?? cachedAvatar;
  }
  const finalAvatar = resolveAvatarUrl(avatarSource) || placeholder;

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
          title={t('avatar.online')}
        />
      )}
    </div>
  );
};

export default ForumAuthorAvatar;

