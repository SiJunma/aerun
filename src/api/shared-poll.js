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

// How long a successful read stays "fresh" for the connect-replay decision.
// The realtime hook's onConnected used to unconditionally requestRefresh(), so
// a cold start always paid TWO requests: start()'s initial read plus the
// connect replay ~250ms behind it, for state that had just been read. The
// replay now runs only when the last successful read is older than this
// window (or nothing has ever succeeded) — resources that OPT IN (see
// `skipConnectReplayMs` below; currently only dm-unread, whose counters are
// cheap, caller-scoped, and double-read on every cold start).
const REPLAY_FRESH_MS = 1000;

// Exported for the transport tests, which assert against the REAL windows rather
// than a shortened stand-in. Asserting on a faked timer would only prove the fake
// behaves; asserting on the shipped value proves the shipped value.
export { REFRESH_COALESCE_MS, REPLAY_FRESH_MS };

// A background tab is invisible, not gone: nothing is rendered from these values
// until the tab comes back, and the read on return is unconditional.
const tabIsHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Realtime hooks are currently ABSENT on purpose.
 *
 * `lockBrowserRules` (migration 1766100000, and the DM/notification migration
 * 1766400000) sets ListRule and ViewRule to nil on every collection the forum
 * reads, and PocketBase answers a nil access rule with "only superusers"
 * (core/record_query.go: `if accessRule == nil { return false }`). A wildcard
 * realtime topic resolves through that same ListRule, so a member's
 * `pb.collection('topics').subscribe('*')` opens the SSE stream, the network tab
 * shows PB_CONNECT, and the server then never delivers a single event.
 *
 * That is what "the realtime stream is dead" means: it was never alive. Each
 * hook was an open connection carrying nothing, and the freshness everybody
 * actually sees has always come from the interval below.
 *
 * The `realtime` OPTION is kept so re-enabling this is a one-line change per
 * resource rather than a rewrite — but it is only honoured if a caller passes
 * it, and no caller does today.
 *
 * The unsubscribe a hook returns is always safe to call, including before the
 * subscription promise settled: that is the window in which a React effect
 * cleanup unmounts a component that has not finished subscribing.
 */
// Realtime transport.
//
// THE REFUSAL IS GONE, and the reason it existed is worth keeping on the record.
// Every collection the forum reads had ListRule nil, which PocketBase answers
// with "only superusers" — so a subscription completed the SSE handshake, the
// network tab showed PB_CONNECT, and not one event ever arrived. A hook that
// could never deliver was refused loudly so the next person adding one would
// learn why instead of shipping another silent stream.
//
// That is no longer true, and the fix was NOT to open the collections. See
// markdowns/DONE_REALTIME_TRANSPORT_DESIGN.md: realtime is authorized by the very
// same ListRule/ViewRule as REST, so streaming forum content would mean
// re-opening REST reads on it. Instead the browser subscribes to
// `realtime_signals`, a table that carries only {topic, entity_id,
// audience_id, at} — an id and nothing else — and re-reads the real thing
// through /api/aerun, where authorization already lives.
//
// The contract this module now implements:
//   realtime CONNECTED     → no interval at all
//   connection not made in the grace window → the interval starts
//   dropped after being connected → the interval resumes, and closes again if
//     realtime comes back
//
// "Healthy" means CONNECTED, not delivered. It used to mean delivered, on the
// reasoning that a stream which opens and stays silent is the dead-stream failure
// this file spent years guarding against — a real failure back when every
// collection the forum read had a nil ListRule, so a subscription completed the
// handshake and then had every event refused.
//
// That no longer describes the signal table, whose audience rule works and whose
// delivery is covered by TestDMPostSignalReachesOnlyItsRecipient. Requiring an
// event was what produced "realtime keeps dying": an idle DM thread emits nothing
// for minutes, so a perfectly healthy stream was declared broken after ten
// seconds and every member was pushed onto their poll interval permanently. The
// stream stayed open the whole time. Nobody ever saw a benefit from it again.
//
// The delivery check is not deleted, it is demoted: an event still proves the
// stream carries, which is what makes shared-poll drop the interval — it just no
// longer has to arrive first.
//
// REALTIME_GRACE_MS is how long a hook has to establish its connection before
// the interval takes over.
//
// Long enough that a healthy stream on a slow phone connection is not declared
// dead and made to poll as well, short enough that a member is not waiting
// 30 seconds to find out the stream is not coming.
const REALTIME_GRACE_MS = 10000;

