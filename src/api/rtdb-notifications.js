import { sendApi, pb } from './pocketbase';
import { subscribeToRefetch } from './connection';

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

  // The first read after a cold load during an outage resolves to [] and the poll
  // would fix it within 15s — but only if the component is still mounted and the
  // user has not navigated. Re-read immediately on recovery so the inbox is right
  // the moment the banner disappears.
  const offRestored = subscribeToRefetch(load);

  let unsub = () => {};
  try {
    pb.collection('notifications').subscribe('*', () => {
      load();
    }).then(fn => { unsub = fn; }).catch(() => {});
  } catch {
    // Best-effort realtime: the interval above already polls, so a failed
    // subscription costs freshness, not correctness.
  }

  return () => {
    isSubscribed = false;
    clearInterval(interval);
    offRestored();
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
 *
 * The failure is RETHROWN, not swallowed. These used to `console.warn` and
 * resolve normally, so the caller's `await` never rejected and the success toast
 * fired even when the server returned 403/500 — telling the member their
 * notification was read when it was not. Polling would eventually reconcile it,
 * but a lie that self-corrects in 15 seconds is still a lie.
 */
export const markNotificationRead = async (_uid, notifId, _isAdmin = false) => {
  if (!notifId) return;
  await sendApi(`/api/aerun/me/notifications/${notifId}/read`, {
    method: 'PATCH'
  });
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
export const deleteNotification = async (_uid, notifId, _isAdmin = false) => {
  if (!notifId) return;
  await sendApi(`/api/aerun/me/notifications/${notifId}/archive`, {
    method: 'PATCH'
  });
};

/**
 * Marks all notifications as read.
 *
 * Rethrown for the same reason as markNotificationRead: a swallowed rejection
 * here makes "mark all read" report success for a request that never landed.
 */
export const markAllNotificationsRead = async (_uid, _notifs = []) => {
  await sendApi('/api/aerun/me/notifications/read-all', {
    method: 'POST'
  });
};

export const markAllAdminNotificationsRead = async (adminNotifs = []) => {
  return await markAllNotificationsRead(null, adminNotifs);
};

// These archive rather than mark read.
//
// They used to call markAllNotificationsRead, i.e. POST /me/notifications/
// read-all: nothing was removed and every row came back as READ, while the
// button said "clear all" and the toast said "all cleared". Clearing an inbox
// and silencing it are different acts; this one now does what it is labelled.
export const deleteAllUserNotifications = async (_uid) => {
  await sendApi('/api/aerun/me/notifications/archive-all', { method: 'POST' });
};

export const deleteAllAdminNotifications = async () => {
  await sendApi('/api/aerun/me/notifications/archive-all', { method: 'POST' });
};
