// Regression test for the "deleting a post wiped the whole topic" bug.
//
// Root cause: TopicPage decided "is this the first post?" with
// `posts[0].id === deletingPost.id`. `posts` holds a single server-side page,
// so on page 2+ `posts[0]` is an ordinary reply. Deleting it took the
// deleteTopics() branch and the topic plus every post was destroyed.
//
// Run: node scripts/check-first-post-guard.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/pages/TopicPage.jsx', import.meta.url), 'utf8');

// Extract the helper so the real shipped logic is what gets exercised.
const helperMatch = src.match(/const isTopicFirstPost = \(post, pagePosts, pageNumber, itemsPerPage\) => \{[\s\S]*?\r?\n\};/);
assert.ok(helperMatch, 'isTopicFirstPost helper must exist in TopicPage.jsx');
const arrowExpr = helperMatch[0]
  .replace(/^const isTopicFirstPost = /, '')
  .replace(/[\r\n\s]*;[\r\n\s]*$/, '');
// Build a callable that forwards to the extracted arrow function.
const isTopicFirstPost = new Function(
  'post', 'pagePosts', 'pageNumber', 'itemsPerPage',
  `return (${arrowExpr})(post, pagePosts, pageNumber, itemsPerPage);`
);

// The buggy pattern must not come back anywhere in the page.
assert.ok(
  !/posts\[0\]\.id === \w*[Pp]ost\.id/.test(src),
  'first-post detection must not compare against posts[0].id (page-local index)'
);
assert.ok(
  !/postIds\.includes\(posts\[0\]\.id\)/.test(src),
  'movePosts must not treat posts[0] as the topic first post'
);

const ITEMS_PER_PAGE = 20;
const posts = (n, startIndex = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${startIndex + i + 1}` }));

// ΓöÇΓöÇ Scenario from the report: 21-post topic, page 2 holds a single post ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
{
  const page1 = posts(20);
  const page2 = posts(1, 20);

  // The only post on page 2 was mistaken for the topic's first post.
  assert.equal(isTopicFirstPost(page2[0], page2, 2, ITEMS_PER_PAGE), false,
    'sole post on page 2 must NOT be treated as the topic first post');

  // The genuine first post is still detected, on page 1.
  assert.equal(isTopicFirstPost(page1[0], page1, 1, ITEMS_PER_PAGE), true,
    'page 1 first post must be detected as the topic first post');
}

// ΓöÇΓöÇ The first post of a middle page is also not the first post ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
{
  const page2 = posts(20, 20);
  assert.equal(isTopicFirstPost(page2[0], page2, 2, ITEMS_PER_PAGE), false,
    'first post of page 2 must not delete the topic');
  assert.equal(isTopicFirstPost(page2[5], page2, 2, ITEMS_PER_PAGE), false,
    'mid-page post must not delete the topic');
}

// ΓöÇΓöÇ Edge cases ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
{
  assert.equal(isTopicFirstPost(null, [], 1, ITEMS_PER_PAGE), false, 'null post');
  assert.equal(isTopicFirstPost(undefined, posts(20), 1, ITEMS_PER_PAGE), false, 'undefined post');
  assert.equal(isTopicFirstPost(posts(1)[0], [], 1, ITEMS_PER_PAGE), false, 'empty page');
  // A partially filled last page still resolves the first post correctly.
  assert.equal(isTopicFirstPost(posts(1, 0)[0], posts(1, 0), 1, ITEMS_PER_PAGE), true, 'single-post topic');
  // Post not on the rendered page (stale state) must not be a false positive.
  assert.equal(isTopicFirstPost({ id: 'ghost' }, posts(20), 3, ITEMS_PER_PAGE), false, 'off-page post');
}

console.log('OK  first-post guard: page-2 posts never delete the topic');
console.log('OK  first-post guard: genuine first post still detected');
console.log('OK  first-post guard: edge cases handled');
