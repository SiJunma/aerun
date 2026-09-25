import PocketBase from 'pocketbase';

const pbUrl = import.meta.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090';
export const pb = new PocketBase(pbUrl);

// Generates a cryptographically secure or pseudo-random idempotency key
export function generateIdempotencyKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let result = 'idem_';
  for (let i = 0; i < 28; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', retryable = false, requestId = null, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
    this.data = data;
  }
}

/**
 * sendApi sends an HTTP request to the Aerun domain API (/api/aerun/...)
 * using PocketBase's auth token and error contract.
 */
export async function sendApi(path, options = {}) {
  const url = `${pbUrl}${path.startsWith('/') ? path : '/' + path}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  // Attach PocketBase auth token if available
  if (pb.authStore.isValid && pb.authStore.token && !headers['Authorization']) {
    headers['Authorization'] = pb.authStore.token;
  }

  // Ensure JSON content-type if body is provided and not FormData
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  // For POST/PUT/PATCH/DELETE mutations, automatically add an Idempotency-Key if not set
  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['Idempotency-Key']) {
    headers['Idempotency-Key'] = generateIdempotencyKey();
  }

  try {
    const res = await fetch(url, {
      ...options,
      headers
    });

    const requestId = res.headers.get('X-Request-ID');
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const errData = data?.data || {};
      const message = data?.message || data?.error || res.statusText || 'Request failed';
      throw new ApiError(message, {
        status: res.status,
        code: errData.kind || 'api_error',
        retryable: !!errData.retryable,
        requestId: errData.request_id || requestId,
        data: errData
      });
    }

    return data;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    throw new ApiError(err.message || 'Network error', {
      status: 0,
      code: 'network_error',
      retryable: true
    });
  }
}
