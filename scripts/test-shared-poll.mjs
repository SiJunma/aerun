// Executes the shared-poll primitive, because the bugs it removes are all
// COUNTING bugs and a regex cannot count.
//
// The defect: every `subscribeToX` owned its own interval and its own realtime
// channel, and nothing was shared. `subscribeToUserNotifications` had three
// callers (the tab badge, the notifications page, TopicPage's quote
// highlighting) and `subscribeToDmUnread` had two (AuthProvider and
// TitleProvider), so one open topic page issued three identical
// `GET /me/notifications?limit=100` and two identical `GET /me/unread-counts` —
// which is exactly what the network log showed, two to four calls in a row.
//
// Every assertion below is a count of REQUESTS or a count of TIMERS, because
// that is the only thing that distinguishes a shared resource from several
// private ones: the values they deliver are identical either way, which is why
// this survived review and shipped.
//
// Run: node --test scripts/test-shared-poll.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// The module reads `document` for tab visibility; each test installs its own.
const { createSharedPoll, sharedPoll, __resetSharedPolls } =
  await import('../src/api/shared-poll.js');
const { REALTIME_GRACE_MS, REFRESH_COALESCE_MS, REPLAY_FRESH_MS } =
  await import('../src/api/shared-poll.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

// wait lets a REAL timer expire. The transport windows are 250ms and 10s, and the
// point of these tests is the shipped durations, so they are waited out rather
// than faked — a stubbed clock would pass regardless of what the constants say.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A DOM stand-in whose visibility the test controls, since polling suppression
// and the visibility-triggered catch-up read are both part of the contract.
const fakeDocument = (visibility = 'visible') => {
  const listeners = new Set();
  return {
    visibilityState: visibility,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    emit: () => listeners.forEach((fn) => fn()),
    get listenerCount() { return listeners.size; },
  };
};

const withDocument = async (doc, fn) => {
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    await fn();
  } finally {
    globalThis.document = previous;
  }
};

test('two subscribers to one resource issue ONE request, not two', async () => {
  let calls = 0;
  const poll = createSharedPoll({
    name: 'dedupe',
    intervalMs: 0,
    fetch: async () => { calls += 1; return calls; },
  });

  const seen = [];
  const stop = poll.subscribe((v) => seen.push(v));
  try {
    const stopSecond = poll.subscribe((v) => seen.push(v));
    await tick();
    assert.equal(calls, 1);
    assert.deepEqual(seen, [1, 1], 'both subscribers see the same read');
    stopSecond();
  } finally {
    stop();
    poll.stopIfIdle();
  }
});

test('a late subscriber gets the cached value without another request', async () => {
  let calls = 0;
  const poll = createSharedPoll({
    name: 'cache',
    intervalMs: 0,
    fetch: async () => { calls += 1; return `v${calls}`; },
  });

  const stopFirst = poll.subscribe(() => {});
  const late = [];
  const stopLate = poll.subscribe((v) => late.push(v));
  try {
    await tick();
    assert.equal(calls, 1);
    assert.deepEqual(late, ['v1'], 'it must still render something immediately');

    // Now start over with the value already loaded, which is the shape of the
    // real bug: a component mounts later and must not trigger its own read.
    calls = 0;
    const third = [];
    const stopThird = poll.subscribe((v) => third.push(v));
    await tick();
    assert.equal(calls, 0, 'mounting another component must not re-read');
    assert.deepEqual(third, ['v1']);
    stopThird();
  } finally {
    stopFirst();
    stopLate();
  }
});

// __APPEND_TESTS__
test('a slow read is never stacked: one request per trigger burst', async () => {
  let calls = 0;
  let release;
  const poll = createSharedPoll({
    name: 'single-flight',
    intervalMs: 0,
    // A read slower than the triggers that arrive during it.
    fetch: () => { calls += 1; return new Promise((r) => { release = () => r(calls); }); },
  });

  const stop = poll.subscribe(() => {});
  await tick();
  assert.equal(calls, 1);

  try {
    poll.refresh();
    poll.refresh();
    poll.refresh();
    // Triggers are DEBOUNCED, so they cannot have opened a second GET yet — and
    // more to the point, none of them can while the first read is still in the
    // air. This is the assertion that matters: the old code issued a fresh
    // request per realtime event no matter what was already running.
    assert.equal(calls, 1, 'a trigger during a read must not start a second GET');

    release();
    await settle();
    // The coalesced trigger runs once the read lands: the burst is one extra
    // read, not three. Coalescing is what makes this 2 rather than 4.
    assert.equal(calls, 2, 'the burst collapses to one follow-up read');
  } finally {
    stop();
  }
});

