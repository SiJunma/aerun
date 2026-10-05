// A DM edit or delete must repaint the message the member is looking at.
//
// REPORTED: "I edited the message — nothing appeared. I deleted it — the toast
// arrived and the bubble did not change at all." Then, trying to edit it again
// and getting a 409: the server had done exactly what it was asked, on the very
// first click.
//
// The write reached the database every time and the read path was fine — the
// list serves `deleted: true` with no `text` to the recipient, and that has its
// own test. What was missing is the link between the two: `handleSaveDmEdit` and
// `handleDeleteDm` awaited the request, DISCARDED the response and showed a
// success toast, leaving the bubble to repaint itself.
//
// It could not, and this is the part worth pinning:
//
//   - a message mutation publishes its signal to the other participant only
//     (publishDMSignalToPeers), so the author is never signalled about their
//     own change;
//   - shared-poll removes the fallback interval the first time ANY signal
//     arrives, on the grounds that the stream is now carrying.
//
// Compose those and the author's own thread has no delivery path whatsoever.
// The mutation response is the only carrier left, which is why these gates are
// about the value being RETURNED and APPLIED, not about the request being made.
//
// These are source-shape gates because the failure is structural: a handler
// that sends the right request and forgets the answer renders perfectly in
// review and behaves as if the write never happened.
//
// Run: node scripts/check-dm-mutation-state.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// Comments quote the offending expressions verbatim while explaining why they
// went, so a gate that failed on its own documentation would be deleted rather
// than obeyed.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const dmsApi = stripComments(read('../src/api/dms.js'));
const thread = stripComments(read('../src/components/dm/DirectMessages.jsx'));
const signals = stripComments(read('../src/api/realtime-signals.js'));
const sharedPollCode = stripComments(read('../src/api/shared-poll.js'));
const peerCardGo = stripComments(read('../backend/internal/platform/pocketbase/user_profile.go'));
const runGo = read('../backend/internal/platform/pocketbase/run.go');

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ── One normalizer, used by every read AND every mutation ─────────────────
//
// The wire shape is `sender_id`/`created`; the thread renders `sender_uid`/
// `timestamp`. That translation was open-coded at each read site, so the
// mutation paths returned something the thread could not drop into its own
// state — an applied row would have rendered as somebody else's message.
check(/const normalizeDmMessage\s*=/.test(dmsApi),
  'dms.js must keep ONE message normalizer — a row shaped differently at the ' +
  'mutation site is a row the thread cannot merge by id');

// Definition + fetchOlderDmMessages + the poll fetch + edit + delete. Counted by
// identifier, not by a call paren: the two read sites pass it to `.map`, which
// is a reference and not a call.
const normalizerUses = (dmsApi.match(/normalizeDmMessage/g) || []).length;
check(normalizerUses >= 5,
  `every DM message read and mutation must go through normalizeDmMessage — found ` +
  `${normalizerUses} mentions, want at least 5 (definition, older page, poll, edit, delete)`);

// Both READ sites must go through it too, or a message fetched from the list and
// the same message returned by an edit have two different shapes and merge into
// something neither renderer understands.
const mappedReads = (dmsApi.match(/\.map\(normalizeDmMessage\)/g) || []).length;
check(mappedReads >= 2,
  `the newer-page read and the thread poll must both map through normalizeDmMessage — ` +
  `found ${mappedReads}`);

