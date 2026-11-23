import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = fileURLToPath(new URL('../src/pages/TopicPage.jsx', import.meta.url));
const source = readFileSync(file, 'utf8');
// The TopicPage monolith was split into hooks: the jump/scroll controller (which
// owns navigateToCreatedPost) lives in useTopicJumpScroll, the posts load effect
// lives in useTopicPosts, and the post card renders from TopicPostCard. The gate
// follows the logic, not the old file layout.
const jumpHook = fileURLToPath(new URL('../src/hooks/topic/useTopicJumpScroll.js', import.meta.url));
const jumpSource = readFileSync(jumpHook, 'utf8');
const postsHook = fileURLToPath(new URL('../src/hooks/topic/useTopicPosts.js', import.meta.url));
const postsHookSource = readFileSync(postsHook, 'utf8');
const postCard = fileURLToPath(new URL('../src/components/topic/TopicPostCard.jsx', import.meta.url));
const postCardSource = readFileSync(postCard, 'utf8');

// Exercise the actual helper without importing the browser component. The hook
// wraps it in useCallback, so the extraction matches the wrapped form.
const match = jumpSource.match(/const navigateToCreatedPost = useCallback\(\(tempId, postId\) => \{([\s\S]*?)\n  \}, \[/);
assert.ok(match, 'Post navigation helper must exist in src/hooks/topic/useTopicJumpScroll.js');
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
// Priority 0 lives in the hook now: a post this session just created outranks
// every ?post= / #post- / goLast target in the scroll controller's precedence.
const jumpPriority = jumpSource.indexOf('if (pendingCreatedPostIdRef.current) {');
const postParamBranch = jumpSource.indexOf("} else if (postParam) {");
assert.ok(jumpPriority !== -1 && postParamBranch !== -1 && jumpPriority < postParamBranch,
  'A created post must outrank ?post= in the scroll target precedence');
assert.match(jumpSource, /targetId = `post-\$\{pendingCreatedPostIdRef\.current\}`/);
assert.doesNotMatch(source, /post:\s*tempId/, 'Temporary IDs must not be used as URL post targets');
assert.equal((source.match(/navigateToCreatedPost\(\w+, newPostId\)/g) || []).length, 2,
  'Reply and draft publication must both complete navigation using the server ID');
assert.equal((source.match(/state: \{ pendingPostId: tempId \}/g) || []).length, 2);
console.log('PASS: focused post navigation regression checks');

// ── The ?post= deep link resolves its page SERVER-SIDE now ──────────────────
// The old flow walked pages from the browser (locatePost + a client-side
// membership skip over the loaded list). The refactor moved resolution into the
// unified posts endpoint: loadPosts sends targetPostId, the server answers with
// resolvedPage / targetFound / movedToTopicId in ONE request.

// The load path must carry the target post id to the server.
assert.match(postsHookSource, /fetchSecuredPosts\(topicId, pageToFetch, itemsPerPage, lastVisitMs, targetPostId\)/,
  'loadPosts must hand targetPostId to the unified posts endpoint for server-side page resolution');

// A pending target starts at page 1 and lets the server tell the real page.
assert.match(postsHookSource, /if \(queryPostId\) \{\s*\n\s*targetPostId = queryPostId;/,
  'a ?post= target must be resolved through the endpoint, not by client-side walking');

// The page-resolution write must arm the skip guard, and the skip must disarm
// immediately when the resolved page is already the rendered one — otherwise a
// skip left armed silently eats the next unrelated (live) fetch.
assert.match(postsHookSource, /skipNextLoadForPageRef\.current = resolvedPage;/,
  'the resolved page must arm the duplicate-fetch skip');
assert.match(postsHookSource, /if \(resolvedPage === currentPage\) \{\s*\n\s*skipNextLoadForPageRef\.current = null;\s*\n\s*\}/,
  'a skip for the page already rendered must disarm immediately');
assert.match(postsHookSource, /if \(skipNextLoadForPageRef\.current === pageToFetch\) \{\s*\n\s*skipNextLoadForPageRef\.current = null;\s*\n\s*return \[\];/,
  'an armed skip must consume itself and skip the duplicate fetch');

// The rendered page is recorded, so the rest of the page can reason about it.
assert.match(postsHookSource, /loadedPageRef\.current = activePage/, 'loadPosts must record the page it rendered');

// locatePost is retired from the component path: nothing may walk pages from
// the browser when the endpoint resolves the page in one query.
assert.equal((source.match(/locatePost\(/g) || []).length, 0,
  'TopicPage must not call locatePost — page resolution is server-side');
assert.equal((postsHookSource.match(/locatePost\(/g) || []).length, 0,
  'useTopicPosts must not call locatePost — page resolution is server-side');

// ── The scroll controller targets ?post= / #post- / goLast locally ──────────
// A valid ?post=ID that resolves to the already-rendered page must set a local
// scroll target WITHOUT any locator: the page was resolved before the fetch,
// and the skip guard above prevented the clear+refetch.
assert.match(jumpSource, /targetId = `post-\$\{postParam\}`/,
  'a ?post= target resolves to a local scroll target');
assert.doesNotMatch(jumpSource, /locatePost/,
  'the scroll controller must never call the locator');
console.log('PASS: ?post=ID resolves its page server-side; scroll targets stay local');
console.log('PASS: in-topic post links scroll locally without a redundant locate');

// locatePost's return contract (src/api/forum.js): `{ topicId, page, postId }`
// on a hit and `null` on a miss — the retired Firebase callable's `.found` flag
// is gone. TopicPage must branch on the object itself; reading `.found` off a
// successful resolve is `undefined`, so a VALID permalink fell straight into the
// "the original post was deleted" branch and dropped the reader at the top of
// the topic. This pins both halves of the contract so the bug cannot return.
const forumFile = fileURLToPath(new URL('../src/api/forum.js', import.meta.url));
const forumSource = readFileSync(forumFile, 'utf8');
const locatePostFn = forumSource.match(/export const locatePost = async[\s\S]*?\n\};/);
assert.ok(locatePostFn, 'locatePost must be defined in src/api/forum.js');
assert.match(locatePostFn[0], /return \{ topicId, page, postId \};/,
  'locatePost resolves to the hit object {topicId, page, postId}');
assert.doesNotMatch(locatePostFn[0], /found:/,
  'locatePost no longer emits a .found flag — that was the retired callable shape');
assert.doesNotMatch(source, /result\.found/,
  'TopicPage must branch on the locatePost result object, not the removed .found flag');
console.log('PASS: locatePost result contract (object|null) matches how TopicPage branches on it');


// Sending an optimistic post must not show any in-flight visualization on the
// post card: the header strip renders a normal timestamp in every state. The
// card lives in TopicPostCard since the TopicPage split.
assert.doesNotMatch(postCardSource, /Отправка\.\.\.|Sending\.\.\./, 'No "Sending..." label on the post card');
const headerStripStart = postCardSource.indexOf('post-header-strip') !== -1
  ? postCardSource.indexOf('post-header-strip')
  : postCardSource.indexOf('post-header');
const headerStripEnd = postCardSource.indexOf('post-number-indicator') !== -1
  ? postCardSource.indexOf('post-number-indicator', headerStripStart)
  : postCardSource.indexOf('post-number', headerStripStart);
assert.ok(headerStripStart !== -1 && headerStripEnd !== -1, 'Post card header strip bounds must be found');
const headerStrip = postCardSource.slice(headerStripStart, headerStripEnd);
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
