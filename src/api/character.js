import { pb, sendApi } from './pocketbase';

export const subscribeToCharacters = (uid, callback) => {
  let isSubscribed = true;

  const load = async () => {
    try {
      if (!uid) {
        if (isSubscribed) callback([]);
        return;
      }
      // If fetching own characters
      if (pb.authStore.isValid && pb.authStore.record?.id === uid) {
        const me = await sendApi('/api/aerun/me');
        const chars = me?.settings?.characters || [];
        if (isSubscribed) callback(chars);
        return;
      }

      // Fetching other user's public characters
      const u = await pb.collection('users').getOne(uid);
      const chars = u?.settings?.characters || [];
      if (isSubscribed) callback(chars);
    } catch (err) {
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

export const addCharacter = async (uid, characterData) => {
  const me = await sendApi('/api/aerun/me');
  const settings = me?.settings || {};
  const currentChars = Array.isArray(settings.characters) ? [...settings.characters] : [];
  const newChar = {
    id: `char_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    ...characterData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  currentChars.push(newChar);
  await sendApi('/api/aerun/me/settings', {
    method: 'PUT',
    body: {
      ...settings,
      characters: currentChars
    }
  });
  return newChar.id;
};

export const updateCharacter = async (uid, charId, characterData) => {
  const me = await sendApi('/api/aerun/me');
  const settings = me?.settings || {};
  const currentChars = Array.isArray(settings.characters) ? [...settings.characters] : [];
  const idx = currentChars.findIndex(c => c.id === charId || c._id === charId);
  if (idx >= 0) {
    currentChars[idx] = {
      ...currentChars[idx],
      ...characterData,
      updated_at: new Date().toISOString()
    };
    await sendApi('/api/aerun/me/settings', {
      method: 'PUT',
      body: {
        ...settings,
        characters: currentChars
      }
    });
  }
};

export const deleteCharacter = async (uid, charId) => {
  const me = await sendApi('/api/aerun/me');
  const settings = me?.settings || {};
  const currentChars = Array.isArray(settings.characters) ? [...settings.characters] : [];
  const filtered = currentChars.filter(c => c.id !== charId && c._id !== charId);
  await sendApi('/api/aerun/me/settings', {
    method: 'PUT',
    body: {
      ...settings,
      characters: filtered
    }
  });
};
