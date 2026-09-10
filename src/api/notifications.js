import { db } from '../../firebase';
import {
  collection,
  addDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  where,
  limit,
  updateDoc,
  getDocs,
  writeBatch,
  serverTimestamp
} from 'firebase/firestore';
import { PERMISSIONS } from '../constants/permissions';

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

/**
 * Send a personal notification to every user whose role includes at least one
 * of the user-management permissions (APPROVE_USERS, BAN_USERS, DELETE_USERS).
 * Also always notifies the root-admin user identified by VITE_ADMIN_EMAIL.
 *
 * This replaces the old admin-broadcast (recipient_uid = null) approach so that
 * only the right people receive registration notifications.
 */
export const notifyUserManagers = async (type, payload) => {
  const USER_MGMT_PERMS = [
    PERMISSIONS.APPROVE_USERS,
    PERMISSIONS.BAN_USERS,
    PERMISSIONS.DELETE_USERS
  ];

  // 1. Fetch all roles from Firestore
  const rolesSnap = await getDocs(collection(db, 'roles'));
  const eligibleRoleIds = new Set();

  rolesSnap.forEach(roleDoc => {
    const perms = roleDoc.data().permissions || [];
    const hasAny = USER_MGMT_PERMS.some(p => perms.includes(p));
    if (hasAny) eligibleRoleIds.add(roleDoc.id);
  });

  if (eligibleRoleIds.size === 0) return;

  // 2. For each eligible role fetch users (Firestore 'in' supports up to 30 values)
  const roleIdList = [...eligibleRoleIds];
  const recipientUids = new Set();

  // Process in chunks of 30 (Firestore limit for 'in' queries)
  for (let i = 0; i < roleIdList.length; i += 30) {
    const chunk = roleIdList.slice(i, i + 30);
    const usersSnap = await getDocs(
      query(collection(db, 'users'), where('role_id', 'in', chunk))
    );
    usersSnap.forEach(u => recipientUids.add(u.id));
  }

  // 3. Also notify the root admin (identified by VITE_ADMIN_EMAIL) in case their
  //    role_id is 'root' which may not be in the Firestore roles collection.
  const adminEmail = import.meta.env.VITE_ADMIN_EMAIL;
  if (adminEmail) {
    const adminSnap = await getDocs(
      query(collection(db, 'users'), where('email', '==', adminEmail))
    );
    adminSnap.forEach(u => recipientUids.add(u.id));
  }

  if (recipientUids.size === 0) return;

  // 4. Create a personal notification for each recipient
  const batch = writeBatch(db);
  for (const uid of recipientUids) {
    const ref = doc(collection(db, 'notifications'));
    batch.set(ref, {
      recipient_uid: uid,
      type,
      read: false,
      archived: false,
      created_at: serverTimestamp(),
      payload: payload ?? {}
    });
  }
  await batch.commit();
};

import {
  subscribeToUserNotifications as subscribeToUserNotificationsRtdb,
  subscribeToAdminNotifications as subscribeToAdminNotificationsRtdb,
  markNotificationRead as markNotificationReadRtdb,
  markTopicNotificationsRead as markTopicNotificationsReadRtdb,
  markAllNotificationsRead as markAllNotificationsReadRtdb,
  markAllAdminNotificationsRead as markAllAdminNotificationsReadRtdb,
  deleteNotification as deleteNotificationRtdb,
  deleteAllUserNotifications as deleteAllUserNotificationsRtdb,
  deleteAllAdminNotifications as deleteAllAdminNotificationsRtdb
} from './rtdb-notifications';

// ── Subscribe (Delegated to RTDB for 0 Firestore read costs) ─────────────────

/**
 * Subscribe to admin-broadcast notifications via RTDB.
 */
export const subscribeToAdminNotifications = (callback) => {
  return subscribeToAdminNotificationsRtdb(callback);
};

/**
 * Subscribe to personal notifications for a specific user via RTDB (0 Firestore reads).
 */
export const subscribeToUserNotifications = (uid, callback) => {
  return subscribeToUserNotificationsRtdb(uid, callback);
};

// ── Mark read & Delete ────────────────────────────────────────────────────────

/**
 * Marks a notification as read.
 * Signature: markNotificationRead(notifId, uid, isAdmin)
 * - notifId: the RTDB/Firestore notification key
 * - uid: the user's uid (only needed for user-owned notifications, null for admin)
 * - isAdmin: true if the notification is in admin_notifications
 */
export const markNotificationRead = async (notifId, uid = null, isAdmin = false) => {
  if (!notifId) return;
  await markNotificationReadRtdb(uid, notifId, isAdmin);
  // Best-effort Firestore sync (personal notifications only, since admin ones are RTDB-only now)
  if (!isAdmin) {
    try {
      await updateDoc(doc(db, 'notifications', notifId), { read: true }).catch(() => { });
    } catch (e) { }
  }
};