test('a realtime hook is ACCEPTED, and its events drive the reads', async () => {
  // This test used to assert the opposite — that a hook must THROW — because
  // every collection was locked and a subscription could connect but never
  // deliver. The rules were not opened to fix that (see
  // markdowns/DONE_REALTIME_TRANSPORT_DESIGN.md); the browser now subscribes to a
  // signals table that carries no forum content and re-reads through
  // /api/aerun. So the refusal is gone and this asserts the new contract
  // instead, including the part that matters: an event causes a READ, never a
  // blind re-render of whatever the event happened to contain.
  const calls = [];
  let emit = () => {};
  const poll = createSharedPoll({
    name: 'realtime-ok',
    intervalMs: 0,
    fetch: async () => { calls.push(calls.length + 1); return calls.length; },
    realtime: (onEvent) => {
      emit = onEvent;
      return () => { emit = () => {}; };
    },
  });

  const stop = poll.subscribe(() => {});
  try {
    assert.equal(calls.length, 1, 'the first read is unconditional');

    emit();
    await wait(REFRESH_COALESCE_MS + 60);
    assert.equal(calls.length, 2, 'an event must cause a read');
    assert.equal(poll.getTransport(), 'realtime',
      'a delivered event is the only thing that marks the stream healthy — connecting is not');
  } finally {
    stop();
  }
});

test('a stream that never CONNECTS falls back to polling on the grace window', async () => {
  // A hook that never reports a connection must cost the SAME as a dead one:
  // the interval takes over after the grace window. This is the real
  // never-established case — a subscription whose rule refuses it — and it is
  // what the grace window is actually for.
  let calls = 0;
  const poll = createSharedPoll({
    name: 'silent-stream',
    intervalMs: 10,
    fetch: async () => { calls += 1; return calls; },
    realtime: () => () => {},        // never connects, never delivers
  });

  const stop = poll.subscribe(() => {});
  try {
    assert.equal(poll.getTransport(), 'connecting', 'before any connection, nothing is proven');
    await wait(REALTIME_GRACE_MS + 80);
    assert.equal(poll.getTransport(), 'polling',
      'a stream that never connected must be reported as polling, not as realtime');
    const afterGrace = calls;
    await wait(50);
    assert.ok(calls > afterGrace, 'the interval must actually be running after the fallback');
  } finally {
    stop();
  }
});

test('a CONNECTED but idle stream is NOT declared dead — this is the "realtime keeps dying" bug', async () => {
  // REPORTED: realtime "keeps dying" on an open DM thread.
  //
  // The health check used to require a DELIVERED signal, so a conversation
  // nobody was typing in — which emits nothing for minutes — was declared
  // broken after the grace window and pushed onto the poll interval for good,
  // with the stream open the whole time. This pins the fix: a connection that
  // reports itself healthy is trusted, however long it stays silent.
  let calls = 0;
  const poll = createSharedPoll({
    name: 'idle-stream',
    intervalMs: 10,
    fetch: async () => { calls += 1; return calls; },
    // Connected, and then deliberately silent for well past the grace window.
    realtime: (onEvent, onDead, onStateChange) => {
      setTimeout(() => onStateChange(true), 10);
      return () => {};
    },
  });

  const stop = poll.subscribe(() => {});
  try {
    await wait(REALTIME_GRACE_MS + 200);
    assert.equal(poll.getTransport(), 'realtime',
      'a connected stream must not degrade to polling just because nobody spoke');
    const afterConnect = calls;
    await wait(120);
    assert.equal(calls, afterConnect,
      'and it must cost NO requests while idle — that was the whole cost of the bug');
  } finally {
    stop();
  }
});

test('a stream that drops after being healthy falls back, and recovers when it returns', async () => {
  // The other half of the same contract, and the one that was impossible before:
  // the old `delivered` flag meant a stream that HAD delivered could never be
  // reported dead again, so a member whose connection died mid-conversation
  // stayed on "realtime" and silently stopped updating.
  let calls = 0;
  let setState = () => {};
  const poll = createSharedPoll({
    name: 'drop-and-recover',
    intervalMs: 10,
    fetch: async () => { calls += 1; return calls; },
    realtime: (onEvent, onDead, onStateChange) => {
      setState = onStateChange;
      return () => {};
    },
  });

  const stop = poll.subscribe(() => {});
  try {
    setState(true);
    await tick();
    assert.equal(poll.getTransport(), 'realtime', 'a connection is healthy on arrival');

    setState(false);
    await tick();
    assert.equal(poll.getTransport(), 'polling',
      'a drop must bring the interval back, even after the stream was healthy');

    setState(true);
    await tick();
    assert.equal(poll.getTransport(), 'realtime',
      'and a reconnect must close it again — the SDK reconnects on its own');
  } finally {
    stop();
  }
});

