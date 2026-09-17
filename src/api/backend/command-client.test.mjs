import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandClient, BackendError } from './command-client.mjs';

const baseURL = 'http://127.0.0.1:8090';
const idempotencyKey = 'mock-key-00000001';

test('command carries auth and stable key, validates before fetching', async () => {
  const calls = [];
  const client = createCommandClient({ baseURL, getToken: () => 'mock-token', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { id: 'post' } }));
  } });
  assert.deepEqual(await client.command('create-post', {}, { idempotencyKey }), { id: 'post' });
  assert.equal(calls[0].url, `${baseURL}/api/aerun/commands/create-post`);
  assert.equal(calls[0].options.headers['Idempotency-Key'], idempotencyKey);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer mock-token');
  await assert.rejects(client.command('../other', {}, { idempotencyKey }), /Invalid command/);
  await assert.rejects(client.command('create-post', {}), /idempotency key/);
  assert.equal(calls.length, 1);
});

test('network failure never retries a mutation automatically', async () => {
  let attempts = 0;
  const client = createCommandClient({ baseURL, fetchImpl: async () => { attempts++; throw new Error('offline'); } });
  await assert.rejects(client.command('create-post', {}, { idempotencyKey }), error => error instanceof BackendError && error.retryable);
  assert.equal(attempts, 1);
});

test('structured denial and malformed response preserve diagnostic context', async () => {
  const client = createCommandClient({ baseURL, fetchImpl: async () => new Response(JSON.stringify({ error: {
    code: 'forbidden', message: 'Denied', retryable: false,
  } }), { status: 403, headers: { 'X-Request-ID': 'diagnostic' } }) });
  await assert.rejects(client.command('create-post', {}, { idempotencyKey }), error => error.code === 'forbidden' && error.requestId === 'diagnostic' && !error.retryable);
  const malformed = createCommandClient({ baseURL, fetchImpl: async () => new Response('not-json') });
  await assert.rejects(malformed.command('create-post', {}, { idempotencyKey }), error => error.code === 'protocol');
});
