import { sendApi } from './pocketbase';

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
  targetNickname: item.target_nickname,
  details: item.details || {},
  created_at: item.created,
  // NaN-safe: an unparseable date sorts as 0 instead of poisoning the comparator,
  // which would silently reorder the whole trail.
  created_at_ms: Number.isNaN(new Date(item.created).getTime()) ? 0 : new Date(item.created).getTime(),
  created: item.created
});

/**
 * Fetches offset-paginated audit logs with search and filter.
 *
 * @param {Object} [options]
 * @param {number} [options.page=1] - 1-based page index
 * @param {number} [options.limit=50] - Number of records per page
 * @param {string} [options.action_type] - Optional action type filter
 * @param {string} [options.performer_id] - Optional performer user id filter
 * @param {string} [options.q] - Optional server search term
 * @returns {Promise<{ items: Array, total: number, page: number, totalPages: number, requestId?: string }>}
 */
export const getAuditLogs = async ({ page = 1, limit = 50, action_type, performer_id, q } = {}) => {
  const params = new URLSearchParams();
  if (page) params.set('page', String(page));
  if (limit) params.set('limit', String(limit));
  if (action_type && action_type !== 'all') params.set('action_type', action_type);
  if (performer_id) params.set('performer_id', performer_id);
  if (q && q.trim()) params.set('q', q.trim());

  const res = await sendApi(`/api/aerun/admin/audit-logs?${params.toString()}`);
  return {
    items: (res?.items || []).map(normalizeAuditLog),
    total: res?.total ?? 0,
    page: res?.page ?? page,
    totalPages: res?.total_pages ?? res?.totalPages ?? 1,
    requestId: res?.request_id
  };
};
