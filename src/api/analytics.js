import { sendApi } from './pocketbase';

/**
 * Analytics, Telemetry, IP Dossier and IP Ban API wrappers.
 * All requests flow through sendApi() so Authorization, pbUrl,
 * Idempotency-Key, and ApiError handling work consistently.
 */

export const sendVisitTelemetry = async ({ session_id, guest_id = '', entry_path = '/', referrer = '' }) => {
  // Public endpoint — no auth cookie required, omit credentials mode to avoid
  // CORS preflight failures (browser requires Access-Control-Allow-Credentials:
  // true when credentials:'include', but PocketBase only sets it for sessions it
  // recognises; unauthenticated telemetry hits should use the default omit mode).
  return await sendApi('/api/aerun/telemetry/visit', {
    method: 'POST',
    body: {
      session_id,
      guest_id,
      entry_path,
      referrer,
    },
  });
};

const buildPeriodParams = (periodOrOpts = '30d', extra = {}) => {
  const opts = typeof periodOrOpts === 'string' ? { period: periodOrOpts } : (periodOrOpts || {});
  const params = new URLSearchParams();
  if (opts.period) params.set('period', opts.period);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.date) params.set('date', opts.date);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') {
      params.set(k, String(v));
    }
  }
  return params.toString();
};

export const fetchAnalyticsDashboard = async (periodOrOpts = '30d') => {
  const qs = buildPeriodParams(periodOrOpts);
  return await sendApi(`/api/aerun/admin/analytics/dashboard?${qs}`);
};

export const fetchAnalyticsTopics = async (periodOrOpts = '30d', limit = 15) => {
  const qs = buildPeriodParams(periodOrOpts, { limit });
  return await sendApi(`/api/aerun/admin/analytics/topics?${qs}`);
};

export const fetchAnalyticsVisits = async ({
  page = 1,
  limit = 25,
  filter = 'all',
  query = '',
  period = '',
  from = '',
  to = '',
} = {}) => {
  const qs = buildPeriodParams({ period, from, to }, { page, limit, filter, query });
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
