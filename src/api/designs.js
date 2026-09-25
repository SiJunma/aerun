import { pb } from './pocketbase';

const LOCAL_STORAGE_KEY = 'aerun_custom_designs';

const getLocalDesigns = () => {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const setLocalDesigns = (designs) => {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(designs));
  } catch {}
};

export const subscribeToDesigns = (callback) => {
  let isMounted = true;
  getDesigns().then(d => {
    if (isMounted) callback(d);
  }).catch(() => {
    if (isMounted) callback([]);
  });
  return () => { isMounted = false; };
};

export const getDesigns = async () => {
  try {
    if (pb) {
      const records = await pb.collection('designs').getFullList({ sort: '-created' });
      return records.map(r => ({ id: r.id, ...r }));
    }
  } catch {
    // collection might not exist in PocketBase schema; fallback to local designs
  }
  return getLocalDesigns();
};

export const getDesign = async (id) => {
  try {
    if (pb) {
      const record = await pb.collection('designs').getOne(id);
      return { id: record.id, ...record };
    }
  } catch {}
  return getLocalDesigns().find(d => d.id === id) || null;
};

export const createDesign = async (designData) => {
  try {
    if (pb) {
      const record = await pb.collection('designs').create(designData);
      return record.id;
    }
  } catch {}
  const id = `design_${Date.now()}`;
  const list = getLocalDesigns();
  list.push({ id, ...designData, createdAt: new Date().toISOString() });
  setLocalDesigns(list);
  return id;
};

export const updateDesign = async (id, designData) => {
  try {
    if (pb) {
      await pb.collection('designs').update(id, designData);
      return;
    }
  } catch {}
  const list = getLocalDesigns().map(d => d.id === id ? { ...d, ...designData, updatedAt: new Date().toISOString() } : d);
  setLocalDesigns(list);
};

export const deleteDesign = async (id) => {
  try {
    if (pb) {
      await pb.collection('designs').delete(id);
      return;
    }
  } catch {}
  const list = getLocalDesigns().filter(d => d.id !== id);
  setLocalDesigns(list);
};
