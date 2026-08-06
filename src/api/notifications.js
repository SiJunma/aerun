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

export const markTopicNotificationsRead = async (uid, topicId) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', uid),
    where('type', '==', 'topic_reply'),
    where('read', '==', false),
    where('payload.topic_id', '==', topicId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
};

export const clearOrphanedPostNotifications = async (uid, postId) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', uid),
    where('read', '==', false),
    where('payload.post_id', '==', postId)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
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

export const archiveAllUserNotifications = async (uid) => {
  const q = query(
    collection(db, 'notifications'),
    where('recipient_uid', '==', uid),
    where('archived', '==', false)
  );
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.update(d.ref, { archived: true, read: true }));
  await batch.commit();
};

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