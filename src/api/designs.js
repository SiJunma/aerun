import { sendApi } from './pocketbase.js';
import { resolveAvatarUrl } from './avatars.js';

const LOCAL_STORAGE_KEY = 'aerun_custom_designs';

export const BUILTIN_THEMES = ['dark', 'light', 'neutral'];

// The base a custom design is layered on: the design's own base_theme when
// set, otherwise the forum's default built-in theme, otherwise dark. Old
// designs without base_theme keep the previous behaviour (global default).
export function resolveDesignBaseTheme(design, settings) {
  if (design?.baseTheme && BUILTIN_THEMES.includes(design.baseTheme)) return design.baseTheme;
  if (settings?.defaultDesignId && BUILTIN_THEMES.includes(settings.defaultDesignId)) return settings.defaultDesignId;
  return 'dark';
}

const OVERWRITE_FIELDS = [
  'overwriteHeader',
  'overwriteFooter',
  'overwriteTitle',
  'overwriteFavicon',
  'overwriteCss',
  'overwriteJs',
  'overwritePlaceholderDeleted',
  'overwritePlaceholderGuest',
];

const OVERWRITE_SNAKE = {
  overwriteHeader: 'overwrite_header',
  overwriteFooter: 'overwrite_footer',
  overwriteTitle: 'overwrite_title',
  overwriteFavicon: 'overwrite_favicon',
  overwriteCss: 'overwrite_css',
  overwriteJs: 'overwrite_js',
  overwritePlaceholderDeleted: 'overwrite_placeholder_deleted',
  overwritePlaceholderGuest: 'overwrite_placeholder_guest',
};

function readOverwrite(raw, camel, snake) {
  if (raw?.[snake] !== undefined) return Boolean(raw[snake]);
  if (raw?.[camel] !== undefined) return Boolean(raw[camel]);
  return false;
}

function readString(raw, snake, camel) {
  const v = raw?.[snake] ?? raw?.[camel];
  return typeof v === 'string' ? v : (v ?? '');
}

