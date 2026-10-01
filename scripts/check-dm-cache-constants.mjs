// Regression test for the DM cache module silently losing its constants.
//
// 2591610 ("runtime Firebase elimination") rewrote reviveTimestamp to drop the
// Firebase Timestamp import and deleted the declaration block above it in the
// same hunk. DM_CACHE_PREFIX, DM_CACHE_BUILD_KEY, MAX_CACHED_MESSAGES,
// CURRENT_BUILD and getCacheKey all vanished while every *use* of them stayed.
//
// Nothing failed, and that is the lesson. The file carried a
// `/* global __APP_BUILD_TIME__ */` comment, which silenced no-undef for that
// ONE identifier and made the file look deliberately configured. The other
// four were never in the comment — but no-undef only started reporting them
// when be6ca82 removed it (eslint.config.js now declares __APP_BUILD_TIME__
// globally), so a month of production went by with a module that throws
// ReferenceError the first time anything touches localStorage. That includes
// clearAllDmCache(), which AuthProvider calls on signOut — so the failure lands
// on the logout path, in the one place a broken cache is least expected and
// most damaging.
//
// A static read is not enough here: these identifiers only matter if the code
// that uses them can actually resolve them at runtime. So this test loads the
// real module into a vm context with a localStorage stub and calls the
// exported entry points. A missing constant throws ReferenceError and fails
// here, the same day it is written.
//
// Run: node scripts/check-dm-cache-constants.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../src/api/dm-cache.js', import.meta.url), 'utf8');

// Strip the ESM syntax so the body can run in a plain vm context. The file has
// no imports of its own (that was the point of 2591610), so the only thing to
// remove is the `export` keyword on its public functions.
const body = src.replace(/^export\s+/gm, '');

// ── The module must LOAD ─────────────────────────────────────────────────────
// Declared-but-unused constants would pass a name check, so run the body.
const store = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
};
sandbox.globalThis = sandbox;

let mod;
try {
  mod = vm.createContext(sandbox);
  vm.runInContext(body, mod, { filename: 'dm-cache.js' });
} catch (err) {
  assert.fail(
    `src/api/dm-cache.js must load without a ReferenceError: ${err.message}\n` +
    'A missing constant is only reported by the code that uses it — read the file and you will not see it.'
  );
}

// ── Every identifier the module depends on must resolve ──────────────────────
// Listed explicitly rather than derived from a regex: these are the five that
// 2591610 deleted, and a derived scan would happily agree with a wrong answer.
// Each one also carries its type, because a declared-but-wrong-typed constant
// (MAX_CACHED_MESSAGES as a string, say) breaks the comparison that trims the
// cache just as surely as a missing one.
const expected = {
  DM_CACHE_PREFIX: 'string',
  DM_CACHE_BUILD_KEY: 'string',
  MAX_CACHED_MESSAGES: 'number',
  CURRENT_BUILD: 'string',
  getCacheKey: 'function',
};
for (const [ident, want] of Object.entries(expected)) {
  assert.equal(
    vm.runInContext(`typeof ${ident}`, mod),
    want,
    `${ident} must be a ${want} in dm-cache.js — it is used below but was deleted by 2591610`
  );
}

// ── The exported API must work against those constants ───────────────────────
// Read out of the vm context by name rather than destructured: the module was
// evaluated in a different realm, so a plain destructuring would only see the
// context's own globals, not what the script body declared in it.
const api = ['getCachedDmMessages', 'setCachedDmMessages', 'clearAllDmCache', 'getLatestCachedTimestamp'];
for (const name of api) {
  assert.equal(
    vm.runInContext(`typeof ${name}`, mod),
    'function',
    `${name} must be exported from dm-cache.js`
  );
}
const { getCachedDmMessages, setCachedDmMessages, clearAllDmCache, getLatestCachedTimestamp } = Object.fromEntries(
  api.map((name) => [name, vm.runInContext(name, mod)])
);

const uid = 'user1';
const conv = 'conv1';
const read = () => getCachedDmMessages(uid, conv);

// Compared by length rather than deepEqual: the array was built inside the vm
// realm, so it has a different Array.prototype and deepStrictEqual would reject
// two arrays that are element-for-element identical.
assert.equal(read().length, 0, 'an empty cache must read back as empty');

const base = Math.floor(Date.now() / 1000);
setCachedDmMessages(uid, conv, [
  { id: 'b', text: 'second', timestamp: { seconds: base + 1, nanoseconds: 0 } },
  { id: 'a', text: 'first', timestamp: { seconds: base, nanoseconds: 0 } },
]);

const cached = read();
assert.equal(cached.length, 2, 'the cache must round-trip both messages');
// Inserted out of order on purpose: byTimestamp has to sort them, and it can
// only do that if reviveTimestamp returned something with a working toMillis.
// Joined into a string because the array crosses the vm realm boundary.
assert.equal(cached.map((m) => m.id).join(','), 'a,b', 'messages must come back in chronological order');

const latest = getLatestCachedTimestamp(uid, conv);
assert.ok(
  latest && typeof latest.toMillis === 'function',
  'the delta-sync timestamp must be revived, or the next fetch re-downloads the whole conversation'
);

// ── signOut must be able to tell DM entries from the rest of localStorage ────
// This is the path the ReferenceError landed on. If the prefix is wrong or
// missing, one member's cached messages survive into another member's session.
store.set('unrelated_setting', 'keep me');
setCachedDmMessages(uid, conv, [{ id: 'c', text: 'third', timestamp: { seconds: base + 2, nanoseconds: 0 } }]);

clearAllDmCache();

assert.deepEqual([...store.keys()], ['unrelated_setting'],
  'clearAllDmCache must wipe every aerun_dm_ key and nothing else');

console.log('OK  dm-cache: the module loads and all five deleted constants resolve');
console.log('OK  dm-cache: read/write/latest round-trip against a localStorage stub');
console.log('OK  dm-cache: signOut wipes the DM cache without touching unrelated keys');