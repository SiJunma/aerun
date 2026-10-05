import { pb } from './pocketbase';

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
  let cancelled = false;
  let delivered = false;
  let unsubscribe = null;
  let watcher = null;
  let lastConnected = null;

  const report = (connected) => {
    if (cancelled || connected === lastConnected) return;
    lastConnected = connected;
    onStateChange?.(connected);
  };

  const reportDead = () => {
    // Once per transition. A reconnect loop that reported every drop would
    // restart the poll interval every time, which is a reconnect storm wearing
    // the costume of a fallback.
    if (cancelled || delivered) return;
    delivered = true;
    onDead?.();
  };

  try {
    // The SDK sends the Authorization header from the auth store on the realtime
    // connection, so a signed-in member's subscription resolves through the
    // collection's own list rule and a guest's resolves to nothing.
    //
    // `subscribe` returns a Promise in this SDK version, and the unsubscribe it
    // resolves with is the only handle on the stream. Holding it in a local is
    // what makes a cancel that arrives first still work: without the holder,
    // "cancelled before the promise settled" would have no way to close the
    // connection it just opened.
    // The promise resolving IS the connection being up: `subscribe` awaits
    // `connect()`, which resolves its pending connects inside the PB_CONNECT
    // handler, after the client id has been negotiated.
    const pending = pb.collection('realtime_signals').subscribe('*', (_event, record) => {
      if (cancelled) return;
      delivered = true;
      // The id is a nudge target, not a permission: the client still has to ask
      // `/api/aerun` for anything real, and that request is what enforces access.
      onEvent?.(record?.topic, record?.entity_id);
    });

    Promise.resolve(pending)
      .then((unsub) => {
        unsubscribe = unsub;
        if (cancelled) { close(); return; }
        report(true);
        // Watches for the drop the SDK does not announce, and for the reconnect
        // it makes on its own.
        watcher = setInterval(() => {
          if (!cancelled) report(!!pb.realtime?.isConnected);
        }, CONNECTION_POLL_MS);
      })
      .catch((err) => {
        // A subscription that cannot even be established is a dead stream, and
        // the grace window in shared-poll will fall back to polling. Reporting it
        // the same way keeps one code path for "no realtime" instead of two.
        if (!cancelled) {
          console.warn('[realtime-signals] subscription failed; polling will cover it', err);
          reportDead();
        }
      });
  } catch (err) {
    console.warn('[realtime-signals] could not subscribe; polling will cover it', err);
    reportDead();
  }

  function close() {
    if (watcher) { clearInterval(watcher); watcher = null; }
    if (typeof unsubscribe === 'function') {
      try { unsubscribe(); } catch { /* already closed */ }
    }
    unsubscribe = null;
  }

  return () => {
    // Idempotent: React StrictMode mounts effects twice in development, so this
    // runs on a stream that may already be closing.
    if (cancelled) return;
    cancelled = true;
    close();
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