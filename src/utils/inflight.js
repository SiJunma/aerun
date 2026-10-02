/**
 * Double-submit protection for commands that create content.
 *
 * WHY THIS EXISTS — the window React cannot close:
 *
 * The obvious guard is `if (submitting) return;` with `submitting` in component
 * state, plus `disabled={submitting}` on the button. Both were in place, and
 * both fail the same way: React batches state updates, so two clicks landing in
 * the SAME TICK both read `submitting === false` from the render closure. The
 * second one is not a stale guard, it is a guard that never saw the first.
 * This is documented in markdowns/POST_DELETE_WIPED_TOPIC_INCIDENT.md.
 *
 * A ref closes it: writing to `useRef` is not batched, so the second click sees
 * the first one's write immediately. That is the whole difference, and it is why
 * this is a plain object held in a ref rather than state — state cannot express
 * "already in flight" without a render in between.
 *
 * The second half is the IDEMPOTENCY KEY. `sendApi` generates a random key per
 * call, so two clicks produce two different keys and the server correctly treats
 * them as two distinct commands — a guard that fails for one tick is enough to
 * create two posts. Passing a stable key per logical submit means that even if a
 * second request does escape, the server collapses it onto the first. Guard and
 * key are belt and braces, and neither alone is sufficient.
 */

/**
 * Creates an in-flight latch.
 *
 * `begin()` returns true exactly once per busy period: the first caller wins
 * and every caller in the same period gets false, so the caller can bail out
 * before doing any work. `end()` releases it, and it MUST be called from a
 * finally block — a latch never released is a button that works once.
 *
 * @returns {{begin: () => boolean, end: () => void, isBusy: () => boolean}}
 */
export const createInFlight = () => {
  let busy = false;
  return {
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    isBusy() {
      return busy;
    },
  };
};

/**
 * Builds an idempotency key for ONE logical submit.
 *
 * Generated ONCE per submit attempt and reused by every request that attempt
 * makes, which is what makes the server treat a duplicate as a replay rather
 * than a second command. A key per HTTP call — which is what sendApi does by
 * default — defeats the whole mechanism.
 *
 * The backend requires 16..128 characters, so the random part is fixed at 32
 * hex characters and the prefix is short.
 *
 * @param {string} scope what is being created, e.g. 'post' or 'topic'
 * @returns {string}
 */
export const newIdempotencyKey = (scope = 'cmd') => {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : Array.from({ length: 4 }, () =>
          Math.floor(Math.random() * 0x100000000)
            .toString(16)
            .padStart(8, '0')
        ).join('');
  return `${scope}-${random}`.slice(0, 128);
};