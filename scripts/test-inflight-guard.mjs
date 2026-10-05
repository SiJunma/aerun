// Executes the double-submit guard rather than reading it. A module with
// runtime behaviour is only proven by running it: dm-cache-constants lost five
// constants for a month because nothing dereferenced them
// (see .agents/AGENTS.md).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInFlight, newIdempotencyKey } from '../src/utils/inflight.js';

test('begin() wins exactly once per busy period', () => {
  const flight = createInFlight();
  assert.equal(flight.begin(), true, 'the first caller must win');
  assert.equal(flight.begin(), false, 'a second caller in the same tick must lose');
  assert.equal(flight.isBusy(), true);
});

test('the latch releases and can be taken again', () => {
  const flight = createInFlight();
  flight.begin();
  flight.end();
  assert.equal(flight.isBusy(), false);
  assert.equal(flight.begin(), true, 'a released latch must accept work again');
});

test('two separate latches do not block each other', () => {
  // Per-component latches: a reply form and a topic form are independent.
  const a = createInFlight();
  const b = createInFlight();
  assert.equal(a.begin(), true);
  assert.equal(b.begin(), true);
});

test('keys are unique per logical submit and long enough for the backend', () => {
  const keys = new Set();
  for (let i = 0; i < 500; i += 1) {
    const key = newIdempotencyKey('post');
    keys.add(key);
    assert.ok(key.startsWith('post-'), `expected a scope prefix, got ${key}`);
    // The Go command layer refuses anything outside 16..128 characters.
    assert.ok(key.length >= 16 && key.length <= 128, `key length ${key.length}`);
  }
  assert.equal(keys.size, 500, 'every logical submit needs its own key');
});