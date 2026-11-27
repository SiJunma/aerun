import { pb, pbUrl, sendApi } from './pocketbase.js';

/**
 * Avatar URLs come in three shapes, and every render site has to handle all
 * three at once:
 *
 *  1. A PocketBase file path — "/api/files/<collectionId>/<recordId>/<file>",
 *     stored host-agnostically by the avatar importer so the same rows survive
 *     a domain change. This is what the migrated accounts carry today, and what
 *     a new upload writes back.
 *  2. An absolute remote URL — still used by the DiceBear placeholder avatars
 *     and by the one account whose avatar is hosted elsewhere.
 *  3. An inline data URL — a legacy shape. New uploads no longer produce one
 *     (see uploadMyAvatar), but rows written by the old browser uploader may
 *     still carry it until they are re-saved.
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
 * uploadMyAvatar stores the caller's avatar as a real file and returns the new
 * host-agnostic avatar_url.
 *
 * The bytes go to the server, never into avatar_url: that column is a
 * TextField capped at 512 characters, and an inline data URL is orders of
 * magnitude larger, so a client-side upload could only ever fail validation.
 * The server sniffs the format from the bytes, stores the file on the record
 * and rewrites avatar_url to the /api/files path every render site already
 * knows how to resolve.
 *
 * A Blob is accepted directly (the uploader resizes to a Blob); a File is a
 * Blob, so both work.
 */
export async function uploadMyAvatar(blob, filename = 'avatar.png') {
  const form = new FormData();
  form.append('file', blob, filename);

  const res = await sendApi('/api/aerun/me/avatar', {
    method: 'PUT',
    body: form
    // No Content-Type: the browser must set it with the multipart boundary.
  });

  return res?.avatar_url || '';
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