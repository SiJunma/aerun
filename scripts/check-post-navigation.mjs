import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = fileURLToPath(new URL('../src/pages/TopicPage.jsx', import.meta.url));
const source = readFileSync(file, 'utf8');

// Exercise the actual helper without importing the browser/Firebase component.
const match = source.match(/const navigateToCreatedPost = \(tempId, postId\) => \{([\s\S]*?)\n  \};/);
assert.ok(match, 'Post navigation helper must exist');
const helperBody = match[1];
const run = new Function(
  'locationRef', 'isMountedRef', 'pendingCreatedPostIdRef', 'setSearchParams', 'tempId', 'postId',
  helperBody
);
const calls = [];
const setSearchParams = (params, options) => calls.push({ query: params.toString(), options });

// Single hardcoded check: with an empty hash and no ?post in the URL, the helper
// must remember the real post ID internally and leave the address bar untouched.
const pendingRef = { current: null };
run({ current: { search: '?page=2', hash: '', state: { pendingPostId: 'temp_1' } } },
  { current: true }, pendingRef, setSearchParams, 'temp_1', 'real_1');
try {
  assert.equal(pendingRef.current, 'real_1', 'Helper must record the new post ID');
  assert.deepEqual(calls, [{
    query: '?page=2',
    options: { replace: true, preventScrollReset: true, state: null }
  }]);
  assert.doesNotMatch(calls[0].query, /post=/, 'Post ID must not appear in the address bar');
  console.log('PASS: helper records the new post ID, address bar stays clean');
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  process.exit(1);
}

// Skipping cases: user navigated away, unmount, missing server ID, stale state.
const staleRef = { current: 'real_1' };
for (const [state, mounted, postId] of [
  [null, true, 'real_1'],
  [{ pendingPostId: 'another_post' }, true, 'real_1'],
  [{ pendingPostId: 'temp_1' }, false, 'real_1'],
  [{ pendingPostId: 'temp_1' }, true, undefined]
]) {
  const callsBefore = calls.length;
  run({ current: { search: '?page=3', state } }, { current: mounted }, staleRef, setSearchParams, 'temp_1', postId);
  assert.equal(calls.length, callsBefore, 'Do not navigate after leaving, unmounting, or without a confirmed ID');
}
assert.equal(staleRef.current, 'real_1', 'Stale completion must not overwrite the pending target');

