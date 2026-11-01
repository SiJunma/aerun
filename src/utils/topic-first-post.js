// topic-first-post.js — client-side helper for detecting the topic's first post.
//
// WHY THIS IS A MODULE AND NOT AN INLINE CONSTANT IN THE PAGE.
// The decision about "is this post the topic's first post?" must NOT be
// computed from the page-local array index (posts[0]), because on page 2+ the
// page-local first post is an ordinary reply, not the topic's first post.
// Treating a page-2 post as the topic's first post would delete the whole
// topic when the user deletes a single reply on a later page.
//
// Root cause of the historical bug:
//   TopicPage decided "is this the first post?" with
//   `posts[0].id === deletingPost.id`. `posts` holds a single server-side page,
//   so on page 2+ `posts[0]` is an ordinary reply. Deleting it took the
//   deleteTopics() branch and the topic plus every post was destroyed.
//
// The correct rule (enforced by scripts/check-first-post-guard.mjs):
//   - only page 1 index 0 can be the topic first post
//   - pageNumber !== 1 ⇒ always false
//   - post must exist and be in pagePosts
//
// `itemsPerPage` is accepted as the 4th argument for API-compatibility with
// dynamic page sizes (settings.postsPerPage ?? 20), though the current rule
// does not need it for the correctness check.
export const isTopicFirstPost = (post, pagePosts, pageNumber, _itemsPerPage) => {
  if (!post || !Array.isArray(pagePosts) || pagePosts.length === 0) return false;
  if (pageNumber !== 1) return false;
  return pagePosts[0]?.id === post.id;
};

export default isTopicFirstPost;