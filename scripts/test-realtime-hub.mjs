import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

// The realtime hub: ONE SDK subscription for the whole app.
//
// Before the hub, every subscribeToRealtimeSignals call opened its own SDK
// subscription — one POST /api/realtime registration and one 5-second
// connection watcher each, per call site, on every page. The hub multiplexes
// the callers over one subscription and closes it when the last caller leaves.
//
// These are behavioural tests against a stubbed `pb`, because the failure
// modes are ordering ones (two members joining in the same tick, a caller
// leaving while the subscription is still negotiating, a token rotating under
// live membership) that a regex gate cannot see.
//
// Run: node --test --experimental-test-module-mocks --test-force-exit scripts/test-realtime-hub.mjs

let subscribeCalls = 0;
let unsubscribeCalls = 0;
let topicArgs = [];
let eventCallbacks = [];
// NOT reset between cases: the hub registers its auth watcher once, at module
// scope, and that registration outlives every reset().
let authChangeCallbacks = [];
let pendingResolve = null;
let deferred = false;
// Mutable stub state the tests drive: the token the hub reads, and whether the
// next subscribe() handshake must fail.
let stubToken = 'token-1';
let stubSubscribeRejects = false;

const makePbStub = () => ({
  authStore: {
    get token() { return stubToken; },
    onChange: (cb) => {
      authChangeCallbacks.push(cb);
      return () => {
        authChangeCallbacks = authChangeCallbacks.filter((x) => x !== cb);
      };
    }
  },
  realtime: { isConnected: true },
  collection: () => ({
    subscribe: (topic, cb) => {
      subscribeCalls += 1;
      topicArgs.push(topic);
      eventCallbacks.push(cb);
      if (stubSubscribeRejects) {
        return Promise.reject(new Error('subscription refused by test'));
      }
      if (deferred) {
        return new Promise((resolve) => { pendingResolve = resolve; });
      }
      return Promise.resolve(() => { unsubscribeCalls += 1; });
    }
  })
});

mock.module('../src/api/pocketbase.js', { namedExports: { pb: makePbStub(), sendApi: async () => ({}) } });