test('the transport is observable, and unsubscribing closes the stream', async () => {
  const seen = [];
  let closed = false;
  const poll = createSharedPoll({
    name: 'transport-visible',
    intervalMs: 0,
    fetch: async () => 'v',
    realtime: (onEvent) => { onEvent(); return () => { closed = true; }; },
  });

  const stopWatch = poll.onTransportChange((t) => seen.push(t));
  // A listener mounted later is handed the current value rather than waiting for
  // the next transition — a banner must not need a change to know where it is.
  assert.ok(seen.includes('idle'), 'onTransportChange must report the current transport on attach');

  const stop = poll.subscribe(() => {});
  await wait(REFRESH_COALESCE_MS + 40);
  assert.ok(seen.includes('realtime'), `transport changes must be observable, saw ${seen.join(',')}`);

  stop();
  assert.equal(closed, true, 'the last subscriber leaving must close the stream');
  assert.equal(poll.getTransport(), 'idle', 'a stopped resource is idle, not silently polling');

  stopWatch();
  const countAfterUnsubscribe = seen.length;
  await wait(20);
  assert.equal(seen.length, countAfterUnsubscribe,
    'a removed listener must stop receiving, or a long session accumulates them');
});

test('connect replay is skipped within the freshness window when opted in', async () => {
  let calls = 0;
  const poll = createSharedPoll({
    name: 'replay-skip-fresh',
    intervalMs: 0,
    skipConnectReplayMs: REPLAY_FRESH_MS,
    fetch: async () => { calls += 1; return calls; },
    realtime: (_o, _d, onStateChange) => { setTimeout(() => onStateChange(true), 10); return () => {}; },
  });
  const stop = poll.subscribe(() => {});
  try {
    await tick();
    assert.equal(calls, 1, 'primary read');
    await wait(REFRESH_COALESCE_MS + 400);
    assert.equal(poll.getTransport(), 'realtime');
    assert.equal(calls, 1, 'no replay within the freshness window');
  } finally { stop(); }
});

test('connect replay still runs when stale', async () => {
  let calls = 0;
  let setState = null;
  const poll = createSharedPoll({
    name: 'replay-stale',
    intervalMs: 0,
    skipConnectReplayMs: 1,
    fetch: async () => { calls += 1; return calls; },
    realtime: (_o, _d, onStateChange) => { setState = onStateChange; return () => {}; },
  });
  const stop = poll.subscribe(() => {});
  try {
    await tick();
    assert.equal(calls, 1);
    await wait(20);
    setState(true);
    await wait(REFRESH_COALESCE_MS + 60);
    assert.equal(calls, 2, 'stale read must trigger the catch-up replay');
  } finally { stop(); }
});

test('connect replay still runs when primary never succeeded', async () => {
  let calls = 0;
  let setState = null;
  const poll = createSharedPoll({
    name: 'replay-never-ok',
    intervalMs: 0,
    skipConnectReplayMs: REPLAY_FRESH_MS,
    fetch: async () => { calls += 1; throw new Error('down'); },
    realtime: (_o, _d, onStateChange) => { setState = onStateChange; return () => {}; },
  });
  const stop = poll.subscribe(() => {});
  try {
    await tick();
    assert.equal(calls, 1);
    setState(true);
    await wait(REFRESH_COALESCE_MS + 60);
    assert.equal(calls, 2, 'a failed primary read must not suppress the replay');
  } finally { stop(); }
});

test('connect replay is unconditional without opt-in', async () => {
  let calls = 0;
  const poll = createSharedPoll({
    name: 'replay-default',
    intervalMs: 0,
    fetch: async () => { calls += 1; return calls; },
    realtime: (_o, _d, onStateChange) => { setTimeout(() => onStateChange(true), 10); return () => {}; },
  });
  const stop = poll.subscribe(() => {});
  try {
    await tick();
    assert.equal(calls, 1);
    await wait(REFRESH_COALESCE_MS + 400);
    assert.equal(calls, 2, 'without the opt-in the replay must still happen');
  } finally { stop(); }
});

test('a hidden tab is not polled, and is read once on return', async () => {
  let calls = 0;
  const doc = fakeDocument('hidden');
  const poll = createSharedPoll({
    name: 'visibility',
    intervalMs: 5,
    fetch: async () => { calls += 1; return calls; },
  });

  await withDocument(doc, async () => {
    // The stop handle is called below: a timer left running would keep the test
    // runner's event loop alive forever, which is the same defect as leaving a
    // poll running in a real tab.
    const stop = poll.subscribe(() => {});
    try {
      await tick();
      assert.equal(calls, 1, 'the first read is unconditional');

      await new Promise((r) => setTimeout(r, 40));
      assert.equal(calls, 1, 'a hidden tab must stop polling entirely');

      // Coming back is the moment a stale view is most likely. The browser
      // updates visibilityState BEFORE it fires the event, so the fake must too —
      // otherwise the handler reads 'hidden' and correctly does nothing.
      doc.visibilityState = 'visible';
      doc.emit();
      // The catch-up read is SYNCHRONOUS: the visibility handler calls read()
      // and the fetch stub increments before its first await, so the count is
      // final the moment emit() returns. Asserting here is what makes the test
      // deterministic — asserting after `await tick()` raced the 5ms poll
      // interval, and under load the interval won, counting a third read.
      assert.equal(calls, 2, 'returning to the tab re-reads once');
      await tick();
    } finally {
      stop();
    }
  });
});

