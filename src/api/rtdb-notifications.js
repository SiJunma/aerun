import { sendApi } from './pocketbase';
import { sharedPoll } from './shared-poll';
import { subscribeToRealtimeSignals, canReceiveSignals } from './realtime-signals';

// The unread badge in the tab title, the Notifications page and the quote
// highlighting inside TopicPage all wanted "this member's notifications". They
// each ran their OWN 15-second interval AND their own realtime channel, so one
// open topic page issued three identical `GET /me/notifications?limit=100` calls
// every fifteen seconds — four for an admin, because subscribeToAdminNotifications
// below was the same read under a different name.
//
// ONE resource answers all of them now, and a fourth caller costs zero requests.
// The realtime channel is a refresh TRIGGER rather than a second reader, so five
// events arriving together collapse into one debounced read.
const toNotification = (n) => ({
  id: n.id,
  recipient_uid: n.recipient_id,
  type: n.type,
  read: !!n.read,
  archived: !!n.archived,
  created_at: n.created,
  payload: n.payload || {},
  title: n.title
});

/**
 * Subscribes to this member's notifications.
 *
 * The callback receives `(items)`, and an empty list only when nothing is known
 * yet — deliberately NOT when a read fails, so a page that was rendering rows
 * keeps them instead of flashing empty on one slow response.
 *
 * The name carries the account id, and that is a CORRECTNESS requirement, not
 * tidiness. These resources cache the last value and hand it to the next
 * subscriber. Without the uid in the name, signing out and signing in as
 * somebody else on a shared machine would paint the previous member's inbox, DM
 * list and unread counts for one tick — data belonging to a session that no
 * longer exists. Keying by account also means each account's loop is its own,
 * so a stale one cannot keep running after the switch.
 */
export const notificationsResource = (uid) =>
  sharedPoll(`notifications:${uid}`, {
    fetch: async () => {
      const res = await sendApi('/api/aerun/me/notifications?limit=100');
      return (res?.items || []).map(toNotification);
    },
    intervalMs: 15000,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToUserNotifications error]', err),
    // THE FIRST RESOURCE TO RIDE REALTIME, and the reason it is this one.
    //
    // Notifications are owner-scoped and the blast radius of getting it wrong is
    // the smallest of anything we stream: the signal table carries an id, and the
    // re-read is `/me/notifications`, which is already caller-scoped. Topics and
    // posts come next, and they are a different risk.
    //
    // The interval stays configured. That is deliberate: it is the FALLBACK, and
    // shared-poll removes it the moment a signal actually arrives. A member whose
    // stream is healthy costs no polling; a member whose stream is silent gets
    // exactly the behaviour they had before this feature existed.
    realtime: canReceiveSignals()
      ? (onDelivered, onDead) => subscribeToRealtimeSignals(
        // Every signal re-reads the list; the topic is not filtered here on
        // purpose. Distinguishing "this signal is mine" from "that one is" in
        // the browser would mean trusting the payload, and the payload is an id
        // precisely because it is not to be trusted. One re-read per coalesced
        // burst is cheap, and the server decides what the member may see.
        () => onDelivered(),
        () => onDead(),
      )
      : null,
  });

export const subscribeToUserNotifications = (uid, callback) => {
  if (!uid) {
    callback([]);
    return () => {};
  }
  return notificationsResource(uid).subscribe((items) => callback(items));
};

/**
 * Marks a notification as read.
 *
 * ONE argument, and that is the notification id.
 *
 * The failure it removes: the signature used to be `(uid, notifId, isAdmin)` —
 * the two legacy parameters are ignored (`_uid`, `_isAdmin`) because
 * `/me/notifications/:id/read` is caller-scoped server-side — but two of the
 * three call sites passed the arguments the OTHER way round, following the
 * comment "notification id first, user.uid second":
 *
 *     markNotificationRead(id, profile?.uid)   // NotificationsPage
 *     markNotificationRead(n.id, user?.uid)    // TopicPage quote highlighting
 *
 * so `notifId` received the ACCOUNT id and the request went to
 * `PATCH /me/notifications/<accountId>/read`, which is a 404. Clicking a
 * notification therefore marked nothing, and scrolling a quoted post into view
 * marked nothing, while the UI updated the row optimistically — the member saw
 * a read receipt the server never issued, and the unread count stayed put until
 * some later read repainted it. The badge and the "mark all read" button then
 * disagreed with the row they sit next to.
 *
 * The uid cannot be part of the contract any more, so it is not a parameter:
 * one argument means the only thing a caller can pass IS the id.
 *
 * The failure is RETHROWN, not swallowed. These used to `console.warn` and
 * resolve normally, so the caller's `await` never rejected and the success toast
 * fired even when the server returned 403/500 — telling the member their
 * notification was read when it was not. Polling would eventually reconcile it,
 * but a lie that self-corrects in 15 seconds is still a lie.
 */
export const markNotificationRead = async (notifId) => {
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
    await markNotificationRead(n.id);
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

// This archives rather than marks read.
//
// It used to call markAllNotificationsRead, i.e. POST /me/notifications/
// read-all: nothing was removed and every row came back as READ, while the
// button said "clear all" and the toast said "all cleared". Clearing an inbox
// and silencing it are different acts; this one now does what it is labelled.
//
// There was also an `deleteAllAdminNotifications` beside it issuing the very
// same POST under an admin name. `/me/...` routes are caller-scoped server-side,
// so it archived the identical inbox twice.
export const deleteAllUserNotifications = async (_uid) => {
  await sendApi('/api/aerun/me/notifications/archive-all', { method: 'POST' });
};