// ── The mutations must RETURN the row they wrote ──────────────────────────
for (const fn of ['editDmMessage', 'deleteDmMessage']) {
  const body = dmsApi.match(

    new RegExp(`export const ${fn} = async[\\s\\S]*?\\n};`)
  );
  check(!!body, `dms.js must still export ${fn}`);
  if (!body) continue;

  const code = body[0];
  check(/res\?\.message/.test(code),
    `${fn} must return the row the server sent (res.message) — returning the bare ` +
    'acknowledgement leaves the client with nothing to apply, which is the reported bug');
  check(/normalizeDmMessage\(res\.message\)/.test(code),
    `${fn} must normalize the returned row, or the thread gets a message with no ` +
    'sender_uid and no timestamp');
}
// ── The thread must APPLY it ──────────────────────────────────────────────
// The handlers, not the API layer: an applied row that never reaches state is
// the same defect one call up.
const handlers = ['handleSaveDmEdit', 'handleDeleteDm'];
for (const fn of handlers) {
  const body = thread.match(new RegExp(`const ${fn} = async[\\s\\S]*?\\n  \\};`));
  check(!!body, `DirectMessages must still define ${fn}`);
  if (!body) continue;

  const code = body[0];
  const call = fn === 'handleSaveDmEdit' ? 'editDmMessage' : 'deleteDmMessage';
  check(new RegExp(`=\\s*await\\s+${call}\\(`).test(code),
    `${fn} must capture the result of ${call} — an awaited-and-discarded response ` +
    'is a write with no visible outcome');
  check(/applyMessageUpdate\(/.test(code),
    `${fn} must push the server's row into thread state; showing a success toast ` +
    'over an unchanged bubble is the exact shape of this bug');
  check(/refreshDmMessages\(/.test(code),
    `${fn} must nudge the thread read, so the sidebar preview and counters settle ` +
    'now instead of on some later tick');
}

// applyMessageUpdate must REPLACE the row, not spread over it.
//
// A tombstone arrives with no `text` key at all. `{...m, ...updated}` keeps the
// withdrawn words, which is a soft delete that leaks exactly what it removed.
const applyBody = thread.match(/const applyMessageUpdate = [\s\S]*?\n  \};/);
check(!!applyBody, 'DirectMessages must keep applyMessageUpdate');
if (applyBody) {
  check(/\? updated :/.test(applyBody[0]) || /:\s*updated/.test(applyBody[0]),
    'applyMessageUpdate must REPLACE the matched row rather than merge into it — a ' +
    'tombstone has no text key, so a merge silently keeps the deleted words');
}

// ── No Firestore date accessors left in the thread ────────────────────────
// `lastTimestamp` and `timestamp` are PocketBase strings ("2026-09-11 04:32:07.134Z").
// Calling .toMillis() on one throws during render and unmounts the page, which is
// what clearing a conversation did.
const threadDates = thread.replace(
  /typeof value\.toMillis === 'function'[\s\S]*?return value\.toMillis\(\);/,
  ''
);
check(!/\.to(?:Millis|Date)\s*\(/.test(threadDates),
  'DirectMessages must not call .toMillis()/.toDate() on PocketBase datetime strings — ' +
  'it is the Firestore accessor and throws during render');

// ── The thread must not read a member's whole profile ────────────────────
//
// REPORTED: "the handler that brings EVERYTHING about a user, including their
// settings, still loads" on a DM thread.
//
// Two effects here read the SAME peer: the chat header and the composer lock.
// Both went through subscribeToUser, which is the profile PAGE — and the
// response carried `settings` even though the DTO narrows it for a non-owner.
// Two heavy reads of one account to render a nickname and one boolean.
check(!/subscribeToUser/.test(thread),
  'DirectMessages must not read the profile page for a conversation — use ' +
  'subscribeToPeerCard, which is nickname/avatar/status and nothing else');

check(!/subscribeToUser/.test(dmsApi),
  'dms.js must not reach for the profile route; the peer endpoint is its own');

check(/\/api\/aerun\/peers\/\$\{/.test(dmsApi),
  'the peer read must be served by /api/aerun/peers/{id}');

// The lock reads `status`. It used to read `role_id`, which is a different
// column and never holds "banned" — so the lock silently never engaged.
check(!/role_id\s*===\s*'banned'/.test(thread),
  "the composer lock must test `status === 'banned'`, not the role column — " +
  'banned is an account status, so the role check never matched and the ' +
  'composer stayed unlocked');

// The backend endpoint must stay a WHITELIST. This is the half a client-only
// gate cannot see: the payload is assembled server-side, and the test that would
// catch a field creeping back is TestPeerCardCarriesNoProfilePayload.
const peerHandler = peerCardGo.match(/func getPeerCardHandler[\s\S]*?\n}/);
check(!!peerHandler, 'the peer card handler must exist');
if (peerHandler) {
  for (const forbidden of ['"settings"', '"bio"', '"birthday"', '"contacts"',
    '"posts_count"', '"reputation"', '"created_at"', '"role"']) {
    check(!peerHandler[0].includes(forbidden),
      `getPeerCardHandler must not serve ${forbidden} — the DM thread renders no such field`);
  }
  check(/group\.GET\("\/peers\/\{id\}", getPeerCardHandler\)/.test(runGo),
    'GET /peers/{id} must be registered, or the client call 404s');
}

// ── Realtime health must be CONNECTION, not delivery ─────────────────────
//
// REPORTED: "realtime keeps dying" on an open conversation.
//
// The health check waited for a signal to ARRIVE, so a thread nobody was typing
// in — which emits nothing for minutes — was declared broken after the grace
// window and pushed onto the poll interval permanently, with the stream open the
// whole time. The connection has to be what marks it healthy.
check(/onStateChange/.test(signals),
  'realtime-signals must report connection state; a silent-but-open stream is ' +
  'healthy, and requiring a delivered event is what killed realtime');
check(/isConnected/.test(signals),
  'realtime-signals must sample the SDK connection getter — it emits no ' +
  'disconnect event, so a drop is otherwise invisible');
check(/onConnected/.test(sharedPollCode),
  'shared-poll must trust the connection to stop the interval, or every quiet ' +
  'resource falls back to polling and stays there');
check(!/means DELIVERED, never connected/.test(sharedPollCode),
  'the delivery-based health contract is gone; leaving its rationale in place ' +
  'would invite the regression back');

// Every realtime call site must forward the state callback, or the resource
// silently keeps the old first-event rule.
//
// Counted on the FORWARDING line (a bare `onStateChange,` argument), not on
// every mention: the arrow parameter `onStateChange` appears on the same line
// as the call itself, so a naive mention-count reports one more than there are
// sites and can never match.
const signalCallSites = (dmsApi.match(/subscribeToRealtimeSignals\(/g) || []).length;
const stateForwarded = (dmsApi.match(/^\s*onStateChange,\s*$/gm) || []).length;
check(signalCallSites === stateForwarded,
  `every subscribeToRealtimeSignals call must forward onStateChange — found ` +
  `${stateForwarded} forwarded at ${signalCallSites} call sites`);

if (failures.length > 0) {
  console.error(`DM mutation-state regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  dms: edit/delete return the row they wrote');
console.log('OK  dms: the thread applies it and converges the read');
console.log('OK  dms: no Firestore date accessors on PocketBase datetimes');
console.log('OK  dms: a conversation reads a peer card, never the profile page');
console.log('OK  realtime: health is the connection, so a quiet thread stays live');
