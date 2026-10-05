/**
 * Connection-restored signal.
 *
 * The banner knows the backend came back, but it does not know what the app is
 * showing. Every one-shot fetcher in this codebase (`subscribeToCategoryGroups`,
 * `subscribeToUserNotifications`, and friends) fetches ONCE on mount and, when
 * that request fails while the backend is down, settles with an EMPTY list. That
 * empty list is indistinguishable from a real empty list, so when the connection
 * returns the page keeps rendering "no categories" over data that exists.
 *
 * Hiding the banner therefore is not enough: something has to re-run the reads.
 * This module is the one place that knows about the transition, so the banner
 * announces it and the data layers listen, instead of each page guessing when to
 * refresh.
 */

const RESTORED_EVENT = 'aerun:connection-restored';

/**
 * Fired when connectivity is regained.
 *
 * Dispatched on `window`, so it also reaches listeners that mounted while the
 * backend was down — which is the normal case: the page loaded, its first read
 * failed, and it has been sitting on empty state ever since.
 */
export const notifyConnectionRestored = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(RESTORED_EVENT));
};

/**
 * Runs `handler` on the next restore. Returns an unsubscribe.
 *
 * `subscribeToRefetch` composes this with a plain re-read so a caller can express
 * "fetch this again whenever we come back" in one line instead of repeating the
 * event wiring at every call site.
 */
export const onConnectionRestored = (handler) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(RESTORED_EVENT, handler);
  return () => window.removeEventListener(RESTORED_EVENT, handler);
};

/**
 * Runs `reload` once on mount and again after every connection restore.
 *
 * `reload` owns its own error handling: the restore signal fires while the
 * backend may still be flaky, and a rejected read must not leave a listener
 * registered twice or take the page down.
 */
export const subscribeToRefetch = (reload) => {
  const safeReload = () => {
    try {
      const result = reload();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      // A refetch that throws must not break the restore cycle.
    }
  };

  return onConnectionRestored(safeReload);
};