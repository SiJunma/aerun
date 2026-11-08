import { pb } from './pocketbase.js';

/**
 * Realtime signals: the nudge queue the whole realtime transport runs on.
 *
 * WHAT ARRIVES HERE IS NOT CONTENT. A signal is `{topic, entity_id,
 * audience_id, at}` — an id and nothing else — because on this PocketBase
 * version realtime is authorized by the same ListRule/ViewRule as REST
 * (`apis/realtime.go:605-614`), so streaming a post or a notification directly
 * would mean re-opening REST reads on it. The client therefore learns that
 * something changed and re-reads the real thing through `/api/aerun`, where
 * authorization already lives.
 *
 * That is the whole design. The danger it guards against is a future edit that
 * makes this "smarter" by trusting the payload, so nothing here reads the record
 * and `onEvent` receives no data at all — see the caller in shared-poll.
 *
 * GUESTS GET NOTHING, and that is the rule's first clause rather than an
 * accident: a signed-out visitor's auth id is "", which matches neither a
 * specific audience nor the "*" wildcard. Polling keeps the page correct for
 * them, so there is nothing to gain by re-opening anonymous access.
 *
 * HEALTH IS CONNECTION, NOT DELIVERY — why `onStateChange` exists.
 *
 * The health check used to wait for a signal to ARRIVE before believing the
 * stream, on the theory that a stream which opens and stays silent is dead. That
 * was written when every forum collection had a nil ListRule, so a subscription
 * completed the handshake and then had every event refused: silence really was a
 * broken stream.
 *
 * It no longer describes this collection, whose rule is a working
 * `@request.auth.id` audience check and whose delivery is pinned by
 * TestDMPostSignalReachesOnlyItsRecipient against a real client. And it caused
 * the reported failure, "realtime keeps dying": a DM thread nobody is typing in
 * emits no signal for minutes, so every member with an idle conversation was
 * declared broken after ten seconds and pushed onto the poll interval for good —
 * with the stream open the entire time and fully able to deliver.
 */

/**
 * How often the stream's own connection state is re-read.
 *
 * The SDK reconnects on its own with backoff and emits NO disconnect event, so
 * there is nothing to listen to when a connection dies. `pb.realtime.isConnected`
 * is a plain getter over the EventSource and the negotiated client id, so
 * sampling it is the only way to learn that a drop happened — and it costs
 * nothing: no request, no event, just a boolean read on a timer.
 *
 * Five seconds is short enough that a member whose stream died mid-conversation
 * gets polling back before they notice, and long enough that the sample is
 * invisible next to any network cost.
 */
const CONNECTION_POLL_MS = 5000;

/**
 * How long a stream may be SILENT before we count it as flapping.
 *
 * PocketBase v0.40.4 has no SSE keepalive: an idle forum emits nothing, and
 * Cloudflare's edge idle-closes a stream that carries no bytes for ~100s.
 * Every idle open page would otherwise reconnect every few minutes — the
 * client sees one drop and then a reconnect storm. The server now publishes
 * a keepalive signal every 25s (see realtimeKeepaliveInterval in
 * realtime_signals.go), which resets PocketBase's idle timer AND the edge's.
 * The client must NEVER treat keepalive as forum content, but it DOES prove
 * the stream is carrying bytes. If we see no keepalive AND no real signal
 * for SILENT_MS we assume a Cloudflare idle-close / QUIC reset and park the
 * hub into polling so the page does not storm — the next genuine member join
 * or token rotation reopens it. This is the frontend half of the fix; the
 * backend half is the ticker.
 */
const SILENT_MS = 30_000;

/**
 * Circuit breaker for the realtime hub.
 *
 * The PocketBase SDK reconnects its EventSource on its own with backoff and
 * never tells us a connection died. When the edge keeps resetting the stream
 * (the QUIC-protocol-error storm: the browser sees `net::ERR_QUIC_PROTOCOL_ERROR`
 * on every `GET /api/realtime`), the SDK alone would keep reopening a doomed
 * socket for the whole session — that is what fills DevTools with the same
 * error line for minutes while polling already covers freshness. One dead
 * hub retry the SDK makes is free; an endless per-session storm is not.
 *
 * So the hub gives up after MAX_FAILURES failed handshakes (with
 * increasing backoff between retries) and stays dead — callers are already on
 * their polling fallback — until the next genuine open: a new member joins,
 * the last member leaves and returns, or the auth token rotates. A success
 * resets the counter, so a stream that flaps once and then holds is never
 * parked for the session.
 */
