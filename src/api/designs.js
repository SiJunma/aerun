import { sendApi } from './pocketbase';

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
    bgOpacity: raw.bg_opacity ?? raw.bgOpacity ?? 0.5,
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
  if (data.bgOpacity !== undefined) payload.bg_opacity = data.bgOpacity;
  else if (data.bg_opacity !== undefined) payload.bg_opacity = data.bg_opacity;
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
      default: activeCard.bgDefaultUrl,
      tablet: activeCard.bgTabletUrl || activeCard.bgDefaultUrl,
      mobile: activeCard.bgMobileUrl || activeCard.bgDefaultUrl,
    };
  })();
  return {
    background,
    opacity: activeCard?.bgOpacity ?? 0.5,
    headerHtml: pick(activeCard?.headerHtml, activeCard?.overwriteHeader, settingsHeader),
    footerHtml: pick(activeCard?.customFooterHtml, activeCard?.overwriteFooter, settings?.customFooterHtml || ''),
    forumTitle: pick(activeCard?.forumTitle, activeCard?.overwriteTitle, settingsTitle, 'Aerun Forum'),
    faviconUrl: pick(activeCard?.faviconUrl, activeCard?.overwriteFavicon, settings?.faviconUrl || ''),
    placeholderDeleted: pick(activeCard?.placeholderDeletedUrl, activeCard?.overwritePlaceholderDeleted, settings?.deletedAvatar || ''),
    placeholderGuest: pick(activeCard?.placeholderGuestUrl, activeCard?.overwritePlaceholderGuest, settings?.guestAvatar || ''),
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
  return (_cachedDefaultDesigns || []).find(d => d.key === key || d.id === key) || null;
};

export const updateDefaultDesign = async (key, designData) => {
  const payload = toDefaultDesignPayload(designData);
  const record = await sendApi(`/api/aerun/default-designs/${key}`, {
    method: 'PATCH',
    body: payload
  });
  notifyDefaultDesignSubscribers();
  return record ? toDefaultDesign(record) : null;
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
