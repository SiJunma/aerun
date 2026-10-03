// Regression test for the three profile-page symptoms reported after the
// backend migration:
//
//   1. the role badge showed the system "Player" instead of a custom role;
//   2. opening Settings on your OWN profile pre-filled an empty bio even though
//      the migrated database held the value;
//   3. the posts and reputation tabs rendered nothing.
//
// All three were one root cause plus one sibling bug. The pages read the
// Firestore vocabulary (`role_id`, `post_count`, `uid`) while PocketBase spells
// the same facts `role`, `posts_count` and `id`, and two independent mappers read
// different fields: subscribeToUser spread the RAW record (so every `role_id`
// read was undefined, and resolveUserRoleId(undefined) falls back to 'player'),
// while AuthProvider built the profile from a hand-written whitelist that listed
// neither the profile block nor the real counter names. Separately, both list
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
  // the counter is `posts_count`, and there is no `uid` or `role_id` at all.
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
  assert.equal(p.role_id, 'veteran', 'role_id must come from the users.role column');
  assert.notEqual(p.role_id, 'player', 'a custom role must not read back as Player');

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
  const p = normalizeUserProfile({ id: 'u2', role_id: 'moderator', post_count: 7 });
  assert.equal(p.role_id, 'moderator', 'a legacy role_id must still resolve');
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
  const subs = api.match(/normalizeUserProfile\(\{ \.\.\.(record|e\.record) \}\)/g) || [];
  assert.equal(subs.length, 2, 'both the initial read and the realtime event must normalise');
}

// ── 3. The list APIs and the page must agree on the total's name ─────────────
{
  const forum = fs.readFileSync(new URL('../src/api/forum.js', import.meta.url), 'utf8');
  const rep = fs.readFileSync(new URL('../src/api/reputation.js', import.meta.url), 'utf8');
  assert.match(forum, /total:\s*list\.totalItems/, 'fetchUserPosts must return `total`');
  assert.match(rep, /total:\s*res\?\.total/, 'fetchReputationLogs must return `total`');
  assert.ok(
    !/result\.totalCount/.test(page),
    'the page must not read totalCount from an API that names it total'
  );
}

// ── Status is its own axis ───────────────────────────────────────────────────
{
  assert.match(badge, /status,\r?\n\s*userEmail/, 'ForumRoleBadge must accept the status prop both pages pass');
  assert.match(badge, /effectiveStatus === 'banned'/, 'the banned badge must key off status');
  assert.match(badge, /effectiveStatus === 'pending'/, 'the pending badge must key off status');
  assert.ok(
    !/role_id === '(pending|banned)'/.test(page),
    'the page must not test banned/pending against the role column'
  );
}

console.log('OK  user profile: role, counters, bio and totals all normalise');
{
  const p = normalizeUserProfile({ id: 'u3' });
  assert.equal(p.post_count, 0);
  assert.equal(p.reputation, 0);
  assert.equal(p.role_id, 'player', 'an unset role falls back to player');
  assert.deepEqual(p.settings, {}, 'settings must default to an object, not undefined');
}