const MAX_FAILURES = 3;
const RETRY_BASE_MS = 2000;

// ── The hub ──────────────────────────────────────────────────────────────────
//
// Every call site used to open its OWN SDK subscription to the same topic. The
// SDK multiplexes them over one EventSource, but each subscribe call still cost
// a POST /api/realtime registration (the POST carries the FULL subscription
// list) plus one CONNECTION_POLL_MS watcher running on its own timer, and on
// the main page two resources were live at cold start — two registrations and
// two watchers for one stream.
//
// The hub holds ONE SDK subscription for the whole app. Callers join as
// callback bundles and leave when their unsubscribe runs; the last departure
// closes the stream, so an idle page holds no SSE connection, no registrations
// and no watcher at all.
//
// One more job the hub takes over: the SSE connection carries the auth token
// from the moment it was opened, and the server binds the negotiated client id
// to that identity. A token that rotates later (an auth-refresh) would leave
// the stream speaking for an expired session, and nothing in the call sites
// rebinds on a token change with the SAME uid — their effects key on
// `user?.uid`. The hub watches the auth store and rebuilds the stream when the
// token actually changes under live membership.
let hubMembers = new Set();
let hubUnsubscribe = null;
let hubWatcher = null;
let hubEstablished = false;
// True while the subscribe promise is still negotiating. The guard in
// ensureHub must count it, or two members joining in the same tick would each
// open their own SDK subscription — the very duplication the hub exists to
// prevent — and the first resolved unsubscribe handle would be overwritten and
// leaked.
let hubPending = false;
let hubLastConnected = null;
let hubGeneration = 0;
let hubLastToken = null;
// Circuit-breaker state (see MAX_FAILURES): consecutive failed handshakes
// since the last success, and the parked-until timer.
let hubFailures = 0;
let hubRetryTimer = null;
let hubCircuitOpen = false;
// Last time ANY bytes arrived on the SSE stream (real signal or keepalive).
// Used by the silent-stream guard in the watcher: a stream that has been
// established for a while but has delivered nothing — not even keepalive —
// is a Cloudflare idle-close / QUIC reset that the SDK is papering over
// with silent reconnects. We count that as dead and park the hub.
let hubLastBytesAt = 0;

const broadcastState = (connected) => {
  if (connected === hubLastConnected) return;
  hubLastConnected = connected;
  hubMembers.forEach((member) => {
    try { member.onStateChange?.(connected); } catch (e) { console.error(e); }
  });
};

const broadcastDead = () => {
  hubMembers.forEach((member) => {
    try { member.onDead?.(); } catch (e) { console.error(e); }
  });
};

const closeHub = () => {
  // Bump the generation first: a subscription promise that was still
  // negotiating must see itself stale instead of re-opening the stream for
  // members that have already left.
  hubGeneration += 1;
  hubPending = false;
  if (hubWatcher) { clearInterval(hubWatcher); hubWatcher = null; }
  if (hubRetryTimer) { clearTimeout(hubRetryTimer); hubRetryTimer = null; }
  // An empty membership is a fresh start, not a continuation: the next
  // member joins a hub that has never failed, so the failure count earned
  // by a previous session of members does not follow it.
  if (hubMembers.size === 0) hubFailures = 0;
  const unsub = hubUnsubscribe;
  hubUnsubscribe = null;
  hubEstablished = false;
  hubLastConnected = null;
  if (typeof unsub === 'function') {
    try { unsub(); } catch { /* already closed */ }
  }
};