export function toDesign(raw) {
  if (!raw) return null;
  const design = {
    id: raw.id,
    name: raw.name || '',
    description: raw.description || '',
    css: raw.css || '',
    js: raw.js || '',
    forumTitle: raw.forum_title ?? raw.forumTitle ?? '',
    faviconUrl: raw.favicon_url ?? raw.faviconUrl ?? '',
    baseTheme: raw.base_theme ?? raw.baseTheme ?? '',
    isActive: raw.is_active !== undefined ? Boolean(raw.is_active) : (raw.isActive !== undefined ? Boolean(raw.isActive) : true),
    showInList: raw.show_in_list !== undefined ? Boolean(raw.show_in_list) : (raw.showInList !== undefined ? Boolean(raw.showInList) : true),
    headerHtml: raw.header_html ?? raw.headerHtml ?? '',
    customFooterHtml: raw.custom_footer_html ?? raw.customFooterHtml ?? '',
    bgDefaultUrl: readString(raw, 'bg_default_url', 'bgDefaultUrl'),
    bgTabletUrl: readString(raw, 'bg_tablet_url', 'bgTabletUrl'),
    bgMobileUrl: readString(raw, 'bg_mobile_url', 'bgMobileUrl'),
    placeholderDeletedUrl: readString(raw, 'placeholder_deleted_url', 'placeholderDeletedUrl'),
    placeholderGuestUrl: readString(raw, 'placeholder_guest_url', 'placeholderGuestUrl'),
    createdAt: raw.created_at || raw.createdAt || '',
    updatedAt: raw.updated_at || raw.updatedAt || '',
  };
  for (const field of OVERWRITE_FIELDS) {
    design[field] = readOverwrite(raw, field, OVERWRITE_SNAKE[field]);
  }
  return design;
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
  if (data.baseTheme !== undefined) payload.base_theme = data.baseTheme;
  else if (data.base_theme !== undefined) payload.base_theme = data.base_theme;
  if (data.isActive !== undefined) payload.is_active = Boolean(data.isActive);
  else if (data.is_active !== undefined) payload.is_active = Boolean(data.is_active);
  if (data.showInList !== undefined) payload.show_in_list = Boolean(data.showInList);
  else if (data.show_in_list !== undefined) payload.show_in_list = Boolean(data.show_in_list);
  if (data.headerHtml !== undefined) payload.header_html = data.headerHtml;
  else if (data.header_html !== undefined) payload.header_html = data.header_html;
  if (data.customFooterHtml !== undefined) payload.custom_footer_html = data.customFooterHtml;
  else if (data.custom_footer_html !== undefined) payload.custom_footer_html = data.custom_footer_html;
  if (data.bgDefaultUrl !== undefined) payload.bg_default_url = data.bgDefaultUrl;
  else if (data.bg_default_url !== undefined) payload.bg_default_url = data.bg_default_url;
  if (data.bgTabletUrl !== undefined) payload.bg_tablet_url = data.bgTabletUrl;
  else if (data.bg_tablet_url !== undefined) payload.bg_tablet_url = data.bg_tablet_url;
  if (data.bgMobileUrl !== undefined) payload.bg_mobile_url = data.bgMobileUrl;
  else if (data.bg_mobile_url !== undefined) payload.bg_mobile_url = data.bg_mobile_url;
  if (data.placeholderDeletedUrl !== undefined) payload.placeholder_deleted_url = data.placeholderDeletedUrl;
  else if (data.placeholder_deleted_url !== undefined) payload.placeholder_deleted_url = data.placeholder_deleted_url;
  if (data.placeholderGuestUrl !== undefined) payload.placeholder_guest_url = data.placeholderGuestUrl;
  else if (data.placeholder_guest_url !== undefined) payload.placeholder_guest_url = data.placeholder_guest_url;
  for (const field of OVERWRITE_FIELDS) {
    const snake = OVERWRITE_SNAKE[field];
    if (data[field] !== undefined) payload[snake] = Boolean(data[field]);
    else if (data[snake] !== undefined) payload[snake] = Boolean(data[snake]);
  }
  return payload;
}

// A default-design record mirrors a custom design (same fields + key) but
// has no base theme and no activation: it IS a base theme.
export function toDefaultDesign(raw) {
  if (!raw) return null;
  const design = toDesign(raw);
  design.key = raw.key || '';
  design.isDefaultDesign = true;
  delete design.baseTheme;
  delete design.isActive;
  return design;
}

function toDefaultDesignPayload(data) {
  const payload = toDesignPayload(data);
  delete payload.base_theme;
  delete payload.is_active;
  return payload;
}

