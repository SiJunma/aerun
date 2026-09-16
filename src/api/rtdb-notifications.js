import { rtdb } from '../../firebase';
import {
  ref,
  onValue,
  update,
  remove,
  query,
  limitToLast
} from 'firebase/database';
import { getFunctions, httpsCallable } from 'firebase/functions';

const manageAdminNotifications = async (action, notificationIds) => {
  const manage = httpsCallable(getFunctions(), 'manageAdminNotifications');
  await manage({ action, notificationIds });
};

/**
 * Subscribes to real-time notifications for a user via Realtime Database (0 Firestore reads/writes).
 */
export const subscribeToUserNotifications = (uid, callback) => {
  if (!uid || !rtdb) {
    callback([]);
    return () => {};
  }

  try {
    const notifsRef = ref(rtdb, `notifications/${uid}`);
    const q = query(notifsRef, limitToLast(100));

    return onValue(q, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        callback([]);
        return;
      }

      const list = Object.keys(data).map((key) => ({
        id: key,
        ...data[key]
      }));

      // Sort newest first
      list.sort((a, b) => {
        const aTs = a.created_at || 0;
        const bTs = b.created_at || 0;
        return bTs - aTs;
      });

      callback(list);
    }, (err) => {
      console.warn('[subscribeToUserNotifications error]', err);
      callback([]);
    });
  } catch (err) {
    console.warn('[subscribeToUserNotifications caught]', err);
    callback([]);
    return () => {};
  }
};

/**
 * Subscribes to real-time admin notifications via RTDB.
 */
export const subscribeToAdminNotifications = (callback) => {
  if (!rtdb) {
    callback([]);
    return () => {};
  }

  try {
    const adminNotifsRef = ref(rtdb, 'admin_notifications');
    const q = query(adminNotifsRef, limitToLast(100));

    return onValue(q, (snapshot) => {
      const data = snapshot.val();
      if (!data) {
        callback([]);
        return;
      }

      const list = Object.keys(data).map((key) => ({
        id: key,
        ...data[key]
      }));

      list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      callback(list);
    }, (err) => {
      const errMsg = (err?.message || err?.code || '').toLowerCase();
      if (!errMsg.includes('permission_denied') && !errMsg.includes('permission-denied') && err?.code !== 'PERMISSION_DENIED') {
        console.warn('[subscribeToAdminNotifications error]', err);
      }
      callback([]);
    });
  } catch {
    callback([]);
    return () => {};
  }
};

/**
 * Marks a single notification as read in RTDB.
 */
export const markNotificationRead = async (uid, notifId, isAdmin = false) => {
  if (!notifId || !rtdb) return;
  try {
    if (isAdmin) {
      await manageAdminNotifications('mark_read', [notifId]);
    } else {
      await update(ref(rtdb, `notifications/${uid}/${notifId}`), { read: true });
    }
  } catch (err) {
    console.warn('[markNotificationRead err]', err);
  }
};

/**
 * Marks all notifications as read for a user in RTDB.
 */
export const markAllNotificationsRead = async (uid, notifs = []) => {
  if (!uid || !rtdb) return;
  try {
    const updates = {};
    notifs.forEach((n) => {
      if (!n.read) {
        updates[`notifications/${uid}/${n.id}/read`] = true;
      }
    });
    if (Object.keys(updates).length > 0) {
      await update(ref(rtdb), updates);
    }
  } catch (err) {
    console.warn('[markAllNotificationsRead err]', err);
  }
};

/**
 * Marks all admin notifications as read in RTDB.
 */
export const markAllAdminNotificationsRead = async (adminNotifs = []) => {
  if (!rtdb) return;
  try {
    const notificationIds = adminNotifs.filter((n) => !n.read).map((n) => n.id);
    if (notificationIds.length > 0) await manageAdminNotifications('mark_read', notificationIds);
  } catch (err) {
    console.warn('[markAllAdminNotificationsRead err]', err);
  }
};


/**
 * Marks topic notifications as read for a topic in RTDB.
 */
export const markTopicNotificationsRead = async (uid, topicId, notifs = []) => {
  if (!uid || !topicId || !rtdb) return;
  try {
    const updates = {};
    notifs.forEach((n) => {
      if (!n.read && n.payload?.topic_id === topicId) {
        updates[`notifications/${uid}/${n.id}/read`] = true;
      }
    });
    if (Object.keys(updates).length > 0) {
      await update(ref(rtdb), updates);
    }
  } catch (err) {
    console.warn('[markTopicNotificationsRead err]', err);
  }
};

/**
 * Deletes a notification from RTDB.
 */
export const deleteNotification = async (uid, notifId, isAdmin = false) => {
  if (!notifId || !rtdb) return;
  try {
    if (isAdmin) {
      await manageAdminNotifications('delete', [notifId]);
    } else {
      await remove(ref(rtdb, `notifications/${uid}/${notifId}`));
    }
  } catch (err) {
    console.warn('[deleteNotification err]', err);
  }
};

/**
 * Deletes ALL notifications for a user from RTDB.
 */
export const deleteAllUserNotifications = async (uid) => {
  if (!uid || !rtdb) return;
  try {
    await remove(ref(rtdb, `notifications/${uid}`));
  } catch (err) {
    console.warn('[deleteAllUserNotifications err]', err);
  }
};

/**
 * Deletes ALL admin notifications from RTDB.
 */
export const deleteAllAdminNotifications = async () => {
  if (!rtdb) return;
  try {
    const snapshot = await new Promise((resolve, reject) => {
      onValue(ref(rtdb, 'admin_notifications'), resolve, { onlyOnce: true }, reject);
    });
    const notificationIds = [];
    snapshot.forEach((child) => notificationIds.push(child.key));
    if (notificationIds.length > 0) await manageAdminNotifications('delete', notificationIds);
  } catch (err) {
    console.warn('[deleteAllAdminNotifications err]', err);
  }
};
