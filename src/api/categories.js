import { sendApi } from './pocketbase';
import { subscribeToRefetch } from './connection';
import { PERMISSIONS } from '../constants/permissions';
import { makeStorageKey } from '../utils/storageScope';

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

const CAT_GROUPS_CACHE_KEY = makeStorageKey('cat_groups');
const CAT_GROUPS_TTL_MS = 60 * 60 * 1000; // 1 час

// The command contract stores ONE string per label, and for a long time the
// reads pretended that string was both languages: `{ en: s, ru: s }`. The
// contract now serves {en, ru} objects (the admin board edits two languages per
// label), so the map passes through as-is and only a plain string — a legacy
// row, or an older backend — is duplicated into both languages.
const toTitleMap = (title) => (typeof title === 'object' && title !== null
  ? { en: title.en || '', ru: title.ru || '' }
  : { en: title || '', ru: title || '' });

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
    body: { title: pickLabel(groupData?.title), sort_order: normalizeOrder(groupData?.order) }
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
  return res?.id;
};

export const updateCategoryGroup = async (id, groupData) => {
  const body = {};
  // Only send what the caller actually supplied: the PATCH handler treats an
  // absent field as "leave alone", and a blanket send would blank a title the
  // form did not load.
  if (groupData?.title !== undefined) body.title = pickLabel(groupData.title);
  if (groupData?.order !== undefined) body.sort_order = normalizeOrder(groupData.order);

  await sendApi(`/api/aerun/category-groups/${id}`, { method: 'PATCH', body });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

export const deleteCategoryGroup = async (id) => {
  await sendApi(`/api/aerun/category-groups/${id}`, { method: 'DELETE' });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

// pickLabel normalises either label shape onto the {en, ru} object the command
// contract accepts, trimmed on the way out.
//
// The languages stay independent: the board has two inputs per label, and an
// EN-only or RU-only label must survive the round trip. This used to be
// `pickTitle`, which collapsed the map to ONE string (Russian first) — so an
// edit to the EN field was accepted by the form, dropped on the way to the
// server, and served back as the RU text in both columns: the toast said
// "saved" while English reverted to Russian.
const pickLabel = (label) => {
  if (typeof label === 'string') {
    const value = label.trim();
    return { en: value, ru: value };
  }
  if (label && typeof label === 'object') {
    return { en: (label.en || '').trim(), ru: (label.ru || '').trim() };
  }
  return { en: '', ru: '' };
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

// toPermissionOverride maps a single permission's stored role list onto the
// admin form's tri-state: an array means "override on, these roles", undefined
// means "inherit from the global role setting". The server stores the inherit
// marker ([INHERIT_ROLES]) for a switched-off override, so it decodes to
// undefined rather than an array that would look like root-only.
const toPermissionOverride = (roles) => {
  if (!Array.isArray(roles)) return undefined;
  if (roles.includes(INHERIT_ROLES)) return undefined;
  return roles;
};

const toCategory = (d) => ({
  id: d.id,
  slug: d.slug,
  title: toTitleMap(d.name),
  description: toTitleMap(d.description),
  group_id: d.group_id || '',
  order: d.sort_order ?? 0,
  permissions: {
    [VIEW_FORUM]: toViewOverride(d.allowed_roles),
    [PERMISSIONS.CREATE_TOPIC]: toPermissionOverride(d.permissions?.[PERMISSIONS.CREATE_TOPIC]),
    [PERMISSIONS.POST_REPLY]: toPermissionOverride(d.permissions?.[PERMISSIONS.POST_REPLY]),
    [PERMISSIONS.USE_MASKS]: toPermissionOverride(d.permissions?.[PERMISSIONS.USE_MASKS]),
    [PERMISSIONS.USE_DICE]: toPermissionOverride(d.permissions?.[PERMISSIONS.USE_DICE]),
  },
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
    // `last_post_author_ref` is the server-authoritative nested AuthorRef
    // (account => user_id/display_name, guest => display_name, null => none).
    // Read it instead of the `||` chain over flat fields: a deleted account
    // renders the placeholder rather than an invented guest, and the category
    // index can never disagree with a topic list about who spoke last.
    ...(d.last_post_author_ref ? { last_post_author_ref: d.last_post_author_ref } : {}),
    last_post_topic_posts_count: d.last_post_topic_posts_count,
    // Server-authoritative unread flag (listForumIndexHandler → unreadTopicIDs),
    // the SAME predicate behind the badge and /new-replies. Propagated only when
    // the server actually had an opinion: a guest's payload omits it, and we
    // keep `undefined` rather than defaulting to false so MainPage can tell
    // "server said read" from "no server answer" and fall back to the
    // localStorage predicate only in the latter case.
    ...(typeof d.unread === 'boolean' ? { unread: d.unread } : {}),
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
export const INHERIT_ROLES = '__aerun_inherit_roles__';

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
// NEITHER latestTopics NOR stats IS OPTIONAL HERE, and their absence was the bug
// this function had. It returned only `categories`, and because AuthProvider
// guards each assignment with `if (data?.x)`, the missing keys were
// indistinguishable from "the server had none":
//
//   - `latestTopics` stayed `[]` forever, so /new-replies was permanently empty,
//   - `forumStats` stayed null, so ForumStats fell back to summing category
//     counters that were themselves being dropped.
//
// latestTopics IS GONE NOW, and that is a fix rather than a regression. It existed
// here for ONE consumer: the navbar's unread-topic badge. Fifty whole topic
// records were fetched on every identity change to render a single integer — and
// that integer was wrong anyway, because it was computed in the browser from a
// capped list (60 unread topics reported as 50) against a per-browser localStorage
// read map, so the same member saw a different count on the phone than on the
// desktop. The count is server state now: `unread_topics` on /me/unread-counts,
// next to the notification and DM counters that were already there and already
// polled on one shared loop. The badge costs no request it was not already making.
//
// The list itself is no longer fetched here. /new-replies reads it, paginated,
// because that is the only screen that renders topic rows — the main page renders
// categories.
//
// The stats read is independent: an unreadable stats endpoint must not blank the
// category list a member came to see.
export const fetchSecuredMainPageData = async () => {
  const [index, stats] = await Promise.all([
    fetchForumIndex().catch(() => ({ categories: [], groups: [] })),
    fetchForumStats(),
  ]);
  return {
    categories: index.categories,
    categoryGroups: index.groups,
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
    name: pickLabel(catData?.title),
    description: pickLabel(catData?.description),
    sort_order: normalizeOrder(catData?.order),
    group_id: catData?.group_id || ''
  };

  const override = catData?.permissions?.[VIEW_FORUM];
  body.allowed_roles = Array.isArray(override)
    ? [...new Set(override)]
    : [INHERIT_ROLES];

  // The permissions map carries the four non-view category-level overrides.
  // view_forum is governed by allowed_roles (with its own inherit marker) and
  // is not duplicated here. A switched-off override stores the inherit marker,
  // so it is read back as "inherit" rather than being dropped silently.
  const perms = catData?.permissions || {};
  const permissions = {};
  [PERMISSIONS.CREATE_TOPIC, PERMISSIONS.POST_REPLY, PERMISSIONS.USE_MASKS, PERMISSIONS.USE_DICE].forEach((permKey) => {
    const val = perms[permKey];
    if (val === undefined || val === null) {
      permissions[permKey] = [INHERIT_ROLES];
    } else {
      permissions[permKey] = [...new Set(val)];
    }
  });
  body.permissions = permissions;

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
