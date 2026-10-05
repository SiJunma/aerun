import { sendApi } from './pocketbase';
import { sharedPoll } from './shared-poll';

/**
 * Logs an administrative or moderative action.
 */
export const logAdminAction = async (actionType, performerId, _details = {}) => {
  // In the PocketBase backend architecture, mutations log to audit trail atomically
  // on the server inside transactions.
};

/**
 * Normalizes one audit row.
 *
 * The wire format is an ISO string under `created`. The Firestore Timestamp
 * object this page used to expect — the one carrying toDate()/toMillis() — no
 * longer exists anywhere in the backend, so `created_at` is a plain string and
 * calling `.toMillis()` on it threw "is not a function", which took the whole
 * admin board down behind an error boundary.
 *
 * This mirrors normalizePost/normalizeTopic in forum.js: keep the original
 * string for rendering (Timestamp already accepts strings and Dates) and add a
 * numeric `created_at_ms` for sorting, so no render site has to know which shape
 * a date arrived in.
 */
const normalizeAuditLog = (item) => ({
  id: item.id,
  actionType: item.action_type,
  action_type: item.action_type,
  performerId: item.performer_id,
  performer_id: item.performer_id,
  performerNickname: item.performer_nickname,
  details: item.details || {},
  created_at: item.created,
  // NaN-safe: an unparseable date sorts as 0 instead of poisoning the comparator,
  // which would silently reorder the whole trail.
  created_at_ms: Number.isNaN(new Date(item.created).getTime()) ? 0 : new Date(item.created).getTime(),
  created: item.created
});

/**
 * Subscribes to the latest audit logs.
 */
export const subscribeToAuditLogs = (limitCount = 50, callback) => {
  // Staff-only and single-consumer today, but keyed like everything else so
  // opening the audit tab from two places cannot double the read.
  const poll = sharedPoll(`audit-logs:${limitCount}`, {
    fetch: async () => {
      const res = await sendApi(`/api/aerun/admin/audit-logs?limit=${limitCount}`);
      return (res?.items || []).map(normalizeAuditLog);
    },
    intervalMs: 15000,
    initialValue: [],
    onError: (err) => console.warn('[subscribeToAuditLogs err]', err),
  });

  return poll.subscribe((logs) => callback(logs));
};

/**
 * Fetch more logs for pagination.
 */
export const getMoreAuditLogs = async (lastDoc, limitCount = 50) => {
  try {
    const cursor = lastDoc?.nextCursor || '';
    const res = await sendApi(`/api/aerun/admin/audit-logs?limit=${limitCount}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    return {
      logs: (res?.items || []).map(normalizeAuditLog),
      lastDoc: res?.next_cursor ? { nextCursor: res.next_cursor } : null
    };
  } catch (err) {
    console.error('[getMoreAuditLogs err]', err);
    return { logs: [], lastDoc: null };
  }
};
