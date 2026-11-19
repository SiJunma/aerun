import { resolveAvatarUrl } from '../api/avatars';
import { translations } from '../i18n/dictionary.js';

// identity.js — the single source for a MISSING identity's placeholder display.
//
// When an account is removed, its content outlives it: forum_authors.go leaves a
// deleted author's post/topic payload UNDECORATED (no display_name/avatar_url
// in the author DTO), and the DM inbox resolves a removed peer to an empty
// participantNames entry. Every surface that renders such an identity — posts,
// last-post thumbnails, the DM inbox — must draw it the SAME way, so that a
// removed account reads as one consistent "deleted" placeholder rather than as
// whatever each render site happened to fall back to.
//
// That fallback is this module. It is deliberately a plain function, not a
// second component: ForumAuthorName / ForumAuthorAvatar (posts) and
// DirectMessages (inbox) already own their markup, and the only thing that has
// to be shared is the NAME and the AVATAR URL for the missing case.
//
// The SOURCE of the placeholder image is a forum setting (plan I5/D2): the admin
// uploads a custom image for "deleted" and one for "guest" in the settings
// panel, stored on the forum_settings singleton and read from the public
// settings snapshot. Until an image is uploaded the reference is empty and the
// neutral gray "U" below is the default. Swapping the source means changing this
// one file, not every render site.
//
// The distinguishing signal is the NAME, not the id: a live member who simply
// never uploaded a photo still HAS a name in the payload, so they keep the
// initials-from-their-name avatar. Only an identity with no name at all — a
// removed account — falls through to the placeholder here.

/**
 * deletedDisplayName returns the localized placeholder name for a removed
 * (or otherwise unresolvable) identity. `lang` is the active language code.
 *
 * A custom `name` from a forum setting wins when present, so an owner who wants
 * a specific label ("Banned", "Former member") gets it everywhere; otherwise the
 * built-in localized default is used.
 */
export function deletedDisplayName(lang, name) {
  if (typeof name === 'string' && name.trim()) return name.trim();
  const dict = translations[lang] || translations.en;
  return dict?.common?.deleted_user || translations.en.common.deleted_user;
}

/**
 * placeholderAvatarUrl returns the DEFAULT placeholder avatar for a name that
 * resolved to nothing, so the caller can still draw a face.
 *
 * The rule that keeps ONE default everywhere (plan D1): pass the RAW resolved
 * name, never a display fallback. A name that is present — a live member who
 * simply never uploaded a photo — keeps their initials (ui-avatars derives
 * them, Cyrillic included, exactly as MembersPage already does). A name that is
 * EMPTY is a removed account (forum_authors.go leaves it undecorated; the DM
 * listing resolves a removed peer to an empty entry), and it collapses to the
 * same neutral gray "U" in every surface and every language.
 *
 * That is why the DM inbox passes the raw participantNames entry rather than the
 * localized "Удалённый пользователь" label: the label would seed the avatar with
 * a language-dependent initial ("D" in English, "U" in Russian), which is the
 * very drift this helper exists to remove.
 *
 * `size` is doubled because ui-avatars treats it as device pixels.
 */
export function placeholderAvatarUrl(name, size = 40) {
  const seed = typeof name === 'string' && name.trim() ? name.trim() : 'U';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(seed)}&background=666&color=fff&size=${size * 2}`;
}

/**
 * identityAvatar resolves the avatar to draw for a possibly-missing identity,
 * in priority order:
 *
 *   1. the identity's OWN resolved avatar (a live member with a photo);
 *   2. the admin-uploaded custom placeholder for this kind, if one is set
 *      (`customPlaceholder` — the settings.deletedAvatar / settings.guestAvatar
 *      reference, resolved through resolveAvatarUrl like any other avatar);
 *   3. the neutral gray "U" default, seeded by `name` only when the identity is
 *      live-but-photoless (empty name → "U").
 *
 * This is the ONE place a render site should ask "what picture do I show for
 * this identity?", so the custom placeholder and the default can never drift
 * between posts, thumbnails and the DM inbox.
 *
 * `size` only matters for the default (ui-avatars treats it as device pixels);
 * a custom or resolved image carries its own dimensions.
 */
export function identityAvatar({ name, avatar, customPlaceholder, size = 40 }) {
  const own = resolveAvatarUrl(avatar);
  if (own) return own;
  const custom = resolveAvatarUrl(customPlaceholder);
  if (custom) return custom;
  return placeholderAvatarUrl(name, size);
}
