/**
 * optimisticPostQueue: In-memory store for pending optimistic posts across page transitions.
 *
 * Prevents the cross-page post loss race condition where:
 * 1. User on page 1 submits a post creating page 2.
 * 2. Navigation to ?page=2 happens immediately.
 * 3. Page 2 fetches GET /topics/{id}/posts?page=2 before backend transaction commits.
 * 4. Page 2 mounts the optimistic post from this queue, so the page is NEVER empty!
 * 5. When createPost completes, the temp post smoothly reconciles with the server post.
 */

const queue = new Map(); // topicId -> Array<Post>

export const queueOptimisticPost = (topicId, post) => {
  if (!topicId || !post) return;
  const existing = queue.get(topicId) || [];
  queue.set(topicId, [...existing.filter(p => p.id !== post.id), post]);
};

export const getPendingOptimisticPosts = (topicId) => {
  if (!topicId) return [];
  return queue.get(topicId) || [];
};

export const resolveOptimisticPost = (topicId, tempId, serverPostId) => {
  if (!topicId || !tempId) return;
  const existing = queue.get(topicId) || [];
  if (serverPostId) {
    queue.set(
      topicId,
      existing.map(p => (p.id === tempId ? { ...p, id: serverPostId, _isOptimistic: false } : p))
    );
  } else {
    queue.set(topicId, existing.filter(p => p.id !== tempId));
  }
};

export const clearPendingOptimisticPost = (topicId, postId) => {
  if (!topicId || !postId) return;
  const existing = queue.get(topicId) || [];
  queue.set(topicId, existing.filter(p => p.id !== postId));
};

export const clearAllOptimisticPosts = (topicId) => {
  if (!topicId) return;
  queue.delete(topicId);
};