const { subscribeToRealtimeSignals, canReceiveSignals } = await import('../src/api/realtime-signals.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// Guarantee the suite can never hang on a leaked hub watcher: node --test
// waits for the event loop to drain, and one surviving CONNECTION_POLL_MS
// interval would stall it for minutes. --test-force-exit in the npm script is
// the belt; this is the braces.
const shutdown = () => process.exit(0);
const reset = () => {
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  topicArgs = [];
  eventCallbacks = [];
  pendingResolve = null;
  deferred = false;
  stubToken = 'token-1';
  stubSubscribeRejects = false;
  // authChangeCallbacks is deliberately NOT cleared: the hub registers its
  // watcher once at module scope, so wiping the array would orphan the only
  // handler the tests can drive.
};

// === CASES ===
describe('realtime hub', () => {
  it('opens exactly ONE SDK subscription for two members joining in the same tick', async () => {
    reset();
    const events = [];
    const states1 = [];
    const states2 = [];
    const unsub1 = subscribeToRealtimeSignals((t) => events.push(`1:${t}`), null, (c) => states1.push(c));
    const unsub2 = subscribeToRealtimeSignals((t) => events.push(`2:${t}`), null, (c) => states2.push(c));
    try {
      await flush();

      assert.equal(subscribeCalls, 1, 'two members must share one SDK subscription');
      assert.deepEqual(topicArgs, ['*']);
      // BOTH members joined before the handshake settled, so the settled
      // transition reaches both — the hub broadcasts to everyone present when
      // its subscription resolves. Missing a member would strand its UI on
      // the polling fallback while the stream is perfectly healthy.
      assert.deepEqual(states1, [true], 'the first member learns the connection came up');
      assert.deepEqual(states2, [true], 'the second member learns it too — it joined before the settle');

      eventCallbacks[0]({}, { topic: 'topic.post', entity_id: 'e1' });
      assert.deepEqual(events, ['1:topic.post', '2:topic.post'], 'a signal reaches every member');
    } finally {
      // Cleanup runs even when an assertion above fails: a member left in the
      // hub poisons every later test (the watcher keeps the process alive and
      // the leftover membership prevents the last-departure close).
      unsub1();
      unsub2();
    }
    await flush();
    assert.equal(unsubscribeCalls, 1, 'the last departure closes the SDK subscription');
    assert.equal(subscribeCalls, 1, 'no re-subscribe on the way out');
  });

  it('a late joiner into an established hub learns the state immediately', async () => {
    reset();
    const states1 = [];
    const states2 = [];
    const unsub1 = subscribeToRealtimeSignals(null, null, (c) => states1.push(c));
    try {
      await flush();
      assert.deepEqual(states1, [true]);

      const unsub2 = subscribeToRealtimeSignals(null, null, (c) => states2.push(c));
      try {
        assert.deepEqual(states2, [true], 'the hub already knows it is connected — say so at join time');
      } finally {
        unsub2();
      }
    } finally {
      unsub1();
    }
    await flush();
    assert.equal(unsubscribeCalls, 1);
  });

  it('deduplicates a subscription that is still negotiating', async () => {
    reset();
    deferred = true;
    const unsub1 = subscribeToRealtimeSignals(null, null, null);
    const unsub2 = subscribeToRealtimeSignals(null, null, null);
    try {
      await flush();
      assert.equal(subscribeCalls, 1, 'a pending handshake must not start a second subscription');

      // The callers leave while the handshake is still pending; when the
      // subscription finally settles, the hub must close it instead of adopting
      // it for nobody.
      unsub1();
      unsub2();
      await flush();
      assert.equal(unsubscribeCalls, 0, 'nothing to close yet — the handle does not exist');
      pendingResolve(() => { unsubscribeCalls += 1; });
      await flush();
      assert.equal(unsubscribeCalls, 1, 'a subscription that settles after the last departure is closed');
      assert.equal(subscribeCalls, 1);
    } finally {
      unsub1();
      unsub2();
    }
  });

  it('rebuilds the stream when the auth token rotates under live membership', async () => {
    reset();
    const unsub1 = subscribeToRealtimeSignals(null, null, null);
    try {
      await flush();
      assert.equal(subscribeCalls, 1);

      // Same token twice (a profile save writes the record back) — no rebuild.
      authChangeCallbacks.forEach((cb) => cb());
      await flush();
      assert.equal(subscribeCalls, 1, 'an onChange without a token change must not rebuild');

      // A real token change under live membership — rebuild.
      assert.equal(authChangeCallbacks.length, 1, 'exactly one auth watcher is registered');
      stubToken = 'token-2';
      authChangeCallbacks[0]();
      await flush();
      assert.equal(subscribeCalls, 2, 'the stale stream is replaced');
      assert.equal(unsubscribeCalls, 1, 'the old subscription is closed, not leaked');
    } finally {
      unsub1();
    }
    await flush();
    assert.equal(unsubscribeCalls, 2, 'the rebuilt stream closes with its last member');
  });

  it('a failed handshake reports dead once, closes the hub, and a fresh join retries', async () => {
    reset();
    stubSubscribeRejects = true;
    const dead1 = [];
    const states1 = [];
    const unsub1 = subscribeToRealtimeSignals(null, () => dead1.push('dead'), (c) => states1.push(c));
    try {
      await flush();
      await flush();

      assert.deepEqual(dead1, ['dead'], 'a subscription that cannot be established is dead');
      assert.deepEqual(states1, [], 'a failed handshake must not report connected');
    } finally {
      unsub1();
    }
    // The failure closed the hub, so there are no members and no pending
    // subscription. A fresh member must OPEN A NEW subscription — a join into
    // a dead hub retries the transport instead of inheriting the corpse.
    const unsub2 = subscribeToRealtimeSignals(null, () => dead1.push('dead2'), null);
    try {
      await flush();
      await flush();
      assert.equal(subscribeCalls, 2, 'a join after a failed handshake must retry the subscription');
      assert.deepEqual(dead1, ['dead', 'dead2'], 'the retry that fails again is dead for its own member');
    } finally {
      unsub2();
    }
    await flush();
    assert.equal(unsubscribeCalls, 0, 'nothing ever opened, so nothing leaks on the way out');
    assert.equal(subscribeCalls, 2);
  });
});

assert.equal(typeof canReceiveSignals(), 'boolean', 'canReceiveSignals stays exported');
console.log('OK  realtime hub: one subscription, shared state, token rebuild, pending dedup, dead retry');
shutdown();