// Exported for the same reason as REFRESH_COALESCE_MS: the fallback test asserts
// on the shipped window, because the whole point of the test is that the member
// waits this long and not some other amount.
export { REALTIME_GRACE_MS };

/**
 * Wraps a realtime hook so the resource learns whether the stream is actually
 * connected, and can be told when it stops.
 *
 * The hook is called with three callbacks rather than returning a transport
 * object, because the two sides of the contract are asymmetric: the consumer
 * answers "here is an event" and "here is the connection state", and the wrapper
 * answers "here is your stream, and report its death". Returning the unsubscribe
 * from the hook keeps the caller from having to hold on to the stream itself.
 *
 * `onDelivered` (an event arrived) and `onStateChange(true)` (the connection is
 * up) are NOT the same signal and both are honoured: the connection is what
 * marks the stream healthy, the event is what proves it carries. A hook written
 * before `onStateChange` existed simply never calls it, and still works — it just
 * keeps the stricter "first event" rule for its own resources.
 *
 * `onDead` is called at most once per established stream, so a reconnect storm
 * cannot turn into a storm of interval restarts.
 */
const bindRealtimeHook = (hook, { onDelivered, onConnected, onDead }) => {
  let delivered = false;
  let stopped = false;

  const unsubscribe = hook(() => {
    delivered = true;
    onDelivered();
  }, () => {
    // Only fires for a hook that never learned to report its connection state,
    // where "dropped" can only mean "never arrived".
    if (stopped || delivered) return;
    stopped = true;
    onDead();
  }, (connected) => {
    // A drop must be reported even when events had already arrived, which is the
    // whole point: the member's stream can die mid-conversation, and the fallback
    // has to come back for that, not only for a stream that never worked. The SDK
    // reconnects on its own, so `connected` arriving again after a drop has to
    // lift the flag — gating this on "never delivered" is what pinned the
    // resource to polling for the rest of the session.
    //
    // No dedupe guard here on purpose: `report()` in realtime-signals already
    // emits only on TRANSITIONS, so the wrapper cannot be asked to ignore a
    // reconnect. A guard written once ("don't repeat what I just said") is
    // exactly what swallowed the reconnect.
    stopped = !connected;
    if (connected) onConnected();
    else if (!delivered) onDead();
  });

  return {
    unsubscribe: () => {
      stopped = true;
      // Safe before the subscription promise settles, and safe twice: React
      // StrictMode mounts effects twice in dev, and an unsubscribe that throws
      // on a second call is a dev-only crash that hides real ones.
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch { /* already gone */ }
      }
    },
    isHealthy: () => delivered,
  };
};
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
 * @param {number} [options.skipConnectReplayMs] opt-in freshness window for the
 *   connect-replay: when > 0, onConnected skips its catch-up refresh if the
 *   last successful read is younger than this many ms. 0 = always replay.
 */