// The highlight flow reads the remembered ID and never routes through the URL.
assert.match(helperBody, /pendingCreatedPostIdRef\.current = postId/, 'Remember the created post in component state');
assert.doesNotMatch(helperBody, /params\.set\(/, 'No URL parameter mutations for created posts');
assert.match(source, /Priority 0: scroll to a post created by this user without touching the URL/);
assert.match(source, /targetId = `post-\$\{pendingPostId\}`/);
assert.doesNotMatch(source, /post:\s*tempId/, 'Temporary IDs must not be used as URL post targets');
assert.equal((source.match(/navigateToCreatedPost\(tempId, newPostId\)/g) || []).length, 2,
  'Reply and draft publication must both complete navigation using the server ID');
assert.equal((source.match(/state: \{ pendingPostId: tempId \}/g) || []).length, 2);
console.log('PASS: focused post navigation regression checks');

// In-topic paste: when the target post is already on the loaded page, the load
// effect must skip the clear+refetch (scroll is handled by the navigation effect).
const loadEffectStart = source.indexOf('// Load posts whenever topic id or page changes');
const loadEffectEnd = source.indexOf('const lastMarkedOffsetRef', loadEffectStart);
const loadEffect = source.slice(loadEffectStart, loadEffectEnd);
assert.match(loadEffect, /jumpTargetId = searchParams\.get\('post'\) \|\| pendingCreatedPostIdRef\.current/);
const skipCondition = loadEffect.match(/if \((jumpTargetId && [^\n]+?)\) \{/);
assert.ok(skipCondition, 'Skip condition must exist in the load effect');
const shouldSkip = new Function(
  'jumpTargetId', 'loadedPageRef', 'currentPage', 'postsRef',
  `return !!(${skipCondition[1]});`
);
assert.equal(shouldSkip('p9', { current: 2 }, 2, { current: [{ id: 'p9' }] }), true, 'Post on the loaded page → skip refetch');
assert.equal(shouldSkip('p9', { current: 2 }, 3, { current: [{ id: 'p9' }] }), false, 'Another page → normal load');
assert.equal(shouldSkip('pX', { current: 2 }, 2, { current: [{ id: 'p9' }] }), false, 'Post not on the page → locate path');
assert.equal(shouldSkip(null, { current: 2 }, 2, { current: [{ id: 'p9' }] }), false, 'No jump target → normal load');
assert.ok(
  loadEffect.indexOf('postsRef.current.some(p => p.id === jumpTargetId)') <
  loadEffect.indexOf('(hasPostJump || hasHashJump) && !hasExplicitPage'),
  'Skip must run before posts are cleared for page resolution'
);
assert.match(source, /loadedPageRef\.current = activePage/, 'loadPosts must record the page it rendered');
assert.equal((source.match(/locatePost\(/g) || []).length, 2, 'locatePost stays reserved for posts absent from the loaded list');

// Minimal reproduction of the in-topic scenario: a valid ?post=ID arrives while
// posts are already rendered on the loaded page. The navigation effect must set
// a local scroll target for it WITHOUT calling locatePost, and the load effect
// skip (asserted above) must prevent the clear+refetch.
const navEffectStart = source.indexOf('Unified Navigation & Scroll Controller');
const navEffectEnd = source.indexOf('}, [posts, topic, searchParams', navEffectStart);
assert.ok(navEffectStart !== -1 && navEffectEnd !== -1, 'Navigation effect bounds must be found');
const navEffect = source.slice(navEffectStart, navEffectEnd);
const priority1 = navEffect.slice(navEffect.indexOf("const queryPostId = searchParams.get('post');"));
const foundBranch = priority1.slice(
  priority1.indexOf('if (postIndex !== -1) {'),
  priority1.indexOf('} else {')
);
assert.match(foundBranch, /targetId = `post-\$\{queryPostId\}`/, 'Post found on the page → local scroll target is set');
assert.match(foundBranch, /scrollBlock = 'center'/, 'Found post is scrolled into view (centered)');
assert.doesNotMatch(foundBranch, /locatePost/, 'Post found on the page → no locator call');
assert.equal((priority1.match(/locatePost\(queryPostId/g) || []).length, 1,
  'Locator runs exactly once and only in the not-found branch');
assert.equal(shouldSkip('p9', { current: 2 }, 2, { current: [{ id: 'p9' }] }), true,
  'Same scenario through the load effect: no clear+refetch when the post is on the page');
console.log('PASS: ?post=ID on a loaded page → scroll target set, no clear+refetch, no locator');
console.log('PASS: in-topic post links scroll locally without a redundant locate');

// Sending an optimistic post must not show any in-flight visualization on the
// post card: the header strip renders a normal timestamp in every state.
assert.doesNotMatch(source, /Отправка\.\.\.|Sending\.\.\./, 'No "Sending..." label on the post card');
const headerStripStart = source.indexOf('post-header-strip');
const headerStripEnd = source.indexOf('post-number-indicator', headerStripStart);
const headerStrip = source.slice(headerStripStart, headerStripEnd);
assert.match(headerStrip, /Timestamp date=\{post\.created_at\}/, 'Post timestamp renders normally');
assert.doesNotMatch(headerStrip, /spinner-border/, 'No spinner in the post header strip');
assert.doesNotMatch(headerStrip, /role="status"/, 'No loading indicator in the post header strip');
console.log('PASS: optimistic post renders like a regular post, no sending indicator');

// Check JSX syntax and distinguish pre-existing lint debt from new diagnostics.
const eslint = new ESLint({ cwd: root });
const original = execFileSync('git', ['-C', root, 'show', 'HEAD:src/pages/TopicPage.jsx'], { encoding: 'utf8' });
const [before] = await eslint.lintText(original, { filePath: file });
const [after] = await eslint.lintFiles([file]);
const key = message => `${message.ruleId}:${message.message}`;
const counts = new Map();
for (const message of before.messages) counts.set(key(message), (counts.get(key(message)) || 0) + 1);
const added = after.messages.filter(message => {
  const id = key(message);
  if (!counts.get(id)) return true;
  counts.set(id, counts.get(id) - 1);
  return false;
});
console.log(JSON.stringify({
  before: { errors: before.errorCount, warnings: before.warningCount },
  after: { errors: after.errorCount, warnings: after.warningCount },
  newDiagnostics: added
}, null, 2));
assert.equal(after.fatalErrorCount, 0, 'JSX must parse successfully');
assert.equal(added.length, 0, 'Changes must not introduce lint diagnostics');
console.log('PASS: JSX syntax and no new ESLint diagnostics');