// Resolve the effective values of the active card: overwrite toggle ON means
// the card's own value wins (empty card value falls through to the ultimate
// default); OFF means the value comes from surface 1 (the settings snapshot).
// The card's base theme NEVER participates: the chain is card -> surface 1
// -> ultimate default. Background has no toggle and no parent value — it
// lives only on the card. CSS/JS are not part of this resolver: they flow via
// activeDesign.css/js injection (DesignProvider applies the overwrite toggle
// there, OFF meaning "no own code").
//
// Every URL this returns is something an <img src> / link href can actually
// load: a relative /api/files path is resolved against the backend origin
// (pbUrl) through resolveAvatarUrl, the same helper avatars, placeholders
// and the favicon already use. A bare relative path would resolve against
// the FRONTEND origin — in local dev that is the Vite server (:5173) while
// PocketBase serves files at :8090, so the browser got HTML (a 304 with
// Type text/html) instead of the image and the background never appeared,
// even though the upload, the card and the theme were all correct. Absolute
// URLs pass through unchanged. Render sites must use these values raw and
// must NOT resolve them a second time (resolveAvatarUrl is idempotent, so a
// second pass is harmless, but the single mechanism lives here).
export function resolveActiveDesign(settings, activeCard) {
  const settingsTitle = (() => {
    const raw = settings?.forumName;
    if (typeof raw === 'object' && raw !== null) return raw.ru || raw.en || '';
    return typeof raw === 'string' ? raw : '';
  })();
  const settingsHeader = (() => {
    const raw = settings?.headerHtml;
    if (typeof raw === 'object' && raw !== null) return raw.ru || raw.en || '';
    return typeof raw === 'string' ? raw : '';
  })();
  const pick = (cardValue, overwrite, settingsValue, ultimate = '') => {
    if (activeCard && overwrite) return cardValue || ultimate;
    return settingsValue || ultimate;
  };
  const background = (() => {
    if (!activeCard || !activeCard.bgDefaultUrl) return null;
    return {
      default: resolveAvatarUrl(activeCard.bgDefaultUrl),
      tablet: resolveAvatarUrl(activeCard.bgTabletUrl || activeCard.bgDefaultUrl),
      mobile: resolveAvatarUrl(activeCard.bgMobileUrl || activeCard.bgDefaultUrl),
    };
  })();
  return {
    background,
    headerHtml: pick(activeCard?.headerHtml, activeCard?.overwriteHeader, settingsHeader),
    footerHtml: pick(activeCard?.customFooterHtml, activeCard?.overwriteFooter, settings?.customFooterHtml || ''),
    forumTitle: pick(activeCard?.forumTitle, activeCard?.overwriteTitle, settingsTitle, 'Aerun Forum'),
    faviconUrl: resolveAvatarUrl(pick(activeCard?.faviconUrl, activeCard?.overwriteFavicon, settings?.faviconUrl || '')),
    placeholderDeleted: resolveAvatarUrl(pick(activeCard?.placeholderDeletedUrl, activeCard?.overwritePlaceholderDeleted, settings?.deletedAvatar || '')),
    placeholderGuest: resolveAvatarUrl(pick(activeCard?.placeholderGuestUrl, activeCard?.overwritePlaceholderGuest, settings?.guestAvatar || '')),
  };
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

// --- List summaries vs full records ---------------------------------------
// The list endpoints return LIGHTWEIGHT summaries only — no css/js/header/
// footer/title/favicon/placeholder/overwrite fields:
//
//   custom:  id, name, show_in_list, bg_default_url, is_active, base_theme
//   default: id, key, name, show_in_list, bg_default_url
//
// toDesign/toDefaultDesign stay valid inputs for both shapes: every
// full-only field defaults to ''/false when the summary omits it, so a
// summary card renders (name, flags, background) without ever pretending
// to carry the full record. Anything that needs a full field — the active
// design, the edit modal, a clone — must use a single-record GET below
// (getDesign / getDefaultDesign / fetchSingleDesign / loadDesignForEdit),
// never the lists.

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
  const updated = record ? toDesign(record) : null;
  // A successful save overwrites the modal's session copy, so the next open
  // shows what was just saved instead of the pre-edit snapshot.
  if (updated) writeDesignCache('custom', id, updated);
  return updated;
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
  removeDesignCache('custom', id);
  notifySubscribers();
};

// --- Card image uploads (background / placeholders) -----------------------
// kind for background: 'default' | 'tablet' | 'mobile' — the server answers
// { bg_{kind}_url, design }. kind for placeholder: 'deleted' | 'guest' —
// the server answers { placeholder_{kind}_url, design }.
const BACKGROUND_URL_FIELD = {
  default: 'bg_default_url',
  tablet: 'bg_tablet_url',
  mobile: 'bg_mobile_url',
};

const PLACEHOLDER_URL_FIELD = {
  deleted: 'placeholder_deleted_url',
  guest: 'placeholder_guest_url',
};

