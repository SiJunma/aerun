import { sendApi } from './pocketbase';

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
  let isSubscribed = true;

  const load = async () => {
    try {
      const chars = await fetchCharacters(uid);
      if (isSubscribed) callback(chars);
    } catch (err) {
      // A 404 here means the owner is pending or banned. That is an expected
      // answer, not a failure: the profile shows "no characters" rather than an
      // error banner, which is what the legacy page did too.
      console.warn('[subscribeToCharacters err]', err);
      if (isSubscribed) callback([]);
    }
  };

  load();
  return () => { isSubscribed = false; };
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

// The uid argument is kept for signature compatibility with the page components.
// It is deliberately unused: the command derives the owner from the auth token,
// and trusting a client-supplied owner id here is how one account ends up
// writing into another's rows.
export const addCharacter = async (uid, characterData) => {
  const res = await sendApi('/api/aerun/me/characters', {
    method: 'POST',
    body: toCharacterPayload(characterData)
  });
  return res?.id;
};

export const updateCharacter = async (uid, charId, characterData) => {
  await sendApi(`/api/aerun/characters/${charId}`, {
    method: 'PATCH',
    body: toCharacterPayload(characterData)
  });
};

export const deleteCharacter = async (uid, charId) => {
  await sendApi(`/api/aerun/characters/${charId}`, { method: 'DELETE' });
};

// uploadCharacterAvatar sends the multipart body. sendApi attaches the auth
// token but skips the JSON content type and the Idempotency-Key for FormData —
// the upload command is a replace, so a retry converges (ADR-4).
export const uploadCharacterAvatar = async (charId, file) => {
  const form = new FormData();
  form.append('file', file);
  const res = await sendApi(`/api/aerun/characters/${charId}/avatar`, {
    method: 'PUT',
    body: form
  });
  return res?.avatar_url;
};
