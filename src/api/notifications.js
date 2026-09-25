import { pb } from './pocketbase';
import {
  subscribeToUserNotifications,
  subscribeToAdminNotifications,
  markNotificationRead,
  markTopicNotificationsRead,
  deleteNotification,
  markAllNotificationsRead,
  markAllAdminNotificationsRead,
  deleteAllAdminNotifications,
  deleteAllUserNotifications
} from './rtdb-notifications';

export {
  subscribeToUserNotifications,
  subscribeToAdminNotifications,
  markNotificationRead,
  markTopicNotificationsRead,
  deleteNotification,
  markAllNotificationsRead,
  markAllAdminNotificationsRead,
  deleteAllAdminNotifications,
  deleteAllUserNotifications
};

export const archiveNotification = deleteNotification;

export const createNotification = async (type, payload = {}, recipientUid = null) => {
  try {
    const data = {
      recipient_id: recipientUid || '',
      type,
      title: payload.title || payload.topicTitle || 'Notification',
      payload,
      read: false,
      archived: false
    };
    return await pb.collection('notifications').create(data);
  } catch (err) {
    console.warn('[createNotification err]', err);
  }
};

export const notifyUserManagers = async (type, payload = {}) => {
  try {
    const admins = await pb.collection('users').getFullList({
      filter: `role = "admin" || role = "root"`
    });
    for (const a of admins) {
      await createNotification(type, payload, a.id);
    }
  } catch (err) {
    console.warn('[notifyUserManagers err]', err);
  }
};

export const clearOrphanedPostNotifications = async (uid, postId) => {
  if (!uid || !postId) return;
};