/**
 * ONE polling loop per shared resource, shared by every subscriber.
 *
 * WHY THIS EXISTS. Every `subscribeToX` in this codebase used to own its own
 * `setInterval` AND its own PocketBase realtime channel, and NOTHING was shared
 * between callers. `subscribeToUserNotifications` alone had three callers
 * (TitleProvider's tab badge, NotificationsPage, TopicPage's quote tracking), so
 * a single open topic page ran three identical `GET /me/notifications?limit=100`
 * loops every fifteen seconds — and an admin ran a fourth through
 * `subscribeToAdminNotifications`, which is literally the same call with the same
 * account id. The network log showed precisely that: `notifications?limit=100`
 * three or four times in a row, and `unread-counts` twice, because AuthProvider
 * and TitleProvider both subscribe to the unread counters.
 *
 * A shared poll makes the multiplicity impossible by construction:
 *
 *   - ONE loop per resource, however many components want the value. A
 *     subscriber joining an already-running resource costs nothing: it is handed
 *     the value that loop already holds.
 *   - At most ONE request in flight per resource. The old loops had no guard, so
 *     a response slower than the interval stacked an identical request behind
 *     the first one.
 *   - Refetch triggers are COALESCED. Realtime events, connection restores and
 *     interval ticks all funnel through one debounced `requestRefresh()`, so a
 *     burst of five notifications costs one read instead of five.
 *   - Nothing polls a HIDDEN tab. A loop that keeps firing in the background
 *     spends the member's data allowance refreshing something nobody is looking
 *     at; one read on return is enough, because every consumer re-reads the
 *     value anyway.
 *
 * ERROR HANDLING IS THE CALLER'S. Subscribers receive `(value, error)` so each
 * one keeps its own contract: TopicPage turns a failed topic read into an access
 * card, while a list read keeps its last good rows. A failed read never clears a
 * good value here — blanking a working page because one poll timed out is the
 * behaviour this module exists to remove.
 */

/**
 * How long refetch triggers coalesce before one read runs.
 *
 * Long enough to swallow a burst of realtime events for the same write, short
 * enough that a member posting a reply still sees it without feeling lag.
 */
const REFRESH_COALESCE_MS = 250;

// A background tab is invisible, not gone: nothing is rendered from these values
// until the tab comes back, and the read on return is unconditional.
const tabIsHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Wraps a PocketBase realtime subscription so it can never take the poll down.
 *
 * Realtime is a freshness shortcut here, never the only path: every resource
 * below also polls. So a failed or refused subscription costs freshness, not
 * correctness, and the returned unsubscribe is always safe to call — including
 * before the subscription promise settled, which is the window in which a React
 * effect cleanup unmounts a component that has not finished subscribing.
 */
export const bestEffortRealtime = (start) => {
  let unsub = () => {};
  try {
    const pending = start((fn) => { unsub = fn; });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // The interval is the contract; realtime is the bonus.
  }
  return () => {
    try { unsub(); } catch { /* a tab that is going away has nobody to tell */ }
  };
};

// __APPEND_IMPL__
/**
 * Builds a shared, visibility-aware, single-flight polling resource.
 *
 * @param {object} options
 * @param {() => Promise<any>} options.fetch the one read this resource makes
 * @param {number} [options.intervalMs] poll period; 0 disables the timer
 * @param {any} [options.initialValue] value delivered if the read never lands
 * @param {(err: any) => void} [options.onError] diagnostics hook
 * @param {(reload: () => void) => (() => void)} [options.realtime] realtime hook
 * @param {string} [options.name] label for diagnostics
 */
export const createSharedPoll = ({
  fetch,
  intervalMs = 0,
  initialValue = null,
  onError = null,
  realtime = null,
  name = 'resource',
}) => {
  const subscribers = new Set();

  let value = initialValue;
  let loaded = false;
  let error = null;

  let timer = null;
  let inFlight = false;
  let queued = false;
  let coalesceTimer = null;
  let running = false;
  let stopRealtime = null;

  const deliver = () => {
    // The resource is stopped while its last read is still in the air — every
    // caller has already rendered its unmount. Delivering now would set state on
    // a component that no longer exists.
    if (subscribers.size === 0) return;
    subscribers.forEach((cb) => {
      try { cb(value, error); }
      catch (err) { console.warn(`[shared-poll:${name}] subscriber threw`, err); }
    });
  };

  const read = async () => {
    if (inFlight) {
      // A trigger arrived mid-read. Remember it rather than starting a second
      // identical GET: the answer we are waiting on is already the newest one.
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const next = await fetch();
      value = next;
      loaded = true;
      error = null;
      deliver();
    } catch (err) {
      // The previous value is deliberately KEPT, and the error travels WITH it.
      // Clearing here is what made a single slow response blank a page that was
      // rendering perfectly well a moment earlier.
      error = err;
      if (onError) onError(err);
      deliver();
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        if (!tabIsHidden()) read();
      }
    }
  };

  const requestRefresh = () => {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      read();
    }, REFRESH_COALESCE_MS);
  };

  const onVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') read();
  };

  const start = () => {
    if (running) return;
    running = true;
    if (intervalMs > 0) {
      timer = setInterval(() => {
        if (!tabIsHidden()) read();
      }, intervalMs);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (realtime) stopRealtime = realtime(requestRefresh);
    read();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
    if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (stopRealtime) { stopRealtime(); stopRealtime = null; }
  };

  const subscribe = (cb) => {
    subscribers.add(cb);
    if (subscribers.size === 1) {
      start();
    } else if (loaded) {
      // Already running: hand over what this resource knows. A second component
      // wanting the same value must NOT cost a second request.
      try { cb(value, error); } catch (err) {
        console.warn(`[shared-poll:${name}] subscriber threw`, err);
      }
    }
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) stop();
    };
  };

  return {
    subscribe,
    // For callers that mutate and need the read back without waiting for a tick.
    refresh: requestRefresh,
    getValue: () => value,
    isLoading: () => !loaded,
    // Releases the loop without touching the cached value, so a later subscriber
    // gets the last known answer immediately instead of an empty frame. Used by
    // resources whose subscribers are themselves reference-counted elsewhere (the
    // presence snapshot is started by the online/guest sets and watched by the
    // banner), where the resource cannot infer that nothing is left watching.
    stopIfIdle: stop,
  };
};

// One resource per NAME, no matter how many times it is asked for.
//
// This is the part that makes sharing real. `createSharedPoll` called twice with
// the same name would return two independent resources with two timers and two
// realtime channels — the exact duplication this module exists to remove, just
// moved one level down. Components that subscribe on mount (TopicPage and the
// notifications list, say) each call the same exported `subscribeToX` helper, so
// the helper is what must resolve to ONE resource, not the caller.
//
// The FIRST caller's options win. Two callers naming the same resource are asking
// for the same thing by construction, so there is nothing to negotiate; and a
// later caller must not be able to silently swap the interval under a running
// resource that other components are already rendering from.
const byName = new Map();

export const sharedPoll = (name, options) => {
  const existing = byName.get(name);
  if (existing) return existing;
  const created = createSharedPoll({ ...options, name });
  byName.set(name, created);
  return created;
};

// Exposed for tests and for the rare case that must prove a resource is idle.
// Not used by app code.
export const __resetSharedPolls = () => byName.clear();