test('a failed read keeps the last good value and reports the error', async () => {
  let shouldFail = false;
  const poll = createSharedPoll({
    name: 'error',
    intervalMs: 0,
    fetch: async () => {
      if (shouldFail) throw new Error('network');
      return 'good';
    },
  });

  const seen = [];
  const stop = poll.subscribe((v, err) => seen.push([v, err ? err.message : null]));
  try {
    await tick();
    assert.deepEqual(seen[0], ['good', null]);

    shouldFail = true;
    poll.refresh();
    await settle();
    await tick();

    const last = seen[seen.length - 1];
    assert.equal(last[0], 'good', 'one failed read must not blank a working view');
    assert.equal(last[1], 'network', 'and the failure must still reach the caller');
  } finally {
    stop();
  }
});

test('the loop stops when the last subscriber leaves', async () => {
  let calls = 0;
  const doc = fakeDocument('visible');
  const poll = createSharedPoll({
    name: 'teardown',
    intervalMs: 5,
    fetch: async () => { calls += 1; return calls; },
  });

  await withDocument(doc, async () => {
    const stopA = poll.subscribe(() => {});
    const stopB = poll.subscribe(() => {});
    try {
      await tick();
      assert.equal(calls, 1);
      assert.equal(doc.listenerCount, 1, 'one visibility listener, not one per subscriber');

      stopA();
      await new Promise((r) => setTimeout(r, 25));
      // The interval is 5ms, so the only thing being asserted is that reads
      // still happen at all while anyone is watching — not how many.
      assert.ok(calls > 1, 'the loop still runs while anyone is watching');

      stopB();
      const settled = calls;
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls, settled, 'the last subscriber leaving must stop the timer');
      assert.equal(doc.listenerCount, 0, 'and release the visibility listener');
    } finally {
      stopA();
      stopB();
    }
  });
});

test('nothing is delivered after every subscriber has gone', async () => {
  let release;
  const poll = createSharedPoll({
    name: 'late-delivery',
    intervalMs: 0,
    fetch: () => new Promise((r) => { release = () => r('value'); }),
  });

  const seen = [];
  const stop = poll.subscribe((v) => seen.push(v));
  await tick();
  stop();
  release(); // the read lands after unmount
  await tick();

  assert.deepEqual(seen, [], 'an unmounted component must not be handed state');
});

test('sharedPoll returns ONE resource per name, however often it is asked', async () => {
  __resetSharedPolls();
  let calls = 0;
  const options = {
    name: 'registry',
    intervalMs: 0,
    fetch: async () => { calls += 1; return calls; },
  };

  const a = sharedPoll('notifications:u1', options);
  const b = sharedPoll('notifications:u1', options);
  assert.equal(a, b, 'two callers naming the same resource must get the same object');

  // The realistic case: two components mount and both call the same helper.
  const seen = [];
  const stopA = a.subscribe((v) => seen.push(v));
  const stopB = b.subscribe((v) => seen.push(v));
  try {
    await tick();
    assert.equal(calls, 1);
    assert.equal(seen.length, 2, 'both components are notified');
  } finally {
    stopA();
    stopB();
    a.stopIfIdle();
  }
});

test('different names are different resources', () => {
  // The account id is part of the name on purpose: a cached inbox must never be
  // handed to a different member after a sign-out.
  __resetSharedPolls();
  const first = sharedPoll('notifications:u1', { intervalMs: 0, fetch: async () => 1 });
  const second = sharedPoll('notifications:u2', { intervalMs: 0, fetch: async () => 2 });
  assert.notEqual(first, second, 'two accounts must not share a cached value');
});

test('the poll still starts when no realtime hook is passed', async () => {
  // The guard above must refuse ONLY a hook. A resource without one is the normal
  // case today and has to keep working, or the guard would take the whole app
  // down instead of one dead optimisation.
  let calls = 0;
  const poll = createSharedPoll({
    name: 'no-hook',
    intervalMs: 0,
    fetch: async () => { calls += 1; return calls; },
  });
  const stop = poll.subscribe(() => {});
  try {
    await tick();
    assert.equal(calls, 1);
  } finally {
    stop();
  }
});