import {
  subscribeToUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  deleteAllUserNotifications
} from './rtdb-notifications';

export {
  subscribeToUserNotifications,
  markNotificationRead,
  deleteNotification,
  markAllNotificationsRead,
  deleteAllUserNotifications
};

// TopicPage marks quotes read as they scroll into view, which is per-notification
// and therefore has no bulk form.
export { markTopicNotificationsRead } from './rtdb-notifications';

export const archiveNotification = deleteNotification;

// There is deliberately NO client-side notification creation.
//
// It used to live here as `createNotification`, writing straight to the
// `notifications` collection. That collection is server-locked, so every such
// write was rejected — while the caller's `.catch(() => {})` swallowed the
// error and the UI showed a successful reply. The same thing also produced
// notifications with an empty `recipient_id`, and it let any client fabricate a
// notification to any account.
//
// Notifications are now emitted by the server, inside the same transaction as
// the post that caused them (backend/internal/platform/pocketbase/
// post_notifications.go). A client may only READ, mark read, and delete.
//
// Do not re-add a write here. If an action needs to notify somebody, add the
// event to the server-side dispatcher instead.