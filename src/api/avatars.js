import { pb, pbUrl } from './pocketbase';

/**
 * Avatar URLs come in three shapes, and every render site has to handle all
 * three at once:
 *
 *  1. A PocketBase file path — "/api/files/<collectionId>/<recordId>/<file>",
 *     stored host-agnostically by the avatar importer so the same rows survive
 *     a domain change. This is what the migrated accounts carry today.
 *  2. An absolute remote URL — still used by the DiceBear placeholder avatars
 *     and by the one account whose avatar is hosted elsewhere.
 *  3. An inline data URL, produced by the browser-side uploader.
 *
 * resolveAvatarUrl returns something an <img src> can actually load: only the
 * relative PocketBase path needs the backend origin prefixed. Passing it
 * through for the other two shapes is what keeps the migration invisible — no
 * render site has to know which kind of avatar it is showing.
 */
export function resolveAvatarUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return `${pbUrl.replace(/\/+$/, '')}${trimmed}`;
  return trimmed;
}

/**
 * recordAvatarUrl is the PocketBase-native way to address a file that the
 * record itself owns: it returns the same /api/files path the importer wrote
 * into avatar_url, built from the live record so a re-uploaded avatar is picked
 * up without a stale copy being cached anywhere. Used for the caller's own
 * profile, where the full record is at hand.
 */
export function recordAvatarUrl(record, field = 'avatar') {
  if (!record) return '';
  const filename = record[field];
  if (!filename) return resolveAvatarUrl(record.avatar_url);
  return pb.files.getURL(record, filename);
}