export const uploadDesignBackground = async (id, kind, blob, filename = `${kind}.png`) => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/designs/${id}/background/${kind}`, {
    method: 'PUT',
    body: form
  });
  notifySubscribers();
  return res?.[BACKGROUND_URL_FIELD[kind]] || '';
};

export const uploadDesignPlaceholder = async (id, kind, blob, filename = `${kind}.png`) => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/designs/${id}/placeholder/${kind}`, {
    method: 'PUT',
    body: form
  });
  notifySubscribers();
  return res?.[PLACEHOLDER_URL_FIELD[kind]] || '';
};

// --- Default designs (built-in themes as cards) ---------------------------

let _cachedDefaultDesigns = null;
const _defaultDesignSubscribers = new Set();
let _inFlightDefaultDesigns = null;

const notifyDefaultDesignSubscribers = async () => {
  try {
    const list = await getDefaultDesigns(true);
    _cachedDefaultDesigns = list;
    _defaultDesignSubscribers.forEach(cb => {
      try { cb(list); } catch (e) { console.error(e); }
    });
  } catch (err) {
    console.error('[default-designs] error notifying subscribers', err);
  }
};

export const subscribeToDefaultDesigns = (callback) => {
  _defaultDesignSubscribers.add(callback);
  if (_cachedDefaultDesigns) {
    try { callback(_cachedDefaultDesigns); } catch (e) { console.error(e); }
  }
  getDefaultDesigns().then(d => {
    _cachedDefaultDesigns = d;
    try { callback(d); } catch (e) { console.error(e); }
  }).catch(() => {
    if (!_cachedDefaultDesigns) {
      try { callback([]); } catch (e) { console.error(e); }
    }
  });
  return () => {
    _defaultDesignSubscribers.delete(callback);
  };
};

export const getDefaultDesigns = async (force = false) => {
  if (!force && _cachedDefaultDesigns) return _cachedDefaultDesigns;
  if (force) {
    _inFlightDefaultDesigns = null;
  }
  if (!force && _inFlightDefaultDesigns) return _inFlightDefaultDesigns;
  const flight = (async () => {
    try {
      const res = await sendApi('/api/aerun/default-designs');
      const items = res?.items || [];
      const mapped = items.map(toDefaultDesign);
      _cachedDefaultDesigns = mapped;
      return mapped;
    } catch (err) {
      console.warn('[default-designs] failed to fetch from server', err);
      return _cachedDefaultDesigns || [];
    }
  })();
  if (!force) _inFlightDefaultDesigns = flight;
  flight.finally(() => {
    if (_inFlightDefaultDesigns === flight) _inFlightDefaultDesigns = null;
  });
  return flight;
};

export const getDefaultDesign = async (key) => {
  try {
    const record = await sendApi(`/api/aerun/default-designs/${key}`);
    if (record) {
      return toDefaultDesign(record);
    }
  } catch (err) {
    console.warn(`[default-designs] failed to fetch default design ${key}`, err);
  }
  // No list-cache fallback here on purpose: the cached lists are SUMMARIES
  // now, and handing one out as a full record would let the edit modal save
  // its empty css/js/header over the card's real values. A failed single
  // GET answers null, and the caller falls back to the built-in theme.
  return null;
};

// --- Single-record fetch + edit-modal session cache ------------------------
// One theme, one GET (two at most): a built-in key ('dark'/'light'/'neutral')
// resolves to the default-design record by key; any other id is tried as a
// custom record by id first, then as a default-design record by id. Either
// order is safe — a custom id can never equal a builtin key, and the two
// collections have disjoint ids — but custom-first keeps the common preview
// path (custom designs) to a single request. This is the only way the active
// design is resolved once the embedded settings card cannot answer the
// target — full lists are never fetched for it, and the theme picker never
// fetches lists to apply a theme either.
export async function fetchSingleDesign(targetId) {
  if (!targetId) return null;
  if (BUILTIN_THEMES.includes(targetId)) return getDefaultDesign(targetId);
  return (await getDesign(targetId)) ?? (await getDefaultDesign(targetId));
}

