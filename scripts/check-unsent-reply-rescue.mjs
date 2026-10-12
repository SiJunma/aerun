// The unsent-reply rescue — as an EXECUTION test, not a source grep.
//
// WHY EXECUTION AND NOT A REGEX. Every defect in this family is a LIFECYCLE
// defect: a key written but never cleared (a nuisance that nags forever), a
// rescue attributed to a member who never had one (a privacy leak across
// accounts on a shared browser), or a list that silently drops a rescue. All of
// those look identical to a correct implementation when you grep for
// `saveUnsentReply`. So this file installs a fake localStorage, imports the
// real module, and drives it the way the app does.
//
// Run: node scripts/check-unsent-reply-rescue.mjs
import assert from 'node:assert/strict';

// A localStorage stand-in. Deliberately shaped like the real Storage object,
// including `key(i)`/`length` iteration, because the notice's list walk depends
// on that exact shape — and because `Object.keys` on a real Storage returns
// nothing, a fake that leaned on a plain object would pass a broken real store.
const makeStore = () => {
  const data = new Map();
  return {
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
    _raw: data,
  };
};

const store = makeStore();
globalThis.localStorage = store;

const {
  saveUnsentReply,
  listUnsentReplies,
  readUnsentReply,
  hasUnsentReply,
  clearUnsentReply,
  subscribeToUnsentReplies,
  isTopicUnavailableError,
  REASON_TOPIC_CLOSED,
  REASON_TOPIC_UNAVAILABLE,
  UNSENT_REPLY_PREFIX,
} = await import('../src/api/unsent-replies.js');

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ok  ${message}`); };

// ── The rescue is written, addressable, and per-account ────────────────────
{
  store.clear();
  const saved = saveUnsentReply({
    topicId: 'topic123', uid: 'acc1', content: 'my doomed reply',
    reason: REASON_TOPIC_CLOSED,
  });

  assert.ok(saved, 'saveUnsentReply must return the entry it stored');
  assert.equal(saved.reason, REASON_TOPIC_CLOSED);
  ok('a refused reply is rescued with its reason');

  // The whole point of the key: it is NOT the composer's draft key. If this
  // name ever collapsed onto DRAFT_KEY's shape, the page-only read-back would
  // silently become the rescue again.
  assert.ok(
    [...store._raw.keys()].every((k) => k.startsWith(UNSENT_REPLY_PREFIX)),
    'every stored key must carry the unsent-reply prefix'
  );
  ok('stored under the dedicated unsent-reply prefix, not the composer draft key');

  const round = readUnsentReply('topic123', 'acc1');
  assert.equal(round.content, 'my doomed reply');
  ok('read back for the member who wrote it');

  assert.equal(readUnsentReply('topic123', 'acc2'), null,
    'another member must not read it back — the uid is in the key');
  ok('another member cannot read this rescue (uid is in the key)');

  assert.equal(hasUnsentReply('topic123', 'acc1'), true);
  assert.equal(hasUnsentReply('topic999', 'acc1'), false);
  ok('hasUnsentReply answers existence per (topic, member)');
}

// ── Empty content is not a rescue ──────────────────────────────────────────
{
  store.clear();
  for (const blank of ['', '   ', '\n\t ', null, undefined]) {
    assert.equal(
      saveUnsentReply({ topicId: 't', uid: 'a', content: blank, reason: REASON_TOPIC_CLOSED }),
      null,
      `content ${JSON.stringify(blank)} must not create a rescue`
    );
  }
  assert.equal(listUnsentReplies('a').length, 0,
    'an empty form must not be rescued — there is nothing to rescue');
  ok('an empty reply form creates no rescue');
}


// ── The lifecycle: cleared by submit or by delete, and by nothing else ─────
{
  store.clear();
  saveUnsentReply({ topicId: 't1', uid: 'a', content: 'text one', reason: REASON_TOPIC_CLOSED });
  saveUnsentReply({ topicId: 't2', uid: 'a', content: 'text two', reason: REASON_TOPIC_UNAVAILABLE });

  const events = [];
  const unsub = subscribeToUnsentReplies((d) => events.push(d));

  saveUnsentReply({ topicId: 't3', uid: 'a', content: 'text three', reason: REASON_TOPIC_CLOSED });
  clearUnsentReply('t1', 'a');

  unsub();
  saveUnsentReply({ topicId: 't4', uid: 'a', content: 'after unsub', reason: REASON_TOPIC_CLOSED });

  assert.deepEqual(events.map((e) => e.action), ['saved', 'cleared'],
    'the in-tab bus must report writes and clears, and stop after unsubscribe');
  ok('the in-tab change bus notifies on save and clear, then unsubscribes');

  assert.equal(readUnsentReply('t1', 'a'), null, 'a cleared rescue must be gone');
  ok('clearUnsentReply removes exactly that (topic, member) rescue');

  // Both reasons must survive listing: the notice shows either, so neither may
  // be silently dropped by the lister.
  const listed = listUnsentReplies('a');
  assert.deepEqual(listed.map((r) => r.topicId).sort(), ['t2', 't3', 't4'],
    'the list must include every remaining rescue, whatever its reason');
  assert.equal(listed.find((r) => r.topicId === 't2').reason, REASON_TOPIC_UNAVAILABLE,
    'a topic_unavailable rescue must keep its reason through listing');
  ok('listUnsentReplies returns every remaining rescue with its reason');

  // Newest-first is the ordering contract: the notice opens rescues[0].
  const stamps = listed.map((r) => String(r.saved_at || ''));
  assert.deepEqual(stamps, [...stamps].sort().reverse(),
    'listUnsentReplies must be newest-first — the notice opens index 0');
  ok('the list is newest-first, so the notice opens the most recent rescue');
}

// ── Isolation: one member's rescue is invisible to another ─────────────────
{
  store.clear();
  saveUnsentReply({ topicId: 'sharedTopic', uid: 'memberA', content: 'A text', reason: REASON_TOPIC_CLOSED });

  assert.equal(listUnsentReplies('memberB').length, 0,
    'switching accounts on a shared browser must not offer the previous member text');
  assert.equal(listUnsentReplies('memberA').length, 1);
  ok('a rescue is invisible to every other member');

  assert.equal(listUnsentReplies(null).length, 0, 'a guest has no rescues to list');
  assert.equal(listUnsentReplies(undefined).length, 0);
  ok('guests (no uid) are never served');
}

// ── Corrupted storage must not break the surface ───────────────────────────
{
  store.clear();
  store.setItem(`${UNSENT_REPLY_PREFIX}broken_acc1`, '{not json at all');
  const listed = listUnsentReplies('acc1');
  assert.ok(Array.isArray(listed), 'a malformed entry must not throw while listing');
  assert.equal(listed.length, 0, 'a malformed entry must not surface as a rescue');
  ok('a corrupted key degrades to "no rescue" instead of throwing');
}

// ── The classification that decides WHICH reason gets offered ────────────────
//
// The guard on the incident itself. The postability effect re-runs on every
// 15s stats tick for as long as the topic page is open, so a predicate that
// answered true for a plain message — or for any 5xx — would strand a LIVE
// topic's reply under a modal telling the member it can never be delivered.
{
  // A flattened message carries no status, so it must never classify as gone.
  for (const message of [
    'Request timed out',
    'Internal Server Error',
    'Access denied',
    'Network error',
    'Failed to fetch',
  ]) {
    assert.equal(isTopicUnavailableError(message), false,
      `message ${JSON.stringify(message)} must not mean the topic is gone`);
  }
  // Including one that merely QUOTES a status in prose: `err.message` is not a
  // contract, and guessing from wording is exactly what this predicate forbids.
  assert.equal(isTopicUnavailableError('HTTP 403 from the server'), false,
    'a status mentioned in prose must not classify — only a carried status may');
  ok('a flattened message (even one naming a status) is never "the topic is gone"');

  assert.equal(isTopicUnavailableError(null), false);
  assert.equal(isTopicUnavailableError(undefined), false);
  ok('an absent error answers false');

  // The genuine refusals: status first, then the backend's `kind` where the
  // status did not survive the hop.
  assert.equal(isTopicUnavailableError({ status: 404, code: 'not_found' }), true);
  assert.equal(isTopicUnavailableError({ status: 403, code: 'forbidden' }), true);
  assert.equal(isTopicUnavailableError({ status: 404 }), true);
  assert.equal(isTopicUnavailableError({ status: 403 }), true);
  assert.equal(isTopicUnavailableError({ code: 'not_found' }), true);
  assert.equal(isTopicUnavailableError({ code: 'forbidden' }), true);
  ok('404 and 403 (status or backend kind) mean the topic will not be served');

  // Everything else is a read that failed, not a topic that left.
  assert.equal(isTopicUnavailableError({ status: 500, code: 'internal' }), false);
  assert.equal(isTopicUnavailableError({ status: 409, code: 'conflict' }), false);
  assert.equal(isTopicUnavailableError({ status: 429, code: 'rate_limited' }), false);
  assert.equal(isTopicUnavailableError({ status: 401, code: 'unauthorized' }), false);
  assert.equal(isTopicUnavailableError({ status: 0, code: 'network_error' }), false);
  assert.equal(isTopicUnavailableError({ status: 0, code: 'validation' }), false);
  ok('a timeout, 5xx, 409, 429 or contract error is "the read failed", not "gone"');

  // The spellings the codebase used before the backend contract existed. Both
  // are hyphenated and come from the retired Firebase layer; accepting either
  // would let a dead branch look alive.
  assert.equal(isTopicUnavailableError({ code: 'not-found' }), false,
    'the retired Firebase spelling must not be treated as a live 404');
  assert.equal(isTopicUnavailableError({ code: 'permission-denied' }), false,
    'the retired Firebase spelling must not be treated as a live 403');
  ok('only the backend error contract (underscore spellings) is recognised');
}

console.log(`\n[OK] unsent-reply rescue: ${passed} checks passed`);