export const markTopicNotificationsRead = async (uid, topicId, notifs = []) => {
  if (!uid || !topicId) return;
  await markTopicNotificationsReadRtdb(uid, topicId, notifs);
};

export const clearOrphanedPostNotifications = async (uid, postId) => {
  if (!uid || !postId) return;
};

/**
 * Deletes a notification.
 * Signature: deleteNotification(notifId, uid, isAdmin)
 * - notifId: the RTDB/Firestore notification key
 * - uid: the user's uid (only needed for user-owned notifications, null for admin)
 * - isAdmin: true if the notification is in admin_notifications
 */
export const deleteNotification = async (notifId, uid = null, isAdmin = false) => {
  if (!notifId) return;
  await deleteNotificationRtdb(uid, notifId, isAdmin);
  if (!isAdmin) {
    try {
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'notifications', notifId)).catch(() => { });
    } catch (e) { }
  }
};

// Backwards compatibility alias
export const archiveNotification = deleteNotification;

/**
 * Mark all user notifications as read.
 */
export const markAllNotificationsRead = async (uid, notifs = []) => {
  if (!uid) return;
  await markAllNotificationsReadRtdb(uid, notifs);
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', uid),
      where('read', '==', false)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
    }
  } catch (e) {
    console.warn('[markAllNotificationsRead Firestore]', e);
  }
};

/**
 * Mark all unread admin-broadcast notifications as read.
 */
export const markAllAdminNotificationsRead = async (adminNotifs = []) => {
  await markAllAdminNotificationsReadRtdb(adminNotifs);
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', null),
      where('read', '==', false)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
    }
  } catch (e) {
    console.warn('[markAllAdminNotificationsRead Firestore]', e);
  }
};

export const deleteAllAdminNotifications = async () => {
  // Delete from RTDB first (live source)
  await deleteAllAdminNotificationsRtdb();
  // Best-effort cleanup in Firestore
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', null)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    console.warn('[deleteAllAdminNotifications Firestore]', e);
  }
};

// Backwards compatibility alias
export const archiveAllAdminNotifications = deleteAllAdminNotifications;

export const deleteAllUserNotifications = async (uid) => {
  if (!uid) return;
  // Delete from RTDB first (live source)
  await deleteAllUserNotificationsRtdb(uid);
  // Best-effort cleanup in Firestore
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', uid)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    console.warn('[deleteAllUserNotifications Firestore]', e);
  }
};

// Backwards compatibility alias
export const archiveAllUserNotifications = deleteAllUserNotifications;

// ── Merging Helpers ──────────────────────────────────────────────────────────

/**
 * Finds if there is already an unread/unarchived 'topic_reply' notification 
 * for this user and this topic.
 */
export const getUnreadTopicNotification = async (uid, topicId) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', uid),
    where('type', '==', 'topic_reply'),
    where('read', '==', false),
    where('archived', '==', false),
    where('payload.topic_id', '==', topicId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  // Return the first one (should only be one due to merging logic)
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
};

/**
 * Updates an existing notification's payload and optionally its timestamp.
 */
export const updateNotificationPayload = async (id, newPayload, updateTimestamp = false) => {
  const data = {
    payload: newPayload
  };
  if (updateTimestamp) {
    data.created_at = serverTimestamp();
  }
  await updateDoc(doc(db, 'notifications', id), data);
};

/**
 * When a topic is deleted, remove all notifications related to it.
 */
export const handleTopicDeletionNotifications = async (topicId) => {
  const q = query(
    collection(db, 'notifications'),
    where('payload.topic_id', '==', topicId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
};

/**
 * When a post is deleted, decrement post_count on unread notifications.
 * If count reaches 0, delete the notification.
 */
export const handlePostDeletionNotifications = async (topicId) => {
  const q = query(
    collection(db, 'notifications'),
    where('type', '==', 'topic_reply'),
    where('read', '==', false),
    where('payload.topic_id', '==', topicId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;

  const batch = writeBatch(db);
  snap.docs.forEach(d => {
    const data = d.data();
    const count = data.payload?.post_count || 1;
    if (count <= 1) {
      batch.delete(d.ref);
    } else {
      batch.update(d.ref, {
        'payload.post_count': count - 1
      });
    }
  });
  await batch.commit();
};

export const fetchUnreadTopicNotifications = async (uid, topicId) => {
  if (!uid || !topicId) return [];
  try {
    const q = query(
      collection(db, 'notifications'),
      where('recipient_uid', '==', uid),
      where('read', '==', false),
      where('payload.topic_id', '==', topicId)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error('[fetchUnreadTopicNotifications]', err);
    return [];
  }
};