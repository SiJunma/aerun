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
const markReadGo = stripComments(read('../backend/internal/platform/pocketbase/dms.go'));
const forumApi = stripComments(read('../src/api/forum.js'));

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
check(normalizerUses >= 6,
  `every DM message read and mutation must go through normalizeDmMessage — found ` +
  `${normalizerUses} mentions, want at least 6 (definition, older page, poll, send, edit, delete)`);

// Both READ sites must go through it too, or a message fetched from the list and
// the same message returned by an edit have two different shapes and merge into
// something neither renderer understands.
const mappedReads = (dmsApi.match(/\.map\(normalizeDmMessage\)/g) || []).length;
check(mappedReads >= 2,
  `the newer-page read and the thread poll must both map through normalizeDmMessage — ` +
  `found ${mappedReads}`);

// ── The mutations must RETURN the row they wrote ──────────────────────────
// Sending joins this list for the same reason edit and delete did, with one
// extra sting: a send is the COMMON case, and its author has no delivery path
// either — publishDMSignalToPeers addresses the other participants only, and
// shared-poll drops the fallback timer the moment realtime connects. The
// reported "I pressed send and nothing appeared until I reloaded" was this
// loop's missing third entry.
for (const fn of ['sendDmMessage', 'editDmMessage', 'deleteDmMessage']) {
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

// ── Sending has the SAME contract, plus the inbox ─────────────────────────
//
// REPORTED: "I pressed send — nothing appeared in the thread. I went back to
// the list — the conversation was not there either. Only a reload brought
// both back. And it does this in EVERY conversation."
//
// The thread half is the edit/delete defect one call up. The inbox half is
// send-specific: for a conversation that was CLEARED, the server's own list
// filter (`last_message_at > cleared_at`) keeps the row invisible until the
// new message moves the timestamp — and only a list READ can observe that, so
// without the refresh the member's own resumed thread stays off the screen.
{
  const body = thread.match(/const handleSend = async[\s\S]*?\n  \};/);
  check(!!body, 'DirectMessages must still define handleSend');
  if (body) {
    const code = body[0];
    check(/=\s*await\s+sendDmMessage\(/.test(code),
      'handleSend must capture the result of sendDmMessage — an awaited-and-discarded ' +
      'response is a write with no visible outcome');
    check(/setMessages\(/.test(code),
      'handleSend must push the sent row into thread state; the author receives no ' +
      'signal for their own message, so nothing else will ever paint the bubble');
    check(/refreshDmMessages\(/.test(code),
      'handleSend must nudge the thread read, so the preview and counters settle now');
    check(/refreshDmList\(/.test(code),
      'handleSend must nudge the inbox read — a cleared-then-resumed conversation ' +
      'is excluded by the server list filter until this read observes the new message');
    // ── Draft first-send branch (S3) ─────────────────────────────────────────
    check(/isDraftId\(activeChatId\)/.test(code),
      'handleSend must branch on isDraftId(activeChatId) — opening a draft writes ' +
      'nothing, the first real message is the only write');
    check(/startConversationWithMessage\(/.test(code),
      'handleSend must use startConversationWithMessage for the draft first-send — ' +
      'the real conversation is created together with the first real message');
    check(/clearComposerText\(/.test(code),
      'handleSend must clear the composer text only on success — a failed send ' +
      'must leave the typed words in place');
    check(/removeDraft\(/.test(code),
      'handleSend must prune the draft when the thread becomes real — a draft ' +
      'must not linger beside its real conversation');
  }
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

// ── ONE date parser, not a second copy ─────────────────────────────────────
//
// REPORTED: "a newly created draft sank to the BOTTOM of the dialogue list,
// although fresh/new dialogues must be on top".
//
// The inbox sorts by ONE freshness key: a real conversation by its
// `last_message_at`, a draft by its `createdAt`. The draft store keeps
// `createdAt: Date.now()` — a NUMBER of milliseconds — and the thread used to
// parse it with its OWN copy of the date reader, which only understood date
// SHAPES: `new Date(String(1750000000000))` is not a date, it parses as
// Invalid Date, and the key collapsed to 0. Every real conversation parses to
// ~1.7e12, so the descending sort put every draft BELOW all of them.
//
// The fix is not another arm in a local parser — it is to use the ONE parser
// the project already has (src/utils/dates.js), which knows the number shape
// because the rest of the forum stores optimistic stamps as numbers too.
// A fifth local copy is how this defect came back.
check(/from '\.\.\/\.\.\/utils\/dates'/.test(thread),
  'DirectMessages must parse dates through the shared src/utils/dates.js helper — ' +
  'a local copy is what made every draft sort to the bottom of the inbox');

check(!/const toMillis = \(value\) => \{[\s\S]*?new Date\(String\(value\)/.test(thread),
  'DirectMessages must not carry its own date parser — the number shape ' +
  '(Date.now()) must be handled by the shared helper, or drafts sort to the bottom');

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

// ── A vanished peer must still be OPENABLE ──────────────────────────────────
//
// REPORTED: "I still cannot open my dialogue with a deleted user", with the
// console showing "[subscribeToPeerCard err] ApiError: User not found.".
//
// THE THREAD SURVIVES THE ACCOUNT. dm_members stores user_id as a plain TEXT
// id, not a RelationField, so a membership row outlives the users row it
// points at: the conversation, its history and its place in the inbox all
// remain. The account row is what is gone — hard-deleted, or removed by a
// binary older than the soft delete.
//
// The peer read then answers 404, and the thread used to STOP THERE: the
// chat-mode auto-open waits for a peer card, so a card that can never arrive
// meant the member clicked their own inbox row and got an empty screen. The
// composer lock was right (a gone account cannot be written to), but the THREAD
// must still be readable.
//
// So the peer read must answer a question about the ACCOUNT, and a 404 must be
// read as "the account is gone" — a state the thread draws with the
// "Deleted user" placeholder — not as "there is nothing to open".
check(/err\?\.status\s*!==\s*404/.test(thread),
  'a 404 from the peer read must be handled explicitly — it means the account ' +
  'is gone, and the thread must still open with the "Deleted user" placeholder');

// The chat-mode auto-open waits for a peer card. A vanished peer must produce
// ONE — an empty, deleted-marked card — or the chat never opens at all.
check(/setTargetProfile\(\{[\s\S]{0,300}?deleted:\s*true/.test(thread),
  'a 404 from the peer read must still produce a target profile — without it ' +
  'the chat-mode auto-open waits forever and the dialogue cannot be opened');

// And the header must name that peer the way every other surface does.
check(!/name:\s*targetProfile\?\.nickname\s*\|\|\s*'User'/.test(thread),
  'the chat header must not fall back to the nameless "User" — a vanished ' +
  'peer is drawn with the localized "Deleted user" placeholder');

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

// ── A migration ghost must be hidden, not shown as a nameless row ─────────
//
// REPORTED (M2): after migration a member saw an empty chat with a nameless
// "User", no avatar, that would not open. That shape is a migration ghost —
// the peer's dm_members row never imported, so the server resolves NO other
// member and flags it `peer_missing: true`. The owner's call was explicit:
// stop falling back to empty defaults, just don't show that junk.
//
// The inbox filter must drop peer_missing rows. A runtime-DELETED peer is a
// DIFFERENT shape (its membership row survives with an empty nickname), so it
// stays visible with the "Deleted user" placeholder — only the true ghost,
// where the server found no other member at all, is filtered out.
const visibleConvs = thread.match(/const visibleConversations = [\s\S]*?\n  \}\);/);
check(!!visibleConvs, 'DirectMessages must keep the visibleConversations inbox filter');
if (visibleConvs) {
  check(/peer_missing/.test(visibleConvs[0]),
    'visibleConversations must drop migration ghosts (peer_missing) — rendering one as a ' +
    'nameless "User" with a dead avatar that will not open is the exact junk bug M2 asked ' +
    'us to stop showing; a runtime-deleted peer (peer_missing=false) keeps its placeholder');

  // The backend must keep producing the flag the filter depends on.
  check(/"peer_missing":\s*len\(peers\)\s*==\s*0/.test(markReadGo),
    'the list handler must still flag peer_missing = len(peers) == 0 — without it the ' +
    'frontend filter has nothing to key on and the ghost rows come back');
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

// ── Mark-read must settle the badge, not just the row ───────────────
//
// REPORTED: "messages are on screen, the badge stays". The thread POSTed
// /dms/{id}/read and the server row moved — but the navbar/tab badge kept
// the last POLLED value: the unread-counts poll has no timer while realtime
// is connected, and no signal was published for a read. Both halves are
// pinned: the client refreshes the counters off the committed read, and the
// server wakes the reader's own counters with a dm.read nudge.
//
// The topic is dm.read, NOT dm.post: both carry a conversation id, so reusing
// the post topic would wake the thread as if a message had arrived. Every DM
// resource re-reads on any signal anyway; only topic-stats filters DM topics
// out (forum.js guards both — see below).
const markReadBody = dmsApi.match(
  /export const markDmRead = async[\s\S]*?\n};/
);
check(!!markReadBody, 'dms.js must still export markDmRead');
if (markReadBody) {
  check(/refreshUnreadCounts\(/.test(markReadBody[0]),
    'markDmRead must refresh the unread counters after the POST — a committed ' +
    'read with no re-read leaves the badge on the last polled value');
  check(/refreshDmList\(/.test(markReadBody[0]),
    'markDmRead must refresh the inbox read — its preview carries per-row ' +
    'unread state that also goes stale');
}

// The read receipt rides its own topic. A mark-read that publishes dm.post
// wakes the thread as if a message arrived; a mark-read that publishes nothing
// leaves the badge on the last polled value while realtime is connected.
const readHandler = markReadGo.match(
  /func markConversationReadHandler[\s\S]*?\n}/
);
check(!!readHandler, 'the mark-read handler must exist');
if (readHandler) {
  check(/realtimeSignalDMRead/.test(readHandler[0]),
    'markConversationReadHandler must publish the dedicated dm.read topic — ' +
    'reusing dm.post wakes the thread as if a message arrived');
  check(!/realtimeSignalDMPost/.test(readHandler[0]),
    'markConversationReadHandler must NOT publish dm.post — that topic means ' +
    '"a message arrived", and a read is not one');
}

// topic-stats is the one resource that filters DM topics: a read receipt
// changes no topic, so without the guard every mark-read would trigger a
// useless stats re-read.
check(/signalTopic === 'dm\.read'/.test(forumApi),
  'forum.js topic-stats must discard the dm.read topic — a read receipt moves ' +
  'no topic, and the re-read it would trigger is pure waste');
check(/signalTopic === 'dm\.post'/.test(forumApi),
  'forum.js topic-stats must keep discarding dm.post — the two DM topics live ' +
  'and die together');

if (failures.length > 0) {
  console.error(`DM mutation-state regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  dms: send/edit/delete return the row they wrote');
console.log('OK  dms: the thread applies it and converges the read');
console.log('OK  dms: a send also converges the inbox read');
console.log('OK  dms: a read also converges the badge, not just the row');
console.log('OK  dms: no Firestore date accessors on PocketBase datetimes');
console.log('OK  dms: a conversation reads a peer card, never the profile page');
console.log('OK  dms: a migration ghost (peer_missing) is hidden, not drawn as junk');
console.log('OK  realtime: health is the connection, so a quiet thread stays live');
