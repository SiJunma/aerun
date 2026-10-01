// Regression test for "a guest clicking a topic from the main page never loads
// it" (https://aerun-forum.web.app/topic/<id>?page=2&goLast=1 stayed on the
// skeleton forever).
//
// Root cause: TopicPage derives `isJumping` — and with it the
// `topic-jump-loading` class that hides the whole page behind
// TopicPageSkeleton — from `alreadyJumpedRef`, a ref. The flag is flipped from
// effects, promise callbacks and setTimeout callbacks, and writing a ref never
// re-renders. Whenever the jump completed without some *other* state change the
// overlay therefore stayed on screen although the posts were loaded and even
// scrolled into view. Guests hit it every time: no read map, no mark-as-read
// write, no presence tick — nothing else re-renders the page.
//
// Run: node scripts/check-golast-overlay.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/pages/TopicPage.jsx', import.meta.url), 'utf8');

// ── The flag must only change through a setter that re-renders ────────────────
const setter = src.match(
  /const setAlreadyJumped = React\.useCallback\(\(value\) => \{[\s\S]*?\r?\n  \}, \[\]\);/
);
assert.ok(setter, 'setAlreadyJumped helper must exist in TopicPage.jsx');
assert.ok(
  /forceJumpRender\(\)/.test(setter[0]),
  'setAlreadyJumped must trigger a render, otherwise the jump overlay can outlive the jump'
);

const writes = [...src.matchAll(/alreadyJumpedRef\.current = [^;]+;/g)];
assert.ok(writes.length > 0, 'alreadyJumpedRef must still be written somewhere');
for (const w of writes) {
  assert.ok(
    setter[0].includes(w[0]),
    `alreadyJumpedRef must only be written inside setAlreadyJumped, got: ${w[0]}`
  );
}

// The overlay is rendered from this flag, so it must stay the single source.
assert.ok(
  /const isJumping = needsJump && !alreadyJumpedRef\.current;/.test(src),
  'isJumping must still be derived from alreadyJumpedRef'
);

// ── No second getSecuredPosts while the goLast page is being resolved ─────────
// The guest fallback used to write ?page=N before the in-flight server-side
// resolution landed, which bypassed skipNextLoadForPageRef and re-fetched the
// very same page.
assert.ok(
  /if \(!hasExplicitPage && !isFetchingPostsRef\.current && topic\?\.posts_count\)/.test(src),
  'the guest posts_count fallback must wait until the in-flight page resolution finishes'
);

console.log('OK  goLast overlay: the jump flag can only change through a re-rendering setter');
console.log('OK  goLast overlay: the guest page fallback no longer duplicates the posts request');