export const createSharedPoll = ({
  fetch,
  intervalMs = 0,
  initialValue = null,
  onError = null,
  realtime = null,
  name = 'resource',
  skipConnectReplayMs = 0,
}) => {
  const subscribers = new Set();

  let value = initialValue;
  let loaded = false;
  let error = null;
  // Timestamp of the last successful read. Used only for the opt-in connect-
  // replay freshness check below; it does not gate the interval, the
  // visibility catch-up, or explicit refresh() calls.
  let lastReadOkAt = 0;

  let timer = null;
  let inFlight = false;
  let queued = false;
  let coalesceTimer = null;
  let running = false;
  // `transport` is the observable answer to "is this resource actually live, or
  // is it polling because the stream never showed up". It starts as 'idle'
  // rather than 'realtime' on purpose: a resource that has not started yet has
  // proved nothing, and defaulting to the optimistic value is how a broken
  // stream gets reported as working.
  let transport = 'idle';
  let realtimeBinding = null;
  let graceTimer = null;
  const transportListeners = new Set();

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
      lastReadOkAt = Date.now();
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

  const startTimer = () => {
    if (timer || intervalMs <= 0 || !running) return;
    timer = setInterval(() => {
      if (!tabIsHidden()) read();
    }, intervalMs);
  };

  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  // The transport is OBSERVABLE, not inferred. The failure this whole mechanism
  // exists to avoid is a stream that looks configured and delivers nothing, so
  // "realtime is enabled" and "realtime is carrying" must never be the same
  // sentence in the code — or in the UI.
  const setTransport = (next) => {
    if (transport === next) return;
    transport = next;
    transportListeners.forEach((cb) => {
      try { cb(transport); } catch (err) {
        console.warn(`[shared-poll:${name}] transport listener threw`, err);
      }
    });
  };

  const start = () => {
    if (running) return;
    running = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    if (realtime) {
      setTransport('connecting');
      realtimeBinding = bindRealtimeHook(realtime, {
        name,
        // Connected: the stream is up and able to deliver, so the interval is not
        // merely paused but REMOVED — running both is how a "realtime" feature
        // ends up costing exactly what it was supposed to save. No event has to
        // have arrived for this to happen, which is the whole fix.
        onConnected: () => {
          stopTimer();
          setTransport('realtime');
          // Catch up now. Everything that changed while this resource believed it
          // had no realtime was never fetched. OPT-IN exception: a resource that
          // set skipConnectReplayMs and whose last successful read is younger
          // than that window (or is still in flight) skips this replay — the
          // primary read has just delivered this exact answer, and the replay
          // would be a byte-for-byte duplicate ~250ms behind it.
          if (!skipConnectReplayMs
            || lastReadOkAt === 0
            || Date.now() - lastReadOkAt > skipConnectReplayMs) {
            requestRefresh();
          }
        },
        onDelivered: () => {
          stopTimer();
          setTransport('realtime');
          // …and this is the half that makes the signal worth having: the event
          // carries an id and no content, so the ONLY way to turn it into
          // anything is to go and re-read through /api/aerun. Without this call
          // the stream is healthy, the timer is gone, and the list silently
          // stops updating — a worse failure than polling, because it looks
          // configured.
          requestRefresh();
        },
        onDead: () => {
          // Either a subscription that never connected, or one that dropped
          // mid-session. Both cost the interval.
          stopTimer();
          setTransport('polling');
          startTimer();
          // Catch up NOW rather than at the next tick. Whatever changed while
          // the stream was believed to be connected was never fetched, and a
          // member who has just lost realtime is exactly the member who cannot
          // afford to wait for a poll to notice.
          requestRefresh();
        },
      });
      // The grace window is a timeout on the CONNECTION, not on the first event.
      // A stream that never opens is exactly the failure being designed out, so
      // it must fall back on exactly the same terms as a dead one.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (running && transport === 'connecting') {
          setTransport('polling');
          startTimer();
          // Same opt-in freshness rule as onConnected: a stream that never
          // opens falls back to polling, but within the window the primary
          // read has already landed — do not immediately pay twice.
          if (!skipConnectReplayMs
            || lastReadOkAt === 0
            || Date.now() - lastReadOkAt > skipConnectReplayMs) {
            requestRefresh();
          }
        }
      }, REALTIME_GRACE_MS);
    } else {
      setTransport('polling');
      startTimer();
    }

    read();
  };

  const stop = () => {
    if (!running) return;
    running = false;
    stopTimer();
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (realtimeBinding) {
      realtimeBinding.unsubscribe();
      realtimeBinding = null;
    }
    setTransport('idle');
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
    // Which transport is actually carrying this resource right now:
    // 'idle' | 'connecting' | 'realtime' | 'polling'.
    //
    // Exposed because "realtime is configured" and "realtime is delivering" are
    // different claims, and only this one is measured. The first is what a
    // feature flag tells you; the second is what a member experiences.
    getTransport: () => transport,
    // Watch the transport change. Returns an unsubscribe, because a listener
    // that cannot be removed is how a long session accumulates callbacks on a
    // resource it stopped caring about.
    onTransportChange: (cb) => {
      transportListeners.add(cb);
      // Hand over the current value, so a banner mounted after the fact does
      // not have to wait for the next transition to find out where it stands.
      try { cb(transport); } catch { /* a bad listener must not break subscribe */ }
      return () => transportListeners.delete(cb);
    },
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