const ensureHub = (force = false) => {
  if (hubEstablished || hubPending || hubUnsubscribe) return;
  // Circuit breaker: after MAX_FAILURES consecutive failed handshakes the
  // hub parks itself and only retries on a genuine open (a new member, or
  // a token rotation), not on every timer tick — otherwise a doomed stream
  // reproduces the exact reconnect storm this guard exists to stop.
  if (hubCircuitOpen && !force) return;
  const generation = hubGeneration;
  hubPending = true;
  hubLastToken = pb.authStore.token;

  try {
    // The SDK sends the Authorization header from the auth store on the realtime
    // connection, so a signed-in member's subscription resolves through the
    // collection's own list rule and a guest's resolves to nothing.
    //
    // `subscribe` returns a Promise in this SDK version, and the unsubscribe it
    // resolves with is the only handle on the stream. Holding it in a module
    // local is what makes a close that arrives first still work: without the
    // holder, "closed before the promise settled" would have no way to close
    // the connection it just opened.
    // The promise resolving IS the connection being up: `subscribe` awaits
    // `connect()`, which resolves its pending connects inside the PB_CONNECT
    // handler, after the client id has been negotiated.
    const pending = pb.collection('realtime_signals').subscribe('*', (_event, record) => {
      // ANY bytes prove the stream is carrying. The backend keepalive
      // (presence.heartbeat-keepalive, every 25s) is deliberately NOT forum
      // content: it updates hubLastBytesAt and then is swallowed, never
      // forwarded to members. Real signals update the timestamp AND are
      // forwarded as nudges.
      hubLastBytesAt = Date.now();
      if (record?.topic === 'presence.heartbeat-keepalive') return;
      // The id is a nudge target, not a permission: the client still has to ask
      // `/api/aerun` for anything real, and that request is what enforces access.
      hubMembers.forEach((member) => {
        try { member.onEvent?.(record?.topic, record?.entity_id); } catch (e) { console.error(e); }
      });
    });

    Promise.resolve(pending)
      .then((unsub) => {
        hubPending = false;
        if (generation !== hubGeneration) {
          // The hub was closed (or rebuilt for a new token) while this
          // subscription was still negotiating — close what just opened.
          try { unsub(); } catch { /* already closed */ }
          return;
        }
        hubUnsubscribe = unsub;
        hubEstablished = true;
        hubFailures = 0;
        hubCircuitOpen = false;
        hubLastBytesAt = Date.now();
        broadcastState(true);
        // Watches for the drop the SDK does not announce, and for the reconnect
        // it makes on its own. ONE watcher for every member of the hub.
        hubWatcher = setInterval(() => {
          if (hubMembers.size === 0) return;
          const connected = !!pb.realtime?.isConnected;
          if (!connected) {
            broadcastState(false);
            return;
          }
          // Stream is "connected" per the SDK, but has it CARRIED bytes
          // recently? PocketBase v0.40.4 has no keepalive: an idle forum
          // emits nothing, Cloudflare idle-closes at ~100s, and the SDK
          // silently reconnects — from the page's perspective that is a
          // healthy stream that never delivers. The backend keepalive
          // (every 25s) now proves carriage; if we have seen NOTHING
          // (not even keepalive) for SILENT_MS we assume an idle-close /
          // QUIC reset and park the hub into polling instead of storming.
          // The next genuine member join reopens it (see subscribeToRealtimeSignals).
          if (hubLastBytesAt && Date.now() - hubLastBytesAt > SILENT_MS) {
            console.warn('[realtime-signals] stream silent for >30s (no keepalive, no signal); parking hub into polling');
            broadcastDead();
            hubCircuitOpen = true;
            const keepMembers = new Set(hubMembers);
            closeHub();
            // closeHub cleared the unsub but members are still present;
            // restore them so the "next join reopens" logic works — without
            // members the hub would never retry.
            hubMembers = keepMembers;
            return;
          }
          broadcastState(true);
        }, CONNECTION_POLL_MS);
      })
      .catch((err) => {
        hubPending = false;
        // A subscription that cannot even be established is a dead stream, and
        // the grace window in shared-poll will fall back to polling. Reporting it
        // the same way keeps one code path for "no realtime" instead of two.
        if (generation !== hubGeneration || hubMembers.size === 0) return;
        console.warn('[realtime-signals] subscription failed; polling will cover it', err);
        broadcastDead();
        hubFailures += 1;
        // Set the retry timer BEFORE closing: closeHub clears any pending
        // retry timer, so a timer created after the close would still work
        // here, but ordering it before keeps one code path — close cancels
        // retries it does not own, never the one this failure just earned.
        if (hubFailures < MAX_FAILURES) {
          // Back off before the SDK is asked again: an immediate tight
          // retry loop is the same storm as an unbounded one, just faster.
          const generationAtFail = hubGeneration;
          hubRetryTimer = setTimeout(() => {
            hubRetryTimer = null;
            if (generationAtFail !== hubGeneration) return;
            if (hubMembers.size === 0) return;
            ensureHub();
          }, RETRY_BASE_MS * Math.pow(2, hubFailures - 1));
        } else {
          // MAX_FAILURES strikes: park the hub. Polling carries freshness
          // from here; the stream only comes back on a genuine open
          // (new member, last-leave reset, or token rotation).
          hubCircuitOpen = true;
          console.warn('[realtime-signals] realtime stream parked; polling will cover it until the next join or token change');
          return;
        }
        const keepTimer = hubRetryTimer;
        closeHub();
        // closeHub cancels pending retries — restore the one this failure
        // just scheduled, it is the backoff this failure earned.
        hubRetryTimer = keepTimer;
      });
  } catch (err) {
    console.warn('[realtime-signals] could not subscribe; polling will cover it', err);
    broadcastDead();
    closeHub();
  }
};

