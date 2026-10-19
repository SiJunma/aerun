import PocketBase from 'pocketbase';

export const pbUrl = import.meta.env.VITE_POCKETBASE_URL || 'http://127.0.0.1:8090';
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

// A session that the server has stopped honouring.
//
// A SOFT-DELETED account's tokens stop verifying the moment the delete
// rotates the account's tokenKey, so every request the browser still holds a
// token for comes back 401. Without this the member sits on a forum that
// silently refuses everything: the shell renders, the lists come back empty,
// and nothing says the account is gone.
//
// The flag is the same one the ban path writes, so the same modal explains
// it. The auth store is cleared here rather than in the provider: this is the
// FIRST sign the session is dead, and waiting for the next profile refresh
// would leave the member clicking on a forum that answers nothing.
const DEAD_SESSION_STATUSES = [401];

function endDeadSession() {
  try {
    sessionStorage.setItem('deleted_logout', 'true');
  } catch {
    // A browser with storage disabled (private mode, blocked cookies) cannot
    // hold the flag. The session is still cleared, and the provider's own
    // status check explains the state on the next profile read.
  }
  pb.authStore.clear();
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
      // A dead session ends HERE, not on the next profile refresh: the member
      // is clicking on a forum that refuses everything and says nothing.
      //
      // The 401 is the ordinary case: the server rotated the account's
      // tokenKey, so the token no longer verifies. The 403 carries an
      // explicit `account_deleted` marker, because a DELETED account is a
      // different reason from an ordinary forbidden and the member deserves
      // to be told which one it is.
      const accountDeleted = errData.account_deleted === true;
      if (accountDeleted || DEAD_SESSION_STATUSES.includes(res.status)) {
        endDeadSession();
      }
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
