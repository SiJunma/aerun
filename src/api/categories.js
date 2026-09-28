import { pb, sendApi } from './pocketbase';
import { logAdminAction } from './audit';

// ── Category Groups ──────────────────────────────────────────────────────────

const CAT_GROUPS_CACHE_KEY = 'aerun_cat_groups';
const CAT_GROUPS_TTL_MS = 60 * 60 * 1000; // 1 час

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
      const data = res?.items || [];
      localStorage.setItem(CAT_GROUPS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
      callback(data);
    } catch {
      if (isSubscribed) callback([]);
    }
  };

  fetchGroups();
  return () => { isSubscribed = false; };
};

export const addCategoryGroup = async (groupData, performerId) => {
  const rec = await pb.collection('category_groups').create(groupData);
  await logAdminAction('category_group_created', performerId, {
    targetId: rec.id,
    title: groupData.title?.en || groupData.title?.ru || 'Unnamed'
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
  return rec.id;
};

export const updateCategoryGroup = async (id, groupData, performerId) => {
  await pb.collection('category_groups').update(id, groupData);
  await logAdminAction('category_group_updated', performerId, {
    targetId: id,
    title: groupData.title?.en || groupData.title?.ru || 'Unnamed'
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

export const deleteCategoryGroup = async (id, performerId) => {
  await pb.collection('category_groups').delete(id);
  await logAdminAction('category_group_deleted', performerId, { targetId: id });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY);
};

// ── Categories ──────────────────────────────────────────────────────────────

export const fetchSecuredCategories = async () => {
  try {
    const data = await sendApi('/api/aerun/categories');
    const cats = data.items || [];
    return cats.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
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

export const addCategory = async (catData, performerId) => {
  const rec = await pb.collection('categories').create(catData);
  await logAdminAction('category_created', performerId, {
    targetId: rec.id,
    title: catData.name || 'Unnamed'
  });
  return rec.id;
};

export const updateCategory = async (id, catData, performerId) => {
  await pb.collection('categories').update(id, catData);
  await logAdminAction('category_updated', performerId, {
    targetId: id,
    title: catData.name || 'Unnamed'
  });
};

export const deleteCategory = async (id, performerId) => {
  await pb.collection('categories').delete(id);
  await logAdminAction('category_deleted', performerId, { targetId: id });
};
