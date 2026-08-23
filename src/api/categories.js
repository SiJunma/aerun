import { db, rtdb } from '../../firebase';
import { logAdminAction } from './audit';
import {
  collection,
  addDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDoc
} from 'firebase/firestore';
import { ref, update, remove } from 'firebase/database';

// ── Category Groups ──────────────────────────────────────────────────────────

const CAT_GROUPS_CACHE_KEY = 'aerun_cat_groups';
const CAT_GROUPS_TTL_MS = 60 * 60 * 1000; // 1 час

export const subscribeToCategoryGroups = (callback) => {
  let isSubscribed = true;

  const fetchGroups = async () => {
    // 1. Пробуем localStorage
    try {
      const raw = localStorage.getItem(CAT_GROUPS_CACHE_KEY);
      if (raw) {
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts < CAT_GROUPS_TTL_MS) {
          if (isSubscribed) callback(data);
          return;
        }
      }
    } catch { /* Кэш повреждён — читаем свежие данные */ }

    // 2. Идём в Firestore
    try {
      const q = query(collection(db, 'category_groups'), orderBy('order', 'asc'));
      const snapshot = await getDocs(q);
      if (!isSubscribed) return;
      const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      localStorage.setItem(CAT_GROUPS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
      callback(data);
    } catch (err) {
      console.error('[subscribeToCategoryGroups]', err);
      if (isSubscribed) callback([]);
    }
  };

  fetchGroups();
  return () => { isSubscribed = false; };
};

export const addCategoryGroup = async (groupData, performerId) => {
  const ref = await addDoc(collection(db, 'category_groups'), {
    ...groupData,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });
  await logAdminAction('category_group_created', performerId, {
    targetId: ref.id,
    title: groupData.title?.en || groupData.title?.ru || 'Unnamed'
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY); // Сброс кэша
  return ref.id;
};

export const updateCategoryGroup = async (id, groupData, performerId) => {
  await updateDoc(doc(db, 'category_groups', id), {
    ...groupData,
    updated_at: serverTimestamp()
  });
  await logAdminAction('category_group_updated', performerId, {
    targetId: id,
    title: groupData.title?.en || groupData.title?.ru || 'Unnamed'
  });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY); // Сброс кэша
};

export const deleteCategoryGroup = async (id, performerId) => {
  await deleteDoc(doc(db, 'category_groups', id));
  await logAdminAction('category_group_deleted', performerId, { targetId: id });
  localStorage.removeItem(CAT_GROUPS_CACHE_KEY); // Сброс кэша
};

// ── Categories ──────────────────────────────────────────────────────────────

import { getFunctions, httpsCallable } from 'firebase/functions';

export const fetchSecuredCategories = async () => {
  try {
    const functions = getFunctions();
    const getSecured = httpsCallable(functions, 'getSecuredCategories');
    const result = await getSecured();
    const cats = result.data.categories || [];
    return cats.sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (err) {
    console.error('[fetchSecuredCategories]', err);
    return [];
  }
};

export const fetchSecuredMainPageData = async () => {
  try {
    const functions = getFunctions();
    const getMainPage = httpsCallable(functions, 'getSecuredMainPageData');
    const result = await getMainPage();
    return result.data;
  } catch (err) {
    console.error('[fetchSecuredMainPageData]', err);
    return { categories: [], latestTopics: [], stats: null, dailyActiveUsers: [] };
  }
};

export const subscribeToCategories = (callback) => {
  let isSubscribed = true;

  fetchSecuredCategories().then(cats => {
    if (isSubscribed) callback(cats);
  });

  // Возвращаем чистую отписку для React
  return () => {
    isSubscribed = false;
  };
};

export const subscribeToAllCategories = (callback) => {
  const q = query(collection(db, 'categories'), orderBy('order', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
};

export const addCategory = async (catData, performerId) => {
  // Normalize: replace null values with undefined so Firestore doesn't store them as null
  const permissions = {};
  if (catData.permissions) {
    for (const [key, val] of Object.entries(catData.permissions)) {
      if (val !== null) permissions[key] = val;
    }
  }
  const ref = await addDoc(collection(db, 'categories'), {
    ...catData,
    permissions,
    group_id: catData.group_id || null,
    topics_count: 0,
    posts_count: 0,
    created_at: serverTimestamp()
  });
  await logAdminAction('category_created', performerId, { targetId: ref.id, title: catData.title?.en || catData.title?.ru || 'Unnamed' });
};

export const updateCategory = async (id, catData, performerId) => {
  const { permissions: rawPerms, ...rest } = catData;
  const permissions = {};
  if (rawPerms) {
    for (const [key, val] of Object.entries(rawPerms)) {
      if (val !== null) permissions[key] = val;
    }
  }
  await updateDoc(doc(db, 'categories', id), {
    ...rest,
    permissions,
    group_id: catData.group_id || null,
    updated_at: serverTimestamp()
  });
  await logAdminAction('category_updated', performerId, { targetId: id, title: catData.title?.en || catData.title?.ru || 'Unnamed' });

  // Immediately patch RTDB main_page_cache so the main page reflects the change
  // without waiting for a full cache rebuild. Only update metadata fields — leave
  // counters (topics_count, posts_count, last_post_*) untouched.
  if (rtdb) {
    try {
      const rtdbPatch = {
        id,
        permissions,
        group_id: catData.group_id || null,
        order: catData.order ?? null,
        updated_at: new Date().toISOString()
      };
      // Multilingual fields — write as-is (objects with {en, ru})
      if (catData.title !== undefined) rtdbPatch.title = catData.title;
      if (catData.description !== undefined) rtdbPatch.description = catData.description;
      await update(ref(rtdb, `main_page_cache/categories/${id}`), rtdbPatch);
    } catch (e) {
      console.warn('[updateCategory RTDB patch err]', e);
    }
  }
};

export const deleteCategory = async (id, performerId) => {
  const catRef = doc(db, 'categories', id);
  const catDoc = await getDoc(catRef);
  let title = 'Unnamed';
  if (catDoc.exists()) {
    const data = catDoc.data();
    title = data.title?.en || data.title?.ru || 'Unnamed';
  }
  await deleteDoc(catRef);
  await logAdminAction('category_deleted', performerId, { targetId: id, title });

  // Remove from RTDB main_page_cache immediately
  if (rtdb) {
    remove(ref(rtdb, `main_page_cache/categories/${id}`)).catch(() => {});
  }
};