// The edit modal loads its full record once per session and reuses it:
// sessionStorage, keyed by design id, with custom and default designs in
// separate namespaces so a custom id can never collide with a default key.
// Stale-within-session is acceptable (the user asked for it); a successful
// save overwrites the entry (see updateDesign/updateDefaultDesign below),
// and a delete drops it. `options.storage` exists so the node test can
// inject a fake store — in the browser it defaults to sessionStorage, and
// when storage is unavailable the helpers degrade to fetch-every-time.
export const DESIGN_CACHE_KEY_PREFIX = {
  custom: 'aerun_design_cache:custom:',
  default: 'aerun_design_cache:default:',
};

export function designCacheKey(kind, identifier) {
  return `${DESIGN_CACHE_KEY_PREFIX[kind] || DESIGN_CACHE_KEY_PREFIX.custom}${identifier}`;
}

function resolveDesignCacheStorage(options) {
  if (options?.storage) return options.storage;
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function mapCachedDesign(kind, raw) {
  if (!raw || typeof raw !== 'object') return null;
  return kind === 'default' ? toDefaultDesign(raw) : toDesign(raw);
}

export function readDesignCache(kind, identifier, options = {}) {
  const storage = resolveDesignCacheStorage(options);
  if (!storage) return null;
  try {
    const raw = storage.getItem(designCacheKey(kind, identifier));
    if (!raw) return null;
    return mapCachedDesign(kind, JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeDesignCache(kind, identifier, design, options = {}) {
  const storage = resolveDesignCacheStorage(options);
  if (!storage || !design) return;
  try {
    storage.setItem(designCacheKey(kind, identifier), JSON.stringify(design));
  } catch {
    // Storage full or unavailable — the next open just refetches.
  }
}

export function removeDesignCache(kind, identifier, options = {}) {
  const storage = resolveDesignCacheStorage(options);
  if (!storage) return;
  try {
    storage.removeItem(designCacheKey(kind, identifier));
  } catch {
    // Nothing to do — the entry is gone or unreachable either way.
  }
}

// Load the FULL record for the edit modal: cached copy first, one
// single-record GET on a miss, and the fetched record cached for the next
// open in the same session. Returns { design, fromCache }.
export async function loadDesignForEdit(kind, identifier, options = {}) {
  const cached = readDesignCache(kind, identifier, options);
  if (cached) return { design: cached, fromCache: true };
  const design = kind === 'default'
    ? await getDefaultDesign(identifier)
    : await getDesign(identifier);
  if (design) writeDesignCache(kind, identifier, design, options);
  return { design, fromCache: false };
}

export const updateDefaultDesign = async (key, designData) => {
  const payload = toDefaultDesignPayload(designData);
  const record = await sendApi(`/api/aerun/default-designs/${key}`, {
    method: 'PATCH',
    body: payload
  });
  notifyDefaultDesignSubscribers();
  const updated = record ? toDefaultDesign(record) : null;
  // A successful save overwrites the modal's session copy, so the next open
  // shows what was just saved instead of the pre-edit snapshot.
  if (updated) writeDesignCache('default', key, updated);
  return updated;
};

export const uploadDefaultDesignBackground = async (key, kind, blob, filename = `${kind}.png`) => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/default-designs/${key}/background/${kind}`, {
    method: 'PUT',
    body: form
  });
  notifyDefaultDesignSubscribers();
  return res?.[BACKGROUND_URL_FIELD[kind]] || '';
};

export const uploadDefaultDesignPlaceholder = async (key, kind, blob, filename = `${kind}.png`) => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/default-designs/${key}/placeholder/${kind}`, {
    method: 'PUT',
    body: form
  });
  notifyDefaultDesignSubscribers();
  return res?.[PLACEHOLDER_URL_FIELD[kind]] || '';
};

export const uploadDefaultDesignFavicon = async (key, blob, filename = 'favicon.png') => {
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await sendApi(`/api/aerun/default-designs/${key}/favicon`, {
    method: 'PUT',
    body: form
  });
  notifyDefaultDesignSubscribers();
  return res?.favicon_url || '';
};
