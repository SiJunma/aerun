import { sendApi } from './pocketbase';
import { sharedPoll } from './shared-poll';

// Character (mask) access.
//
// This module used to read and write `users.settings.characters` and fetch
// `pb.collection('users').getOne(uid)`. That is the pre-migration fold ADR-5
// retracted: the `characters` collection is the authoritative store, it is what
// the importer fills, and it is what `posts.author_character_id` will reference.
// The fold had two concrete costs — characters created here never reached the
// collection the importer writes, and imported characters were invisible to the
// editor that was supposed to change them.
//
// The subscribeTo* signatures are unchanged so no page component had to be
// touched: they still take (uid, callback) and still deliver an array.

// A character read is public for an active owner and 404 otherwise, so a caller
// only ever needs one endpoint. Own characters are included in that same call —
// no auth branch in the client, which is where the previous "am I looking at
// myself?" check used to diverge from what the server would actually return.
export const fetchCharacters = async (uid) => {
  if (!uid) return [];
  const res = await sendApi(`/api/aerun/users/${uid}/characters`);
  return res?.items || [];
};

export const subscribeToCharacters = (uid, callback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }

  // ONE loop per owner (F3): TopicPage, TopicFormPage and ProfilePage all read
  // this member's masks, and each used to pay a full request. The second
  // subscriber costs zero requests — it is handed the value the loop holds.
  //
  // Keyed by account (same correctness rule as notifications:${uid}): the
  // resource caches the last value, so without the uid a sign-out/sign-in on
  // a shared machine would paint the previous member's masks for one tick.
  //
  // No realtime hook and no interval: masks change through the profile editor
  // this session owns (add/update/delete below refresh the resource
  // directly), so a timer would only re-read what nobody else writes. A
  // member edited elsewhere re-reads on remount — the cached value is handed
  // over only within one session's loop.
  const poll = sharedPoll(`characters:${uid}`, {
    fetch: () => fetchCharacters(uid),
    intervalMs: 0,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToCharacters err]', err),
  });

  // A 404 means the owner is pending or banned. That is an expected answer,
  // not a failure: the profile shows "no characters" rather than an error
  // banner, which is what the legacy page did too. shared-poll delivers the
  // error WITH the last good value rather than replacing it, so the mapping
  // below keeps rendering masks through one slow response.
  return poll.subscribe((chars, err) => {
    if (!err) {
      callback(chars || []);
    } else if (err?.status === 404 || err?.code === 'not-found') {
      callback([]);
    } else {
      callback(chars || []);
    }
  });
};

// refreshCharacters re-reads this owner's masks WITHOUT waiting for a
// remount. Called after the member's own mask writes below: the server state
// already moved, but every subscriber renders the last read value, so without
// this the editor shows stale masks until the page is left and reopened.
export const refreshCharacters = (uid) => {
  if (!uid) return;
  try {
    sharedPoll(`characters:${uid}`, {
      fetch: () => fetchCharacters(uid),
      intervalMs: 0,
      initialValue: [],
    }).refresh();
  } catch {
    // A missed refresh only delays the masks to the next mount — never fail
    // a mask write for it.
  }
};

export const subscribeToCharacter = (uid, charId, callback) => {
  let isSubscribed = true;
  subscribeToCharacters(uid, (chars) => {
    if (!isSubscribed) return;
    const found = chars.find(c => c.id === charId || c._id === charId);
    callback(found || null);
  });
  return () => { isSubscribed = false; };
};

export const fetchCharacter = async (charId) => {
  const res = await sendApi(`/api/aerun/characters/${charId}`);
  return res;
};

// toCharacterPayload sends only the fields the command owns. avatar_url is
// deliberately NOT sent: it is server-derived from the stored file, and writing
// it from the client is exactly the data-URL path the FileField migration
// removed. An avatar changes through uploadCharacterAvatar, never through a
// text field.
const toCharacterPayload = (characterData) => ({
  name: (characterData?.name || '').trim(),
  status_line: (characterData?.status_line || '').trim(),
  signature: (characterData?.signature || '').trim()
});

// addCharacter creates a mask for the given owner.
//
// The OWNER is the account the mask belongs to, and the two cases are
// different endpoints:
//
//   - your own masks  → POST /api/aerun/me/characters
//   - somebody else's → POST /api/aerun/users/{id}/characters
//
// The second is the staff path: the server checks create_others_mask plus the
// rank matrix, and charges the OWNER's role limit — not the caller's — so an
// admin adding a mask for a player is not charged for the player's own masks.
//
// The owner id is NOT trusted as an authority: it only says WHICH account the
// mask is for, and the server decides whether the caller may write there. The
// self-service route keeps deriving the owner from the auth token, so a client
// cannot turn it into a write into somebody else's rows.
export const addCharacter = async (uid, characterData, { asStaff = false } = {}) => {
  const path = asStaff
    ? `/api/aerun/users/${uid}/characters`
    : '/api/aerun/me/characters';
  const res = await sendApi(path, {
    method: 'POST',
    body: toCharacterPayload(characterData)
  });
  // The server state already moved, but every subscriber renders the last
  // read value — without this the editor shows stale masks until remount.
  // Best effort: a missed refresh only delays the masks, never fails the
  // write (same contract as refreshUnreadCounts in dms.js).
  refreshCharacters(uid);
  return res?.id;
};

export const updateCharacter = async (uid, charId, characterData) => {
  await sendApi(`/api/aerun/characters/${charId}`, {
    method: 'PATCH',
    body: toCharacterPayload(characterData)
  });
  refreshCharacters(uid);
};

export const deleteCharacter = async (uid, charId) => {
  await sendApi(`/api/aerun/characters/${charId}`, { method: 'DELETE' });
  refreshCharacters(uid);
};

// uploadCharacterAvatar sends the multipart body. sendApi attaches the auth
// token but skips the JSON content type and the Idempotency-Key for FormData —
// the upload command is a replace, so a retry converges (ADR-4).
export const uploadCharacterAvatar = async (charId, file, uid = '') => {
  const form = new FormData();
  form.append('file', file);
  const res = await sendApi(`/api/aerun/characters/${charId}/avatar`, {
    method: 'PUT',
    body: form
  });
  // Same staleness as the text writes above: the avatar changed server-side,
  // every subscriber still renders the old one.
  refreshCharacters(uid);
  return res?.avatar_url;
};
