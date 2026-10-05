/**
 * Normalises anything date-shaped into epoch milliseconds, or 0 when there is no
 * usable value.
 *
 * WHY THIS EXISTS. Four components floor their unread count at the account's
 * registration date, and each of them had its OWN copy of that parse — three of
 * them wrong in the same way:
 *
 *   profile?.created_at?.toMillis?.()
 *
 * The server sends `created_at` as a plain "2026-04-17" day string, so
 * `?.toMillis?.()` does not throw here; it returns undefined and the whole
 * expression collapses to `0`. That is worse than a crash, because it is silent:
 * the unread floor becomes the epoch, so a brand-new account is shown every topic
 * ever posted as unread, and no error anywhere points at the cause. (The
 * optional-chain trap in `scripts/check-date-accessors.mjs` is written against
 * `?.toMillis()` with a CALL, which is why this variant slipped past it.)
 *
 * One place to normalise means a fourth consumer cannot get it wrong a fourth
 * way, and that the shapes a value may legitimately take are enumerated once.
 *
 * The shapes, all of them real in this codebase:
 *   - `2026-04-17`             the day-only registration date from the profile DTO
 *   - `2026-04-17 22:45:57Z`   a PocketBase datetime, space instead of "T"
 *   - `{ toMillis() }`         a Firestore Timestamp from an optimistic local write
 *   - `{ seconds, nanoseconds}` a serialised Timestamp cache
 *   - `new Date()`             anything already converted
 *   - a bare number            an optimistic last-visit stamp
 *
 * An unparseable value is 0, NOT NaN: these numbers feed Math.max and `<`
 * comparisons, and a NaN poisons every comparison it touches, which is how a
 * silently broken value becomes a silently wrong sort order.
 *
 * @param {*} value any date-shaped value, or nullish
 * @returns {number} epoch milliseconds, or 0 when nothing usable is present
 */
export const toMillis = (value) => {
  if (value === null || value === undefined || value === '') return 0;

  // Already epoch ms. Checked first because a number has no methods, and because
  // `new Date(1776384000000).getTime()` would also work but only by accident.
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  // Firestore Timestamp, still live in the read map and in optimistic local
  // writes. These probes MUST come before the generic parse below: `new Date` on
  // a Timestamp object stringifies it to "[object Object]" and yields NaN, so a
  // Timestamp would silently floor at 0 — the exact failure this helper exists
  // to end, reintroduced one line down.
  if (typeof value.toMillis === 'function') {
    const fromMillis = value.toMillis();
    if (Number.isFinite(fromMillis)) return fromMillis;
  }
  if (typeof value.toDate === 'function') {
    const fromDate = value.toDate().getTime();
    if (Number.isFinite(fromDate)) return fromDate;
  }

  // A serialised Timestamp cache: { seconds, nanoseconds }. Both numbers, so
  // `new Date` would read the object as "[object Object]" and fail.
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }

  // A Date, or any string.
  //
  // THE POCKETBASE SPACE FORM IS NORMALISED HERE, AND THIS IS THE FIX FOR
  // "last activity in the future". PocketBase serialises a DateTime as
  // "2026-10-04 16:50:00.000Z" — a SPACE where ISO 8601 requires "T". V8 accepts
  // the space form and still honours the Z, so the bug hides in Chrome and
  // appears elsewhere; but the format is not one the spec requires a parser to
  // accept, and an engine that ignores the trailing Z reads the wall clock as
  // LOCAL time. That shifts the instant by the whole UTC offset — measured at 4
  // hours in this project — and for a value that is genuinely ~now (a
  // heartbeat, a member who is online) it lands the timestamp in the FUTURE:
  // the LAST SEEN column reading ahead of the clock it is measuring against.
  //
  // Normalising at the one place every reader goes through is what makes it a
  // fix rather than a patch: presence, guests, the stats panel and the members
  // board all funnel through here.
  const text = typeof value === 'string' ? value.replace(' ', 'T') : value;
  const parsed = new Date(text).getTime();
  if (Number.isFinite(parsed)) return parsed;

  return 0;
};

/**
 * The unread floor: the later of "when the member last visited" and "when the
 * member registered", so an account is never shown a wall of unread topics that
 * predate it.
 *
 * WHY IT IS A FUNCTION AND NOT AN INLINE Math.max. The two operands arrive in
 * different shapes from different sources — the read map holds Firestore
 * Timestamps and optimistic numbers, the registration date is a day string — and
 * the bug this replaces was four sites each picking a different subset of those
 * shapes. Both terms go through toMillis so the comparison is total.
 *
 * Registration is the second term precisely because registration IS real
 * activity: for an account with no read state at all it is a true lower bound,
 * and "..." would be the honest alternative, not 0.
 *
 * @param {*} lastVisitMs the member's last-visit stamp, in any shape
 * @param {*} registrationAt the account's registration date, in any shape
 * @returns {number} the earlier instant from which a topic counts as unread
 */
export const unreadFloor = (lastVisitMs, registrationAt) =>
  Math.max(toMillis(lastVisitMs), toMillis(registrationAt));