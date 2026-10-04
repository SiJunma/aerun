// The unread floor must actually floor.
//
// WHY THIS EXISTS. Five call sites floor the unread count at the account's
// registration date, and each had its own copy of that parse. Three of them did
// it this way:
//
//   profile?.created_at?.toMillis?.() || 0
//
// The profile DTO sends `created_at` as a bare "2026-04-17" day string, so
// `?.toMillis?.()` does not throw — it returns undefined, and the whole
// expression collapses to 0. Nothing crashes and nothing logs: the floor becomes
// the epoch, so a brand-new account is shown every topic ever posted as unread
// and the screen looks exactly as though the feature were working.
//
// `scripts/check-date-accessors.mjs` cannot catch this, by construction. Its
// pattern is `?.toMillis(` — a CALL — because its severity is "on a string this
// throws and unmounts the page". This defect is `?.toMillis?.(`, an OPTIONAL
// call, which is type-safe and therefore never reaches that severity. Safe and
// wrong is a different failure mode and needs its own gate.
//
// Run: node scripts/check-unread-floor.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Comments quote the offending expression verbatim to explain why it went, so
// every pattern below runs against code with comments stripped. A gate that fires
// on its own documentation gets deleted rather than obeyed.
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// Imported at module scope, not per block: more than one block below needs it,
// and a block-scoped import would have failed as "toMillis is not defined" —
// which is exactly how this gate failed the first time it ran.
const { toMillis, unreadFloor } = await import('../src/utils/dates.js');

// ── 1. The helper, executed against every shape that reaches it ─────────────
//
// A normaliser written against only the shape it was authored for returns 0 in
// production, which is the very failure being fixed. So this block runs the real
// function rather than reading it.
{
  // Imported rather than re-derived by regex: a gate that slices the source out
  // with a pattern tests its own pattern, and fails on CRLF/LF rather than on
  // the defect. This runs the module the app actually imports.
  assert.equal(typeof toMillis, 'function', 'toMillis must be exported from src/utils/dates.js');

  const DAY = '2026-04-17';
  const dayMs = Date.parse(DAY);

  assert.equal(toMillis(DAY), dayMs, 'the day-only registration date must parse to its midnight');
  assert.equal(toMillis('2026-04-17 22:45:57.744Z'), Date.parse('2026-04-17 22:45:57.744Z'),
    'a PocketBase datetime carries a space where ISO 8601 wants "T"');
  assert.equal(toMillis({ toMillis: () => 42 }), 42, 'a Firestore Timestamp must survive');
  assert.equal(toMillis({ toDate: () => new Date(DAY) }), dayMs, 'a toDate() shape must survive');
  assert.equal(toMillis({ seconds: 1776384000, nanoseconds: 500000000 }), 1776384000500,
    'a serialised Timestamp cache must survive');
  assert.equal(toMillis(new Date(DAY)), dayMs, 'a Date must survive');
  assert.equal(toMillis(1776384000000), 1776384000000, 'epoch ms must pass through');

  // 0, never NaN: these values feed Math.max and `<`, and a NaN poisons every
  // comparison it touches, which turns a broken value into a broken sort order.
  for (const [label, value] of [['null', null], ['undefined', undefined], ['empty', ''],
    ['garbage', 'not-a-date'], ['bare object', {}], ['NaN', NaN]]) {
    assert.equal(toMillis(value), 0, `${label} must normalise to 0, never NaN`);
  }

  // THE REGRESSION, stated as an executable fact rather than a comment: this is
  // the exact expression the call sites used, and the exact value it produced.
  assert.equal(DAY?.toMillis?.() || 0, 0,
    'the old read is asserted broken here; if this ever starts passing, delete this gate');
  assert.equal(toMillis(DAY), dayMs, 'the replacement must return the day, not 0');
}
console.log('OK  unread floor: a day-only registration date parses to its midnight');

