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

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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

test('a realtime hook is REFUSED loudly, because it could never deliver', async () => {
  // The collections this app reads are locked (ListRule = nil), which PocketBase
  // answers with "only superusers" — so a subscription connects and then never
  // fires. The network tab shows PB_CONNECT and nothing else, which is
  // indistinguishable from a broken stream, and that is exactly how the dead
  // realtime sat unnoticed. Failing loudly is the point: the next person to add a
  // hook learns why it cannot work instead of shipping another silent one.
  const calls = [];
  const poll = createSharedPoll({
    name: 'no-realtime',
    intervalMs: 0,
    fetch: async () => { calls.push(1); return calls.length; },
    realtime: () => () => {},
  });

  assert.throws(
    () => poll.subscribe(() => {}),
    /realtime is refused by the collection rules/,
    'a realtime hook must not start a loop that can never receive an event'
  );
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
      await tick();
      assert.equal(calls, 2, 'returning to the tab re-reads once');
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