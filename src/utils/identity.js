// identity.js — the single source for a MISSING identity's placeholder display.
//
// When an account is removed, its content outlives it: forum_authors.go leaves a
// deleted author's post/topic payload UNDECORATED (no author_name, no
// author_avatar), and the DM inbox resolves a removed peer to an empty
// participantNames entry. Every surface that renders such an identity — posts,
// last-post thumbnails, the DM inbox — must draw it the SAME way, so that a
// removed account reads as one consistent "deleted" placeholder rather than as
// whatever each render site happened to fall back to.
//
// That fallback is this module. It is deliberately a plain function, not a
// second component: ForumAuthorName / ForumAuthorAvatar (posts) and
// DirectMessages (inbox) already own their markup, and the only thing that has
// to be shared is the NAME and the AVATAR URL for the missing case. Swapping
// the source later (a forum setting that uploads custom placeholder images,
// backlog I5) means changing this one file, not every render site.
//
// The distinguishing signal is the NAME, not the id: a live member who simply
// never uploaded a photo still HAS a name in the payload, so they keep the
// initials-from-their-name avatar. Only an identity with no name at all — a
// removed account — falls through to the deleted placeholder here.

/**
 * deletedDisplayName returns the localized placeholder name for a removed
 * (or otherwise unresolvable) identity. `lang` is the active language code.
 */
export function deletedDisplayName(lang) {
  return lang === 'ru' ? 'Удалённый пользователь' : 'Deleted user';
}

/**
 * placeholderAvatarUrl returns the placeholder avatar for a name that resolved
 * to nothing, so the caller can still draw a face.
 *
 * The rule that keeps ONE placeholder everywhere (plan D1): pass the RAW
 * resolved name, never a display fallback. A name that is present — a live
 * member who simply never uploaded a photo — keeps their initials (ui-avatars
 * derives them, Cyrillic included, exactly as MembersPage already does). A name
 * that is EMPTY is a removed account (forum_authors.go leaves it undecorated;
 * the DM listing resolves a removed peer to an empty entry), and it collapses to
 * the same neutral gray "U" in every surface and every language.
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
