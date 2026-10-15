// Regression test: subscribeToAllCategories handed its callback a PROMISE
// instead of the resolved array.
//
// Adding a reconnect refetch rewrote the loader as:
//
//     const load = () => { if (!isSubscribed) return; callback(fetchSecuredCategories()); }
//
// dropping the `.then`. fetchSecuredCategories is async, so `categories` in
// AdminPage became a Promise and `categories.filter(...)` threw
// "categories.filter is not a function" on every render. The admin board went
// blank on F5 and React unmounted the whole tree — with no build error, no lint
// error and no failing test. This is the same class as check-dm-cache-constants:
// the module still compiles, it only throws when something actually calls it.
//
// So this executes the real module in a vm context with stubbed dependencies and
// asserts the shape the consumer receives. Static reading would not have caught
// it either — the original line was syntactically perfect.
//
// Run: node scripts/check-category-subscriber-shape.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { PERMISSIONS } from '../src/constants/permissions.js';

const src = fs.readFileSync(new URL('../src/api/categories.js', import.meta.url), 'utf8');

// Drop the ESM imports and `export` keywords so the body can run as a script in a
// plain vm context. Both dependencies are supplied as sandbox stubs below.
const body = src
  .replace(/^import[^;]+;$/gm, '')
  .replace(/^export\s+/gm, '');

const CATEGORY_FIXTURES = [
  { id: 'cat1', name: 'General', slug: 'general', description: 'General discussion', group_id: 'grp1', sort_order: 0, allowed_roles: [] },
];

const store = new Map();
const sandbox = {
  console,
  // sendApi is the only transport these readers need. It answers the shape the
  // real endpoint returns.
  sendApi: async (url) => {
    if (url.endsWith('/categories')) return { items: CATEGORY_FIXTURES };
    if (url.endsWith('/category-groups')) return { items: [] };
    throw new Error(`unexpected url in test: ${url}`);
  },
  subscribeToRefetch: () => () => {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
  Date,
  JSON,
  Number,
  Array,
  Set,
  String,
  Promise,
  Object,
  PERMISSIONS,
};

const ctx = vm.createContext(sandbox);
// `const` bindings stay lexical in a vm script — they do NOT become properties of
// the context object — so the entry points are re-exported explicitly.
vm.runInContext(
  `${body}
   globalThis.__subscribeAllCategories = subscribeToAllCategories;
   globalThis.__subscribeCategoryGroups = subscribeToCategoryGroups;`,
  ctx
);

// ── subscribeToAllCategories must yield a plain array ──────────────────────────
const received = [];
ctx.__subscribeAllCategories((cats) => received.push(cats));

await new Promise((r) => setImmediate(r));

assert.equal(received.length, 1, 'the subscriber must call back exactly once on mount');
assert.ok(
  Array.isArray(received[0]),
  `the callback must receive an array, got ${Object.prototype.toString.call(received[0])} — a promise here breaks every .filter() consumer`
);
assert.equal(received[0].length, 1, 'the fetched categories must survive to the consumer');
assert.equal(received[0][0].slug, 'general', 'the mapped record must reach the consumer');

// ── and the group reader must not regress the same way ────────────────────────
const groups = [];
ctx.__subscribeCategoryGroups((g) => groups.push(g));
await new Promise((r) => setImmediate(r));

assert.equal(groups.length, 1, 'the group subscriber must call back exactly once on mount');
assert.ok(
  Array.isArray(groups[0]),
  `the group callback must receive an array, got ${Object.prototype.toString.call(groups[0])}`
);

console.log('category subscriber shape OK — callbacks receive arrays, not promises');