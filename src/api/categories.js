import { db } from '../../firebase';
import { logAdminAction } from './audit';
import {
  collection,
  addDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDoc
} from 'firebase/firestore';

// ── Category Groups ──────────────────────────────────────────────────────────

export const subscribeToCategoryGroups = (callback) => {
  const q = query(collection(db, 'category_groups'), orderBy('order', 'asc'));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
  });
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
};

export const deleteCategoryGroup = async (id, performerId) => {
  await deleteDoc(doc(db, 'category_groups', id));
  await logAdminAction('category_group_deleted', performerId, { targetId: id });
};

// ── Categories ──────────────────────────────────────────────────────────────

import { getFunctions, httpsCallable } from 'firebase/functions';

export const subscribeToCategories = (callback) => {
  let isSubscribed = true;

  const fetchCats = async () => {
    try {
      const functions = getFunctions();
      const getSecured = httpsCallable(functions, 'getSecuredCategories');
      const result = await getSecured();

      if (!isSubscribed) return;

      const cats = result.data.categories || [];
      const sortedCats = cats.sort((a, b) => (a.order || 0) - (b.order || 0));
      callback(sortedCats);
    } catch (err) {
      console.error('[subscribeToCategories]', err);
      if (isSubscribed) callback([]);
    }
  };

  fetchCats();

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
};
