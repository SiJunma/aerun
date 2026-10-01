import { sendApi } from './pocketbase';

/**
 * Logs an administrative or moderative action.
 */
export const logAdminAction = async (actionType, performerId, _details = {}) => {
  // In the PocketBase backend architecture, mutations log to audit trail atomically
  // on the server inside transactions.
};

/**
 * Subscribes to the latest audit logs.
 */
export const subscribeToAuditLogs = (limitCount = 50, callback) => {
  let isSubscribed = true;

  const load = async () => {
    try {
      const res = await sendApi(`/api/aerun/admin/audit-logs?limit=${limitCount}`);
      if (!isSubscribed) return;
      const logs = (res?.items || []).map(item => ({
        id: item.id,
        actionType: item.action_type,
        action_type: item.action_type,
        performerId: item.performer_id,
        performer_id: item.performer_id,
        performerNickname: item.performer_nickname,
        details: item.details || {},
        created_at: item.created,
        created: item.created
      }));
      callback(logs);
    } catch (err) {
      console.warn('[subscribeToAuditLogs err]', err);
      if (isSubscribed) callback([]);
    }
  };

  load();
  const interval = setInterval(load, 15000);

  return () => {
    isSubscribed = false;
    clearInterval(interval);
  };
};

/**
 * Fetch more logs for pagination.
 */
export const getMoreAuditLogs = async (lastDoc, limitCount = 50) => {
  try {
    const cursor = lastDoc?.nextCursor || '';
    const res = await sendApi(`/api/aerun/admin/audit-logs?limit=${limitCount}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const logs = (res?.items || []).map(item => ({
      id: item.id,
      actionType: item.action_type,
      action_type: item.action_type,
      performerId: item.performer_id,
      performer_id: item.performer_id,
      performerNickname: item.performer_nickname,
      details: item.details || {},
      created_at: item.created,
      created: item.created
    }));
    return {
      logs,
      lastDoc: res?.next_cursor ? { nextCursor: res.next_cursor } : null
    };
  } catch (err) {
    console.error('[getMoreAuditLogs err]', err);
    return { logs: [], lastDoc: null };
  }
};
