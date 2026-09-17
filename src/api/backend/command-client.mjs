export class BackendError extends Error {
  constructor(message, { code = 'network', status = 0, retryable = false, requestId = null } = {}) {
    super(message);
    this.name = 'BackendError';
    Object.assign(this, { code, status, retryable, requestId });
  }
}

// Opt-in transport for the future command API; not imported by the live UI.
// No Firebase/PocketBase SDK or deployment-specific host escapes this boundary.
export function createCommandClient({ baseURL, getToken = () => null, fetchImpl = globalThis.fetch }) {
  const base = new URL(baseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('baseURL must be an HTTP(S) origin');
  }
  return {
    // Caller retains the key across a retry. Never automatically retry mutations.
    async command(name, payload, { idempotencyKey, signal } = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid command name');
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
        throw new Error('A stable 16–128 character idempotency key is required');
      }
      const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
      const token = await getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      let response;
      try {
        response = await fetchImpl(new URL(`/api/aerun/commands/${name}`, base), {
          method: 'POST', headers, body: JSON.stringify(payload), signal,
          credentials: 'omit', redirect: 'error',
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new BackendError('Не удалось получить ответ сервера. Повторите запрос с тем же ключом.', { retryable: true });
      }
      const requestId = response.headers.get('X-Request-ID');
      let body;
      try { body = await response.json(); } catch {
        throw new BackendError('Сервер вернул некорректный ответ.', { code: 'protocol', status: response.status, requestId });
      }
      if (!response.ok) {
        throw new BackendError(body?.error?.message || 'Запрос отклонён сервером.', {
          code: body?.error?.code || 'unknown', status: response.status,
          retryable: body?.error?.retryable === true, requestId,
        });
      }
      if (!body || !Object.hasOwn(body, 'data')) {
        throw new BackendError('В ответе сервера отсутствуют данные.', { code: 'protocol', status: response.status, requestId });
      }
      return body.data;
    },
  };
}
