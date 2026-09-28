import { sendApi } from './pocketbase';

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
    const res = await sendApi('/api/aerun/designs');
    const items = res?.items || [];
    return items.map(r => ({ id: r.id, ...r }));
  } catch {
    // collection might not exist in PocketBase schema; fallback to local designs
  }
  return getLocalDesigns();
};

export const getDesign = async (id) => {
  try {
    const record = await sendApi(`/api/aerun/designs/${id}`);
    if (record) {
      return { id: record.id, ...record };
    }
  } catch {}
  return getLocalDesigns().find(d => d.id === id) || null;
};

export const createDesign = async (designData) => {
  try {
    const record = await sendApi('/api/aerun/designs', {
      method: 'POST',
      body: designData
    });
    if (record?.id) {
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
    await sendApi(`/api/aerun/designs/${id}`, {
      method: 'PATCH',
      body: designData
    });
    return;
  } catch {}
  const list = getLocalDesigns().map(d => d.id === id ? { ...d, ...designData, updatedAt: new Date().toISOString() } : d);
  setLocalDesigns(list);
};

export const deleteDesign = async (id) => {
  try {
    await sendApi(`/api/aerun/designs/${id}`, {
      method: 'DELETE'
    });
    return;
  } catch {}
  const list = getLocalDesigns().filter(d => d.id !== id);
  setLocalDesigns(list);
};
