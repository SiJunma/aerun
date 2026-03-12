import { db } from '../../firebase';
import {
  collection,
  addDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  where,
  updateDoc,
  getDocs,
  writeBatch,
  serverTimestamp
} from 'firebase/firestore';

/**
 * Notifications schema (Firestore collection: "notifications")
 *
 * {
 *   recipient_uid : string | null,  // null = admin-broadcast (e.g. new_registration)
 *   type          : string,          // 'new_registration' | 'topic_reply' | 'pm' | 'news' | …
 *   read          : boolean,
 *   archived      : boolean,
 *   created_at    : Timestamp,
 *   payload       : {
 *     // new_registration:
 *     uid?          : string,
 *     nickname?     : string,
 *     email?        : string,
 *     admin_message?: string,
 *     // future types will add their own fields here
 *   }
 * }
 *
 * recipient_uid = null  → admin-only broadcast (read by anyone with role_id==='admin')
 * recipient_uid = <uid> → personal notification for that user
 */

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a new notification.
 * @param {'new_registration'|string} type
 * @param {Object} payload  - type-specific data
 * @param {string|null} recipientUid - null for admin broadcasts
 */
export const createNotification = async (type, payload, recipientUid = null) => {
  await addDoc(collection(db, 'notifications'), {
    recipient_uid: recipientUid,
    type,
    read: false,
    archived: false,
    created_at: serverTimestamp(),
    payload: payload ?? {}
  });
};

// ── Subscribe ────────────────────────────────────────────────────────────────

/**
 * Subscribe to admin-broadcast notifications (recipient_uid === null).
 * @param {boolean} archived - filter by archived status
 */
export const subscribeToAdminNotifications = (callback, archived = false) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', null),
    where('archived', '==', archived),
    orderBy('created_at', 'desc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[subscribeToAdminNotifications]', err));
};

/**
 * Subscribe to personal notifications for a specific user.
 */
export const subscribeToUserNotifications = (uid, callback, archived = false) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', uid),
    where('archived', '==', archived),
    orderBy('created_at', 'desc')
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[subscribeToUserNotifications]', err));
};

// ── Mark read ────────────────────────────────────────────────────────────────

export const markNotificationRead = async (id) => {
  await updateDoc(doc(db, 'notifications', id), { read: true });
};

export const archiveNotification = async (id) => {
  await updateDoc(doc(db, 'notifications', id), { archived: true, read: true });
};

/**
 * Mark all unread admin-broadcast notifications as read.
 */
export const markAllAdminNotificationsRead = async () => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', null),
    where('archived', '==', false),
    where('read', '==', false)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
};

/**
 * Archive all admin notifications (the ones currently in the active tab)
 */
export const archiveAllAdminNotifications = async () => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', null),
    where('archived', '==', false)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { archived: true, read: true }));
  await batch.commit();
};