// ── 2. The floor is the LATER of the two instants ───────────────────────────
//
// The semantics, not just the parse: a member must never be shown unread for
// topics that predate their account, and a real visit must always move the floor
// forward.
//
// Imported, not re-derived by regex: unreadFloor is defined in terms of
// toMillis, so evaluating it in isolation would need the helper injected as well
// as this one, and a stubbed dependency would test the stub.
{
  assert.equal(typeof unreadFloor, 'function', 'unreadFloor must be exported from src/utils/dates.js');
  const DAY = '2026-04-17';
  const before = new Date('2026-01-01T00:00:00Z').getTime();
  const after = new Date('2026-06-01T00:00:00Z').getTime();

  // No read state at all: the registration day alone decides.
  assert.equal(before > unreadFloor(0, DAY), false,
    'a topic older than the account must not count as unread for a member with no read state');
  assert.equal(after > unreadFloor(0, DAY), true,
    'a topic newer than the account must count as unread');

  // A real visit wins over registration, which is what the Math.max was for.
  assert.equal(unreadFloor(after, DAY), after, 'a later visit must move the floor forward');
  assert.equal(unreadFloor(before, DAY), Date.parse(DAY),
    'a visit older than registration must not drag the floor back');

  // The day floors at its START, never its end. Rounding up would swallow every
  // topic posted on the signup day itself — the direction that hides unread.
  assert.equal(unreadFloor(0, DAY), Date.parse(DAY),
    'registration must floor at midnight, not noon or 23:59');
}
console.log('OK  unread floor: registration and last-visit take the later of the two');

// ── 1b. The PocketBase space form must not reach a parser raw ───────────────
//
// "2026-10-04 16:50:00.000Z" — a SPACE where ISO 8601 requires "T". Not a format
// the spec makes a parser accept. V8 honours the trailing Z anyway, so this hides
// in Chrome; an engine that ignores it reads the wall clock as LOCAL and shifts
// the instant by the whole UTC offset, which lands a live heartbeat (~now) in the
// FUTURE. Measured at 4 hours in this project.
{
  const nowIso = new Date().toISOString();
  const spaceForm = nowIso.replace('T', ' ');
  const zone = -new Date().getTimezoneOffset() / 60;

  const parsed = toMillis(spaceForm);
  assert.ok(Number.isFinite(parsed), `the space form must parse, got ${parsed}`);

  // The instant must be the UTC one. Compared against the explicitly-ISO twin
  // rather than against "now", so the check holds at any minute of the day.
  assert.equal(
    parsed,
    Date.parse(nowIso),
    'the PocketBase space form must resolve to the same UTC instant as its ISO twin'
  );

  // And the failure it replaces, stated as an executable fact: reading the same
  // string as local time is what pushed last-seen into the future.
  const asLocal = new Date(spaceForm.slice(0, 19)).getTime();
  if (Number.isFinite(asLocal) && zone !== 0) {
    assert.notEqual(
      parsed,
      asLocal,
      'if the space form and the local-time reading now agree, this browser no longer ' +
        'reproduces the future-timestamp bug and the gate should be revisited'
    );
  }
}
console.log('OK  dates: the PocketBase space form resolves to UTC, not local');

// ── 3. No call site may reintroduce the broken read ──────────────────────────
{
  const SITES = [
    'src/components/common/TopicRow.jsx',
    'src/pages/MainPage.jsx',
    'src/pages/NewRepliesPage.jsx',
    'src/pages/TopicPage.jsx'
  ];

  for (const site of SITES) {
    const raw = read(site);
    const code = codeOf(raw);

    // The `\.` before `(` is load-bearing: the defect is an OPTIONAL CALL, spelled
    // `?.toMillis?.(`, and a pattern written as `?.toMillis?.(` — without the dot —
    // matches nothing at all. That gate would have sat in CI passing for months
    // while the defect it names was reintroduced, which is worse than no gate.
    assert.doesNotMatch(
      code,
      /created_at\?\.\s*toMillis\s*\?\s*\.\s*\(/,
      `${site} reads the registration date through \`?.toMillis?.()\`, which yields undefined on ` +
        'the day string the profile DTO sends and floors the whole unread count at the epoch. Use ' +
        'toMillis()/unreadFloor() from src/utils/dates.js'
    );

    assert.doesNotMatch(
      code,
      /Math\.max\(\s*lastVisitMs/,
      `${site} floors unread with a hand-rolled Math.max — the two operands arrive in different ` +
        'shapes from different sources, which is how the parse diverged in the first place'
    );

    // A site that calls the helper must import it. Without this the build fails
    // on an undefined identifier, which is loud rather than silent — but it is
    // still a broken commit, and the gate should catch it before the build does.
    //
    // The path is matched by its TAIL rather than by counting "../": TopicRow
    // lives two levels deep (components/common/) while the pages live one
    // (pages/), so an anchored count would have pinned the wrong file and passed
    // on a genuinely missing import.
    if (/unreadFloor\(/.test(code)) {
      assert.match(
        raw,
        /from\s+'(\.\.\/)+utils\/dates'/,
        `${site} calls unreadFloor but does not import it from src/utils/dates.js`
      );
    }
  }
}
console.log('OK  unread floor: no call site reads the registration date through a Firestore accessor');