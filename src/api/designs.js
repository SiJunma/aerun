import { sendApi } from './pocketbase';

const LOCAL_STORAGE_KEY = 'aerun_custom_designs';

export function toDesign(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name || '',
    description: raw.description || '',
    css: raw.css || '',
    js: raw.js || '',
    forumTitle: raw.forum_title ?? raw.forumTitle ?? '',
    faviconUrl: raw.favicon_url ?? raw.faviconUrl ?? '',
    isActive: raw.is_active !== undefined ? Boolean(raw.is_active) : (raw.isActive !== undefined ? Boolean(raw.isActive) : true),
    showInList: raw.show_in_list !== undefined ? Boolean(raw.show_in_list) : (raw.showInList !== undefined ? Boolean(raw.showInList) : true),
    welcomeMessage: raw.welcome_message ?? raw.welcomeMessage ?? '',
    createdAt: raw.created_at || raw.createdAt || '',
    updatedAt: raw.updated_at || raw.updatedAt || '',
  };
}

export function toDesignPayload(data) {
  if (!data) return {};
  const payload = {};
  if (data.name !== undefined) payload.name = data.name;
  if (data.description !== undefined) payload.description = data.description;
  if (data.css !== undefined) payload.css = data.css;
  if (data.js !== undefined) payload.js = data.js;
  if (data.forumTitle !== undefined) payload.forum_title = data.forumTitle;
  else if (data.forum_title !== undefined) payload.forum_title = data.forum_title;
  if (data.faviconUrl !== undefined) payload.favicon_url = data.faviconUrl;
  else if (data.favicon_url !== undefined) payload.favicon_url = data.favicon_url;
  if (data.isActive !== undefined) payload.is_active = Boolean(data.isActive);
  else if (data.is_active !== undefined) payload.is_active = Boolean(data.is_active);
  if (data.showInList !== undefined) payload.show_in_list = Boolean(data.showInList);
  else if (data.show_in_list !== undefined) payload.show_in_list = Boolean(data.show_in_list);
  if (data.welcomeMessage !== undefined) payload.welcome_message = data.welcomeMessage;
  else if (data.welcome_message !== undefined) payload.welcome_message = data.welcome_message;
  return payload;
}

const getLocalDesigns = () => {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

let _cachedDesigns = null;
const _designSubscribers = new Set();
// Modules-level dedupe for the read: DesignProvider and ProfilePage both
// read /api/aerun/designs on mount (DesignProvider on boot, ProfilePage
// inside its profile effect), so on a profile open the same request was in
// flight twice. The two callers are not always in the same tick — a provider
// re-render can re-run a consumer's effect seconds later — so an in-flight
// join alone is not enough; the cache is the coordination point there.
let _inFlightDesigns = null;

const notifySubscribers = async () => {
  try {
    const list = await getDesigns(true);
    _cachedDesigns = list;
    _designSubscribers.forEach(cb => {
      try { cb(list); } catch (e) { console.error(e); }
    });
  } catch (err) {
    console.error('[designs] error notifying subscribers', err);
  }
};

export const subscribeToDesigns = (callback) => {
  _designSubscribers.add(callback);
  if (_cachedDesigns) {
    try { callback(_cachedDesigns); } catch (e) { console.error(e); }
  }
  getDesigns().then(d => {
    _cachedDesigns = d;
    try { callback(d); } catch (e) { console.error(e); }
  }).catch(() => {
    if (!_cachedDesigns) {
      try { callback([]); } catch (e) { console.error(e); }
    }
  });
  return () => {
    _designSubscribers.delete(callback);
  };
};

export const getDesigns = async (force = false) => {
  // The cache used to be write-only: every fetch stored into _cachedDesigns and
  // nothing ever read it back, so a remount of DesignProvider paid a full
  // refetch instead of a cache hit. Mutations bypass the cache on purpose —
  // notifySubscribers must answer with the SERVER's state after a write, not
  // with the pre-write snapshot.
  if (!force && _cachedDesigns) return _cachedDesigns;
  if (force) {
    _inFlightDesigns = null;
  }
  if (!force && _inFlightDesigns) return _inFlightDesigns;
  const flight = (async () => {
    try {
      const res = await sendApi('/api/aerun/designs');
      const items = res?.items || [];
      const mapped = items.map(toDesign);
      _cachedDesigns = mapped;
      return mapped;
    } catch (err) {
      console.warn('[designs] failed to fetch from server, checking local fallback', err);
      return getLocalDesigns().map(toDesign);
    }
  })();
  if (!force) _inFlightDesigns = flight;
  flight.finally(() => {
    if (_inFlightDesigns === flight) _inFlightDesigns = null;
  });
  return flight;
};

export const getDesign = async (id) => {
  try {
    const record = await sendApi(`/api/aerun/designs/${id}`);
    if (record) {
      return toDesign(record);
    }
  } catch (err) {
    console.warn(`[designs] failed to fetch design ${id}`, err);
  }
  const local = getLocalDesigns().find(d => d.id === id);
  return local ? toDesign(local) : null;
};

export const createDesign = async (designData) => {
  const payload = toDesignPayload(designData);
  const record = await sendApi('/api/aerun/designs', {
    method: 'POST',
    body: payload
  });
  if (record?.id) {
    notifySubscribers();
    return record.id;
  }
  throw new Error('Failed to create design: server returned empty response');
};

export const updateDesign = async (id, designData) => {
  const payload = toDesignPayload(designData);
  const record = await sendApi(`/api/aerun/designs/${id}`, {
    method: 'PATCH',
    body: payload
  });
  notifySubscribers();
  return record ? toDesign(record) : null;
};

export const uploadDesignFavicon = async (id, blob, filename = 'favicon.png') => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/designs/${id}/favicon`, {
    method: 'PUT',
    body: form
  });
  notifySubscribers();
  return res?.favicon_url || '';
};

export const deleteDesign = async (id) => {
  await sendApi(`/api/aerun/designs/${id}`, {
    method: 'DELETE'
  });
  notifySubscribers();
};