// Registered once, at module scope: this module is a singleton, and the store
// keeps no API for unregistering a listener by identity. Only a REAL token
// change under live membership rebuilds the stream — the boot-time saves that
// fire before any caller joined are no-ops, and an onChange that reports the
// same token (profile saves write the record back) is filtered above.
pb.authStore.onChange(() => {
  const token = pb.authStore.token;
  if (token === hubLastToken) return;
  hubLastToken = token;
  if (hubMembers.size === 0) return;
  closeHub();
  ensureHub(true);
});

/**
 * Subscribes to the signal stream.
 *
 * @param {(topic: string, entityId: string) => void} onEvent called for every
 *   delivered signal. Receives the topic and id ONLY — never the record, because
 *   the record is an id and a timestamp and nothing else, and a caller that
 *   renders from it would be rendering from a nudge.
 * @param {() => void} onDead called when the stream is not carrying, so the
 *   caller can fall back to polling.
 * @param {(connected: boolean) => void} [onStateChange] called on every
 *   connection TRANSITION — `true` when the stream is established, `false` when
 *   it has dropped. This is what marks realtime healthy, and see the note on the
 *   health contract below for why it is not "an event arrived".
 * @returns {() => void} unsubscribe. Idempotent, and safe to call before the
 *   subscription has settled — that window is exactly when a React effect
 *   cleanup runs, and an unsubscribe that throws there is a crash that only
 *   happens in development.
 */
export const subscribeToRealtimeSignals = (onEvent, onDead, onStateChange) => {
  const member = { onEvent, onDead, onStateChange };
  let cancelled = false;

  hubMembers.add(member);
  // A new member joining a parked hub is a genuine open: the circuit opens
  // only so the hub stops retrying on its own timers — a fresh caller gets
  // one force-retry. Without this a long-lived page whose stream parked
  // during one network blip would never try realtime again.
  if (hubCircuitOpen) hubCircuitOpen = false;
  ensureHub();
  // A caller joining an already-established hub learns its state immediately:
  // the hub's own subscribe promise resolved long ago and will not fire again,
  // so without this the late joiner would never hear that the stream is up.
  // A hub that is still negotiating (or dead) reports through the normal
  // transition paths once its subscription settles or fails.
  if (hubEstablished && hubLastConnected !== null) {
    try { onStateChange?.(hubLastConnected); } catch (e) { console.error(e); }
  }

  return () => {
    // Idempotent: React StrictMode mounts effects twice in development, so this
    // runs on a membership that may already be leaving.
    if (cancelled) return;
    cancelled = true;
    hubMembers.delete(member);
    // The last departure closes the stream. Until then the hub ignores every
    // individual cancel — the SDK subscription belongs to the hub, not to the
    // caller that happened to join first.
    if (hubMembers.size === 0) closeHub();
  };
};

/**
 * Whether this member can receive signals at all.
 *
 * A GUEST cannot, so a guest must not open the stream: the rule would refuse
 * every event, and the connection would sit there looking healthy — which is the
 * exact ambiguity this feature was built to eliminate.
 */
export const canReceiveSignals = () => !!pb.authStore.isValid || !!pb.authStore.token;