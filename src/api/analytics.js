import { sendApi } from './pocketbase';

/**
 * Analytics, Telemetry, IP Dossier and IP Ban API wrappers.
 * All requests flow through sendApi() so Authorization, pbUrl,
 * Idempotency-Key, and ApiError handling work consistently.
 */

export const sendVisitTelemetry = async ({ session_id, guest_id = '', entry_path = '/', referrer = '' }) => {
  return await sendApi('/api/aerun/telemetry/visit', {
    method: 'POST',
    credentials: 'include',
    body: {
      session_id,
      guest_id,
      entry_path,
      referrer,
    },
  });
};

export const fetchAnalyticsDashboard = async (period = '30d') => {
  return await sendApi(`/api/aerun/admin/analytics/dashboard?period=${encodeURIComponent(period)}`);
};

export const fetchAnalyticsTopics = async (period = '30d', limit = 15) => {
  return await sendApi(
    `/api/aerun/admin/analytics/topics?period=${encodeURIComponent(period)}&limit=${encodeURIComponent(limit)}`
  );
};

export const fetchAnalyticsVisits = async ({ page = 1, limit = 25, filter = 'all', query = '' } = {}) => {
  const qs = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    filter,
    query,
  }).toString();
  return await sendApi(`/api/aerun/admin/analytics/visits?${qs}`);
};

export const fetchAnalyticsSuspicious = async () => {
  return await sendApi('/api/aerun/admin/analytics/suspicious');
};

export const fetchIPDossier = async ({ ip = '', ipHash = '' } = {}) => {
  const params = new URLSearchParams();
  if (ip) params.set('ip', ip);
  if (ipHash) params.set('ip_hash', ipHash);
  return await sendApi(`/api/aerun/admin/analytics/ip-dossier?${params.toString()}`);
};

export const fetchUserIPs = async (userId) => {
  return await sendApi(`/api/aerun/admin/users/${encodeURIComponent(userId)}/ips`);
};

export const fetchIPBans = async ({ page = 1, limit = 25, status = 'active' } = {}) => {
  const qs = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status,
  }).toString();
  return await sendApi(`/api/aerun/admin/ip-bans?${qs}`);
};

export const createIPBan = async ({ ip_or_subnet, reason, expires_at = '' }) => {
  return await sendApi('/api/aerun/admin/ip-bans', {
    method: 'POST',
    body: {
      ip_or_subnet,
      reason,
      expires_at,
    },
  });
};

export const unbanIP = async (banId) => {
  return await sendApi(`/api/aerun/admin/ip-bans/${encodeURIComponent(banId)}/unban`, {
    method: 'POST',
    body: {},
  });
};
