import { sendApi, pb } from './pocketbase';

/**
 * Subscribes to real-time notifications for a user via PocketBase API.
 */
export const subscribeToUserNotifications = (uid, callback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }

  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi('/api/aerun/me/notifications?limit=100');
      if (!isSubscribed) return;
      const items = (res?.items || []).map(n => ({
        id: n.id,
        recipient_uid: n.recipient_id,
        type: n.type,
        read: !!n.read,
        archived: !!n.archived,
        created_at: n.created,
        payload: n.payload || {},
        title: n.title
      }));
      callback(items);
    } catch (err) {
      console.warn('[subscribeToUserNotifications error]', err);
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 15000);

  let unsub = () => {};
  try {
    pb.collection('notifications').subscribe('*', () => {
      load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {}

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    unsub();
  };
};

/**
 * Subscribes to real-time admin notifications.
 */
export const subscribeToAdminNotifications = (callback) => {
  return subscribeToUserNotifications(pb.authStore.record?.id, callback);
};

/**
 * Marks a notification as read.
 */
export const markNotificationRead = async (uid, notifId, isAdmin = false) => {
  if (!notifId) return;
  try {
    await sendApi(`/api/aerun/me/notifications/${notifId}/read`, {
      method: 'PATCH'
    });
  } catch (err) {
    console.warn('[markNotificationRead err]', err);
  }
};

/**
 * Marks topic-related notifications as read.
 */
export const markTopicNotificationsRead = async (uid, topicId, notifs = []) => {
  if (!topicId) return;
  const targetNotifs = notifs.filter(n => n.payload?.topic_id === topicId && !n.read);
  for (const n of targetNotifs) {
    await markNotificationRead(uid, n.id);
  }
};

/**
 * Deletes / archives a notification.
 */
export const deleteNotification = async (uid, notifId, isAdmin = false) => {
  if (!notifId) return;
  try {
    await sendApi(`/api/aerun/me/notifications/${notifId}/archive`, {
      method: 'PATCH'
    });
  } catch (err) {
    console.warn('[deleteNotification err]', err);
  }
};

/**
 * Marks all notifications as read.
 */
export const markAllNotificationsRead = async (uid, notifs = []) => {
  try {
    await sendApi('/api/aerun/me/notifications/read-all', {
      method: 'POST'
    });
  } catch (err) {
    console.warn('[markAllNotificationsRead err]', err);
  }
};

export const markAllAdminNotificationsRead = async (adminNotifs = []) => {
  return await markAllNotificationsRead(null, adminNotifs);
};

export const deleteAllUserNotifications = async (uid) => {
  return await markAllNotificationsRead(uid);
};

export const deleteAllAdminNotifications = async () => {
  return await markAllNotificationsRead(null);
};
