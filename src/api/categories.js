import { sendApi } from './pocketbase';

// Category and category-group access.
//
// Writes go through the /api/aerun command layer. They used to call
// `pb.collection('categories').create(...)` directly, which the locked browser
// rules refuse with "Only superusers can..." — so the admin Categories tab
// failed silently while the reads beside it worked, which is why this looked
// like a data problem rather than a dead endpoint.
//
// Server-side auditing replaced logAdminAction here: every command writes its
// audit row inside the same transaction as the domain change, so a client-side
// call could only ever duplicate a record that must not exist.

// ── Category Groups ──────────────────────────────────────────────────────────

const CAT_GROUPS_CACHE_KEY = 'aerun_cat_groups';
const CAT_GROUPS_TTL_MS = 60 * 60 * 1000; // 1 час

// The legacy documents stored a {en, ru} title map. The command contract
// collapsed it to a single string (the importer does the same), so the page
// components — which still branch on `typeof title === 'object'` — keep
// working against a plain string without a page-wide rewrite.
const toTitleMap = (title) => ({ en: title || '', ru: title || '' });

export const subscribeToCategoryGroups = (callback) => {
  let isSubscribed = true;

  const fetchGroups = async () => {
    // 1. Try localStorage
    try {
      const raw = localStorage.getItem(CAT_GROUPS_CACHE_KEY);
      if (raw) {
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts < CAT_GROUPS_TTL_MS) {
          if (isSubscribed) callback(data);
          return;
        }
      }
    } catch { /* Cache corrupted */ }

    // 2. Fetch from Aerun backend or local fallback
    try {
      const res = await sendApi('/api/aerun/category-groups');
      if (!isSubscribed) return;
      const data = (res?.items || []).map(g => ({
        id: g.id,
        title: toTitleMap(g.title),
        order: g.sort_order ?? 0
      }));
      localStorage.setItem(CAT_GROUPS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
      callback(data);
    } catch {
      if (isSubscribed) callback([]);
    }
  };

  fetchGroups();
  return () => { isSubscribed = false; };
};

export const addCategoryGroup = async (groupData) => {
  const res = await sendApi('/api/aerun/category-groups', {
    method: 'POST',
    body: { title: pickTitle(groupData?.title), sort_order: normalizeOrder(groupData?.order) }
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
  return res?.id;
};

export const updateCategoryGroup = async (id, groupData) => {
  const body = {};
  // Only send what the caller actually supplied: the PATCH handler treats an
  // absent field as "leave alone", and a blanket send would blank a title the
  // form did not load.
  if (groupData?.title !== undefined) body.title = pickTitle(groupData.title);
  if (groupData?.order !== undefined) body.sort_order = normalizeOrder(groupData.order);

  await sendApi(`/api/aerun/category-groups/${id}`, { method: 'PATCH', body });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

export const deleteCategoryGroup = async (id) => {
  await sendApi(`/api/aerun/category-groups/${id}`, { method: 'DELETE' });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

// pickTitle collapses the legacy {en, ru} map to the single string the command
// accepts.
//
// `ru` is preferred because the admin board defaults to it, but this must not
// silently discard an EN-only category: the legacy board has two independent
// inputs per label, and the target schema has one string. A label that only
// exists in one language therefore survives, and an admin who fills both gets
// the Russian text — which is the language the board renders by default.
const pickTitle = (title) => {
  if (typeof title === 'string') return title.trim();
  if (title && typeof title === 'object') {
    const ru = (title.ru || '').trim();
    const en = (title.en || '').trim();
    return ru || en;
  }
  return '';
};

// normalizeOrder maps the UI's `order` onto the API's `sort_order`. null means
// "let the server append", which is what an unset field should mean.
const normalizeOrder = (order) => {
  const value = Number.parseInt(order, 10);
  return Number.isFinite(value) ? value : null;
};


// ── Categories ──────────────────────────────────────────────────────────────

// The read model is normalised to the shape the page components already expect:
// `title`/`description` as a {en, ru} map, `order` for the column, and
// `permissions.view_forum` for the role picker. Keeping the mapping here means
// the contract change (single strings + allowed_roles) touches one file instead
// of every render site.
const toCategory = (d) => ({
  id: d.id,
  slug: d.slug,
  title: toTitleMap(d.name),
  description: toTitleMap(d.description),
  group_id: d.group_id || '',
  order: d.sort_order ?? 0,
  permissions: { [VIEW_FORUM]: Array.isArray(d.allowed_roles) ? d.allowed_roles : [] }
});

// VIEW_FORUM is the permission key the admin board's role picker is keyed by.
// Hardcoded rather than imported so this module keeps its single dependency on
// the transport; the constant has been stable across the migration.
const VIEW_FORUM = 'view_forum';

export const fetchSecuredCategories = async () => {
  try {
    const data = await sendApi('/api/aerun/categories');
    const cats = (data.items || []).map(toCategory);
    return cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (err) {
    console.error('[fetchSecuredCategories]', err);
    return [];
  }
};

export const fetchSecuredMainPageData = async () => {
  try {
    const cats = await fetchSecuredCategories();
    return {
      categories: cats,
      categoryGroups: []
    };
  } catch (err) {
    console.error('[fetchSecuredMainPageData]', err);
    return { categories: [], categoryGroups: [] };
  }
};

export const subscribeToCategories = (callback) => {
  let isSubscribed = true;

  fetchSecuredCategories().then(cats => {
    if (isSubscribed) callback(cats);
  });

  return () => {
    isSubscribed = false;
  };
};

export const subscribeToAllCategories = (callback) => {
  let isSubscribed = true;
  fetchSecuredCategories().then(cats => {
    if (isSubscribed) callback(cats);
  });
  return () => {
    isSubscribed = false;
  };
};

// toCategoryPayload maps the admin form onto the command contract.
//
// Three details are not cosmetic:
//   - the slug is NOT sent: the server derives it from the name and owns the
//     UNIQUE key, so a client slug would only create a second answer to the
//     same question;
//   - allowed_roles always goes, including as `[]`. An empty list is the
//     root-only instruction (ADR-1), so omitting it would silently keep the
//     previous list instead of applying the admin's choice;
//   - group_id goes even when empty, because that is how a category leaves a
//     group. The server maps "" and the "unassigned" sentinel to "no group".
const toCategoryPayload = (catData) => {
  const body = {
    name: pickTitle(catData?.title),
    description: pickTitle(catData?.description),
    sort_order: normalizeOrder(catData?.order),
    group_id: catData?.group_id || ''
  };

  const roles = catData?.permissions?.[VIEW_FORUM];
  if (Array.isArray(roles)) {
    body.allowed_roles = [...new Set(roles)];
  }
  return body;
};

export const addCategory = async (catData) => {
  const res = await sendApi('/api/aerun/categories', {
    method: 'POST',
    body: toCategoryPayload(catData)
  });
  return res?.id;
};

export const updateCategory = async (id, catData) => {
  await sendApi(`/api/aerun/categories/${id}`, {
    method: 'PATCH',
    body: toCategoryPayload(catData)
  });
};

export const deleteCategory = async (id) => {
  await sendApi(`/api/aerun/categories/${id}`, { method: 'DELETE' });
};
