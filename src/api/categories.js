import { sendApi } from './pocketbase';
import { fetchLatestTopics } from './auth-resources';
import { subscribeToRefetch } from './connection';

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

// fetchSecuredCategoryGroups reads the group list and owns the localStorage
// cache. `useCache: false` forces the network, which is what a caller needs after
// a mutation: the mutation helpers already clear the cache key, but a page that
// only fetched on mount would keep rendering the pre-mutation list until the
// next full reload.
export const fetchSecuredCategoryGroups = async ({ useCache = true } = {}) => {
  if (useCache) {
    try {
      const raw = localStorage.getItem(CAT_GROUPS_CACHE_KEY);
      if (raw) {
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts < CAT_GROUPS_TTL_MS) return data;
      }
    } catch { /* Cache corrupted */ }
  }

  const res = await sendApi('/api/aerun/category-groups');
  const data = (res?.items || []).map(g => ({
    id: g.id,
    title: toTitleMap(g.title),
    order: g.sort_order ?? 0
  }));
  localStorage.setItem(CAT_GROUPS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  return data;
};

export const subscribeToCategoryGroups = (callback) => {
  let isSubscribed = true;

  const load = () => fetchSecuredCategoryGroups()
    .then(data => { if (isSubscribed) callback(data); })
    .catch(() => { if (isSubscribed) callback([]); });

  load();

  // A read that failed while the backend was down settles as an EMPTY list, which
  // is indistinguishable from "there really are no groups". Re-read on recovery so
  // the board does not sit on that empty answer until a manual reload.
  const offRestored = subscribeToRefetch(load);

  return () => {
    isSubscribed = false;
    offRestored();
  };
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
//
// THE COUNTERS AND last_post_* KEYS ARE CARRIED, AND THAT IS THE WHOLE POINT.
// They used to be dropped here, even though listCategoriesHandler computes them
// correctly from the topics table (categoryForumProjections). MainPage then read
// `cat.topics_count || 0` on an object that no longer had the key and rendered
// 0/0 for every category, with "No posts yet" beside it — on a forum with a
// topic in it. Dropping a key is not a normalisation; it is a silent data loss
// that `|| 0` then hides behind a plausible number.
// toViewOverride maps the stored allowed_roles onto the admin form's tri-state:
// an array means "override on, these roles", null means "override off".
//
// The inherit marker reads as null — it is the server's way of saying "no
// override configured", so rendering it as a role would put a non-role in the
// role picker and invite an admin to delete it by hand. An absent list (an older
// backend) stays an empty array, which is ADR-1's root-only.
const toViewOverride = (allowedRoles) => {
  if (!Array.isArray(allowedRoles)) return [];
  return allowedRoles.includes(INHERIT_ROLES) ? null : allowedRoles;
};

const toCategory = (d) => ({
  id: d.id,
  slug: d.slug,
  title: toTitleMap(d.name),
  description: toTitleMap(d.description),
  group_id: d.group_id || '',
  order: d.sort_order ?? 0,
  permissions: { [VIEW_FORUM]: toViewOverride(d.allowed_roles) },
  // Counters are already numbers server-side; `?? 0` covers only a category the
  // server sent without them (an older backend), never a real 0.
  topics_count: d.topics_count ?? 0,
  posts_count: d.posts_count ?? 0,
  // last_post_* are OMITTED when absent on purpose: the server sends them only
  // for a category that has posts, and the index distinguishes "never had a
  // post" (render the empty state) from "has a post with a blank author".
  ...(d.last_post_topic_id ? {
    last_post_topic_id: d.last_post_topic_id,
    last_post_topic_title: d.last_post_topic_title,
    last_post_at: d.last_post_at,
    last_post_author_id: d.last_post_author_id,
    last_post_author: d.last_post_author,
    last_post_author_avatar: d.last_post_author_avatar,
    last_post_topic_posts_count: d.last_post_topic_posts_count,
  } : {})
});

// VIEW_FORUM is the permission key the admin board's role picker is keyed by.
// Hardcoded rather than imported so this module keeps its single dependency on
// the transport; the constant has been stable across the migration.
const VIEW_FORUM = 'view_forum';

// The sentinel the server stores for "this category follows the global role
// settings". It must stay byte-identical to auth.CategoryInheritMarker in Go —
// one side writing a value the other cannot recognise would silently restore
// the snapshot behaviour this replaced, and the mismatch is invisible in review
// because both sides look like plain strings.
const INHERIT_ROLES = '__aerun_inherit_roles__';

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

// fetchAdminCategories is the editor's list, and the ONLY read that carries
// `allowed_roles`.
//
// The public `toCategory` maps that list into `permissions`, so feeding it to
// the admin board would report every category as "inherits the global settings"
// — an override that is switched OFF — and saving the form would then transmit
// the inherit marker over a category that had an explicit role list. That is a
// silent permission change caused by a read, which is why the two shapes are
// separate functions rather than one parameterised one.
// fetchForumIndex reads the categories AND the groups they are filed under in
// ONE request, because the index renders a category inside its group's folder
// and cannot paint anything without both.
//
// It used to issue `GET /categories` (through AuthProvider) and
// `GET /category-groups` (from this page) as two independent reads. They raced:
// a category whose `group_id` named a group the second call had not returned yet
// rendered in the wrong section, or in none at all, until something else forced a
// re-read.
export const fetchForumIndex = async () => {
  const res = await sendApi('/api/aerun/forum-index');
  const cats = (res?.items || []).map(toCategory).sort((a, b) => (a.order || 0) - (b.order || 0));
  return {
    categories: cats,
    groups: (res?.groups || []).map(g => ({
      id: g.id,
      title: toTitleMap(g.title),
      order: g.sort_order ?? 0
    })),
    // The server reports whether the collection exists at all (a database older
    // than migration 1767500000), which is what the index renders as "ungrouped".
    available: res?.available !== false,
  };
};

export const fetchAdminCategories = async () => {
  try {
    const data = await sendApi('/api/aerun/admin/categories');
    const cats = (data.items || []).map(toCategory);
    return cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (err) {
    console.error('[fetchAdminCategories]', err);
    return [];
  }
};

// fetchSecuredMainPageData is the one call that seeds the whole forum shell:
// AuthProvider feeds its `categories`, `categoryGroups`, `latestTopics` and
// `forumStats` context state straight from this return value.
//
// `latestTopics` AND `stats` ARE NOT OPTIONAL HERE, and their absence was the
// bug this function had. It returned only `categories`, and because AuthProvider
// guards each assignment with `if (data?.latestTopics)`, the missing keys were
// indistinguishable from "the server had none":
//
//   - `latestTopics` stayed `[]` forever, so /new-replies and the navbar's
//     unread badge rendered empty for every member, and
//   - `forumStats` stayed null, so ForumStats fell back to summing category
//     counters that were themselves being dropped.
//
// The category read is `fetchForumIndex`, NOT `fetchSecuredCategories`. MainPage
// used to call `subscribeToForumIndex` alongside this one, so opening the forum
// cost two reads of the same rows on two different clocks, and whichever landed
// second won — a category list from `AuthProvider` rendered against the groups of
// a later read. Routing the index through this single call deletes that request
// outright rather than deduplicating it, and leaves `/categories` to the callers
// that genuinely want categories without the grouping.
//
// The two remaining promises are independent: one failing endpoint degrades only
// its own slice, and the forum index still renders. That is deliberate — an
// unreadable stats endpoint must not blank the category list a member came to see.
export const fetchSecuredMainPageData = async () => {
  const [index, topics, stats] = await Promise.all([
    fetchForumIndex().catch(() => ({ categories: [], groups: [] })),
    fetchLatestTopics(50),
    fetchForumStats(),
  ]);
  return {
    categories: index.categories,
    categoryGroups: index.groups,
    latestTopics: topics,
    stats,
  };
};

// fetchForumStats reads the forum-wide totals the stats panel renders.
//
// A failure degrades to null rather than zeros: `null` makes ForumStats fall back
// to its category-derived numbers, whereas a fabricated `{totalTopics: 0}` would
// be indistinguishable from a genuinely empty forum and would be trusted.
const fetchForumStats = async () => {
  try {
    const res = await sendApi('/api/aerun/forum-stats');
    return res?.stats || null;
  } catch (err) {
    console.warn('[fetchForumStats]', err);
    return null;
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

  // fetchAdminCategories, not fetchSecuredCategories: the public list no longer
  // carries `allowed_roles`, so `toCategory` would map every row to the INHERIT
  // marker and the role picker would show "override off" for a category that has
  // an explicit list — and saving would then overwrite that list with the
  // marker. A read would silently change who can see a category.
  const load = () => fetchAdminCategories()
    .then(cats => { if (isSubscribed) callback(cats); })
    .catch(() => { if (isSubscribed) callback([]); });

  load();

  // A read that failed while the backend was down settles as an EMPTY list, which
  // is indistinguishable from an empty board. Re-read on recovery — otherwise the
  // forum keeps claiming it has no categories.
  const offRestored = subscribeToRefetch(load);

  return () => {
    isSubscribed = false;
    offRestored();
  };
};

export const subscribeToForumIndex = (callback) => {
  let isSubscribed = true;

  const load = () => fetchForumIndex()
    .then(data => { if (isSubscribed) callback(data); })
    // A read that failed while the backend was down settles as EMPTY, which is
    // what an empty forum looks like. The caller keeps its own last good render
    // until the recovery signal arrives below.
    .catch(err => {
      console.error('[subscribeToForumIndex]', err);
      if (isSubscribed) callback({ categories: [], groups: [], available: false });
    });

  load();

  // Re-read on recovery so the board does not sit on that empty answer.
  const offRestored = subscribeToRefetch(load);

  return () => {
    isSubscribed = false;
    offRestored();
  };
};

// toCategoryPayload maps the admin form onto the command contract.
//
// Three details are not cosmetic:
//   - the slug is NOT sent: the server derives it from the name and owns the
//     UNIQUE key, so a client slug would only create a second answer to the
//     same question;
//   - allowed_roles ALWAYS goes, and it carries one of three different
//     instructions:
//
//       OVERRIDE OFF → [INHERIT_ROLES], the server-side marker meaning
//                     "resolve visibility from each caller's global
//                     view_forum". This is the whole point of the marker: the
//                     alternative — naming every role that currently has
//                     view_forum — freezes the registry as of this save, so a
//                     role created tomorrow is missing from the array and its
//                     members are refused a public category until an admin
//                     re-saves every category by hand.
//       OVERRIDE ON, roles ticked → exactly those roles.
//       OVERRIDE ON, nothing ticked → []. An empty list is a real instruction,
//                     not "unset": it means root-only (ADR-1), i.e. "nobody
//                     except the root admin may read this category".
//
//     Omitting the key did none of these. On CREATE it left AllowedRoles nil,
//     which became [], so a brand new category was visible to the root admin
//     and to nobody else — the exact opposite of what "off" says. On PATCH a
//     nil key means "leave the current list alone", so switching an override
//     OFF kept the restriction it was supposed to remove, without a word.
//   - group_id goes even when empty, because that is how a category leaves a
//     group. The server maps "" and the "unassigned" sentinel to "no group".
const toCategoryPayload = (catData) => {
  const body = {
    name: pickTitle(catData?.title),
    description: pickTitle(catData?.description),
    sort_order: normalizeOrder(catData?.order),
    group_id: catData?.group_id || ''
  };

  const override = catData?.permissions?.[VIEW_FORUM];
  body.allowed_roles = Array.isArray(override)
    ? [...new Set(override)]
    : [INHERIT_ROLES];
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
