// Regression test for the three profile-page symptoms reported after the
// backend migration:
//
//   1. the role badge showed the system "Player" instead of a custom role;
//   2. opening Settings on your OWN profile pre-filled an empty bio even though
//      the migrated database held the value;
//   3. the posts and reputation tabs rendered nothing.
//
// All three were one root cause plus one sibling bug. The pages read the
// Firestore vocabulary (`post_count`, `uid`) while PocketBase spells the same
// facts `posts_count` and `id`, and two independent mappers read different
// fields: subscribeToUser spread the RAW record (so every `uid` read was
// undefined and resolveUserRole(undefined) falls back to 'player'), while
// AuthProvider built the profile from a hand-written whitelist that listed
// neither the profile block nor the real counter names. The role axis no longer
// has a legacy alias at all: user rows speak the server column `role` end to
// end, and a reader asking for `role_id` on a user row reads a field that does
// not exist. Separately, both list
// APIs return `total` and the page read `totalCount`, i.e. undefined.
//
// Run: node scripts/check-user-profile-normalization.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const api = fs.readFileSync(new URL('../src/api/auth-resources.js', import.meta.url), 'utf8');
const provider = fs.readFileSync(new URL('../src/contexts/AuthProvider.jsx', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../src/pages/ProfilePage.jsx', import.meta.url), 'utf8');
const badge = fs.readFileSync(new URL('../src/components/common/ForumRoleBadge.jsx', import.meta.url), 'utf8');

// ── Exercise the real normalizer ─────────────────────────────────────────────
const m = api.match(/export const normalizeUserProfile = \(rec\) => \{([\s\S]*?)\r?\n\};/);
assert.ok(m, 'normalizeUserProfile must exist in api/auth-resources.js');

// recordAvatarUrl/resolveAvatarUrl are browser-module deps; stub them so the
// body under test runs unmodified.
const normalizeUserProfile = new Function(
  'recordAvatarUrl', 'resolveAvatarUrl',
  `return (rec) => {${m[1]}\n};`
)(
  (rec) => (rec.avatar ? `/api/files/users/${rec.id}/${rec.avatar}` : ''),
  (v) => v || ''
);
{
  // A migrated row as PocketBase actually returns it: the join key is `role`,
  // the counter is `posts_count`, and there is no `uid` alias at all.
  const row = {
    id: 'u1',
    nickname: 'Arin',
    email: 'arin@example.com',
    role: 'veteran',
    status: 'active',
    posts_count: 1201,
    topics_count: 42,
    reputation: 219,
    bio: 'Предик',
    location: 'Moscow',
    birthday: '1990-01-01',
    occupation: 'Пилот',
    interests: 'Мехи',
    contacts: '@arin',
    status_line: 'Не спит',
    settings: { theme: 'dark' }
  };
  const p = normalizeUserProfile(row);

  // 1. The custom role must survive, not collapse to the 'player' fallback.
  assert.equal(p.role, 'veteran', 'role must come from the users.role column');
  assert.notEqual(p.role, 'player', 'a custom role must not read back as Player');
  assert.ok(!('role_id' in p), 'the legacy role_id alias must be gone from the row');

  // The counter is posts_count on this backend.
  assert.equal(p.post_count, 1201, 'post_count must come from posts_count');
  assert.equal(p.reputation, 219, 'reputation must survive normalisation');

  // 2. The profile block must reach the Settings form.
  for (const field of ['bio', 'location', 'birthday', 'occupation', 'interests', 'contacts', 'status_line']) {
    assert.equal(p[field], row[field], `${field} must survive normalisation`);
  }

  // `uid` is the key the form-init guard compares against.
  assert.equal(p.uid, 'u1', 'uid must be populated from the record id');
}

// A row written before the rename still renders (the ?? chains fall back).
{
  const p = normalizeUserProfile({ id: 'u2', role: 'moderator', post_count: 7 });
  assert.equal(p.role, 'moderator', 'the server role column must resolve');
  assert.equal(p.post_count, 7, 'a legacy post_count must still resolve');
}

// A record with nothing set must not produce undefined where a number is read.
// ── Both mappers must go through it ──────────────────────────────────────────
// The whole point is that there is ONE mapper; a second hand-written whitelist
// is how the two drifted apart in the first place.
{
  assert.ok(
    !/const p = \{\s*id: rec\.id,[\s\S]*?nickname: rec\.nickname/.test(provider),
    'AuthProvider must not re-hand-roll the profile object'
  );
  assert.match(
    provider,
    /normalizeUserProfile\(\{ \.\.\.rec \}\)/,
    'AuthProvider must build the profile through normalizeUserProfile'
  );
  // ONE normaliser call site in auth-resources, because there is now ONE read.
  //
  // This used to be `length === 2` — the initial read plus the realtime event.
  // The realtime subscription is gone: `RealtimeRule` is unset on every
  // collection, so it completed the SSE handshake and delivered nothing while an
  // event would have carried the whole auth record. Counting two call sites was
  // therefore asserting that a dead channel stayed dead-but-present.
  const subs = api.match(/normalizeUserProfile\(\{ \.\.\.(record|e\.record) \}\)/g) || [];
  assert.equal(
    subs.length,
    1,
    'auth-resources must normalise exactly once — a second call site means a reader ' +
      'was added that does not go through the public profile DTO'
  );
  // Matched against CODE, not source. auth-resources.js explains at length why
  // the collection read is gone, and it names the call verbatim while doing so —
  // a gate that fires on its own documentation gets deleted rather than obeyed.
  const withoutComments = api
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(
    withoutComments,
    /pb\.collection\(['"]users['"]\)/,
    'accounts must come from /api/aerun/users/{id}, never from the collection'
  );
}

// ── 3. The list APIs and the page must agree on the total's name ─────────────
//
// The invariant is that fetchUserPosts still RETURNS a `total` the page can
// read — not which SDK field it reads it from. The source moved from the
// PocketBase SDK (`list.totalItems`, which answered 403 for every non-superuser
// because the forum collections are locked) to the command layer (`res?.total`),
// so the literal below follows the move. ProfilePage reading `result.total`
// rather than `totalCount` is the part that was actually broken before.
{
  const forum = fs.readFileSync(new URL('../src/api/forum.js', import.meta.url), 'utf8');
  const rep = fs.readFileSync(new URL('../src/api/reputation.js', import.meta.url), 'utf8');
  assert.match(forum, /total:\s*res\?\.total/, 'fetchUserPosts must return `total`');
  assert.match(rep, /total:\s*res\?\.total/, 'fetchReputationLogs must return `total`');
  assert.ok(
    !/result\.totalCount/.test(page),
    'the page must not read totalCount from an API that names it total'
  );
  // The posts tab used to read the posts collection straight from the browser
  // SDK, which lockBrowserRules answers with 403 "Only superusers can perform
  // this action" — so the tab rendered empty for every member and every guest,
  // and the catch turned that refusal into "this person has written nothing".
  // The commented-out literal below the gate is DELIBERATE: a gate that matched
  // its own documentation would have to be deleted rather than obeyed.
  assert.ok(
    !/pb\.collection\('posts'\)\.getList/.test(forum),
    'fetchUserPosts must not read the posts collection through the browser SDK — those rules are ' +
      'locked to superusers, so the profile tab answered 403 and rendered as empty'
  );
  assert.match(
    forum,
    /\/api\/aerun\/users\/\$\{targetUid\}\/posts/,
    'fetchUserPosts must read the profile posts through the command layer'
  );
}

// ── The Posts filter has to reach the server ─────────────────────────────────
//
// Reported: the dropdown (All messages / Account only / one per mask) changed
// nothing. Both halves were missing it independently, and neither had a test, so
// nothing failed.
//
//  · fetchUserPosts declared the parameter as `_postFilter` — the underscore is
//    the codebase's own convention for "accepted and deliberately unused" — and
//    never put it on the wire, so the server could not have honoured it.
//  · listUserPostsHandler had no `filter` parameter to read at all.
//
// The literal below is the CONTRACT between the two: the client must send the
// value, and the handler must read the same key. Asserting one without the other
// is what let the pair drift apart while both halves compiled.
{
  const forum = fs.readFileSync(new URL('../src/api/forum.js', import.meta.url), 'utf8');
  const userPostsGo = fs.readFileSync(
    new URL('../backend/internal/platform/pocketbase/user_posts.go', import.meta.url), 'utf8'
  );

  assert.ok(
    // Scoped to the SIGNATURE, not the whole file: a check that matched its own
    // explanatory comment would have to be deleted rather than obeyed, which is
    // how a guard quietly stops being one.
    !/fetchUserPosts\s*=\s*async\s*\([^)]*_postFilter/.test(forum),
    'fetchUserPosts must not declare the filter as `_postFilter` — the underscore means ' +
      'deliberately unused, which is exactly how the Posts filter stopped working while every ' +
      'dropdown item still looked selectable'
  );
  assert.match(
    forum,
    /filter=\$\{encodeURIComponent\(postFilter\)\}/,
    'fetchUserPosts must send the filter as a query parameter — the endpoint is paginated, so ' +
      'filtering the returned rows in the browser would page against an unfiltered total'
  );
  assert.match(
    userPostsGo,
    /Query\(\)\.Get\("filter"\)/,
    'the profile posts endpoint must read a `filter` parameter, or the client has nothing to ' +
      'filter on and every dropdown entry answers with the whole list'
  );
  // The pager divides by `total`, so a count built from a different expression than
  // the page query offers pages that do not exist. Both must come from one scope.
  assert.match(
    userPostsGo,
    /CountRecords\(postsCollectionName, scope\.\.\.\)/,
    'the post count must reuse the filtered scope — a separate count paginates the filter ' +
      'against every post the account ever wrote'
  );
}

// ── A post card needs a headline and a themed mask badge ─────────────────────
//
// Two reported defects on the profile Posts tab, both of which look cosmetic
// in a screenshot and are contract bugs underneath:
//
//  1. Every row rendered "..." instead of the topic title. ProfilePage falls
//     back to that literal when `topic_title` is absent, so the key has to be
//     on the payload — a working link next to an ellipsis is not a design, it is
//     a missing field.
//  2. The mask badge came out stock Bootstrap blue in EVERY theme. The theme
//     rules are all scoped to `.role-badge.badge-character`, so a bare
//     `badge-character` matches nothing and falls back to the library default.
//     The component carries the `role-badge` class itself, so using the
//     component is the fix; re-adding a hand-rolled <Badge> would reintroduce
//     the bug with no compiler to stop it.
{
  const userPostsGo = fs.readFileSync(
    new URL('../backend/internal/platform/pocketbase/user_posts.go', import.meta.url), 'utf8'
  );
  const characterBadge = fs.readFileSync(
    new URL('../src/components/common/ForumCharacterBadge.jsx', import.meta.url), 'utf8'
  );

  assert.match(
    userPostsGo,
    /"topic_title"/,
    'the profile posts endpoint must send topic_title — ProfilePage renders it as the headline ' +
      'and falls back to "..." without it'
  );
  assert.match(
    userPostsGo,
    /loadTopicTitles/,
    'topic titles must be resolved in one batched lookup, not per post'
  );

  assert.match(
    characterBadge,
    /role-badge badge-character/,
    'ForumCharacterBadge must carry the role-badge class itself — the theme rules are scoped to ' +
      '.role-badge.badge-character, so a badge without it renders stock Bootstrap blue'
  );
  assert.ok(
    !/<Badge[^>]*badge-character/.test(page),
    'ProfilePage must use ForumCharacterBadge for a mask, not a hand-rolled Badge: a bare ' +
      '`badge-character` escapes the themed .role-badge.badge-character rules'
  );
}

// ── Status is its own axis ───────────────────────────────────────────────────
{
  assert.match(badge, /status,\r?\n\s*userEmail/, 'ForumRoleBadge must accept the status prop both pages pass');
  assert.match(badge, /effectiveStatus === 'banned'/, 'the banned badge must key off status');
  assert.match(badge, /effectiveStatus === 'pending'/, 'the pending badge must key off status');
  assert.ok(
    !/role_id?\s*===\s*'(pending|banned)'/.test(page),
    'the page must not test banned/pending against the role column'
  );
}

console.log('OK  user profile: role, counters, bio and totals all normalise');
{
  const p = normalizeUserProfile({ id: 'u3' });
  assert.equal(p.post_count, 0);
  assert.equal(p.reputation, 0);
  assert.equal(p.role, 'player', 'an unset role falls back to player');
  assert.ok(!('role_id' in p), 'an unset role must not resurrect the legacy alias');
  assert.deepEqual(p.settings, {}, 'settings must default to an object, not undefined');
}