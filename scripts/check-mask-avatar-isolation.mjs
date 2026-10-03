// Regression test for "changing one mask's avatar repainted the other masks".
//
// Root cause: every mask uploaded to the SAME Storage object,
// `users/<uid>/characters/avatar`. Firebase does not rotate a download token
// when an object is overwritten — getDownloadURL() hands back the identical
// url before and after — so any mask whose document had already saved that
// url kept rendering it. Replacing one mask's picture therefore changed every
// mask that pointed at the shared object, and no amount of saving could undo
// it because the stored urls were literally the same string.
//
// Run: node scripts/check-mask-avatar-isolation.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/pages/ProfilePage.jsx', import.meta.url), 'utf8');

// ── Extract the real helpers so the shipped logic is what gets exercised ──────
const pathMatch = src.match(/const maskAvatarPath = \(ownerUid, slot\) =>\s*([\s\S]*?);\r?\n/);
assert.ok(pathMatch, 'maskAvatarPath helper must exist in ProfilePage.jsx');
const maskAvatarPath = new Function(
  'ownerUid', 'slot',
  `return (${pathMatch[1].trim()})`
);

const slotMatch = src.match(/const newAvatarSlot = \(\) =>\s*([\s\S]*?);\r?\n/);
assert.ok(slotMatch, 'newAvatarSlot helper must exist in ProfilePage.jsx');
const newAvatarSlot = new Function(
  'Date', 'Math',
  `return (${slotMatch[1].trim()})`
);

// A fixed clock/rng so "two unsaved masks get two slots" is deterministic.
const clock = () => ({ now: () => 1750000000000 });
let calls = 0;
const fakeMath = { random: () => (calls++ % 2 ? 0.11111111 : 0.22222222) };

// ── The bug itself: a shared, slot-less path ─────────────────────────────────
// Two saved masks are different documents, so their paths must differ. With
// the old constant path these were byte-identical, which is exactly the
// condition that made one upload repaint both.
{
  const a = maskAvatarPath('user1', 'maskA');
  const b = maskAvatarPath('user1', 'maskB');
  assert.notEqual(a, b, 'Two masks of one user must not share a Storage object');
  assert.match(a, /^users\/user1\/characters\//, 'Mask avatars live under the owner');
  assert.match(b, /^users\/user1\/characters\//, 'Mask avatars live under the owner');
}

// The account avatar is a different slot space and must stay untouched.
{
  assert.notEqual(
    maskAvatarPath('user1', 'maskA'),
    'users/user1/avatar',
    'A mask must not collide with the account avatar'
  );
}

// Users must not collide with each other either.
{
  assert.notEqual(
    maskAvatarPath('user1', 'maskA'),
    maskAvatarPath('user2', 'maskA'),
    'The same mask id under two users must not collide'
  );
}

// ── A saved mask keeps its own slot, so re-editing is stable ─────────────────
// Reopening a mask must reproduce the same path: otherwise every edit would
// orphan the previous object and the stored url would stop resolving to the
// file the user last uploaded.
{
  assert.equal(
    maskAvatarPath('user1', 'maskA'),
    maskAvatarPath('user1', 'maskA'),
    'Reopening a saved mask must resolve to the same object'
  );
}

// ── Two unsaved masks must not collide either ────────────────────────────────
// addDoc() mints the id at save time, so both masks are still 'draft' when
// the upload happens. A shared fallback slot (a literal 'new', as the code did
// before) would reproduce the original bug for freshly created masks.
{
  const draftA = newAvatarSlot(clock(), fakeMath);
  const draftB = newAvatarSlot(clock(), fakeMath);
  assert.notEqual(draftA, draftB, 'Two unsaved masks must not share a draft slot');
  assert.notEqual(
    maskAvatarPath('user1', draftA),
    maskAvatarPath('user1', draftB),
    'Two unsaved masks must not upload to the same Storage object'
  );
  assert.doesNotMatch(draftA, /^\s*$/, 'A draft slot must not be empty');
  assert.ok(
    !maskAvatarPath('user1', draftA).includes('undefined'),
    'A draft path must never contain "undefined"'
  );
}

// ── The shared-path bug must not come back ───────────────────────────────────
assert.ok(
  !/storagePath=\{`users\/\$\{uid\}\/characters\/avatar`\}/.test(src),
  'Masks must not upload to the shared characters/avatar object again'
);
assert.ok(
  /storagePath=\{maskAvatarPath\(uid, avatarSlot\)\}/.test(src),
  'The mask uploader must build its path from the per-mask slot'
);

// The slot is (re)assigned when the modal opens, so editing mask A and then
// adding mask B cannot leave B writing into A's object.
assert.match(src, /setAvatarSlot\(char\.id\)/, 'Opening a saved mask adopts its own slot');
assert.match(src, /setAvatarSlot\(newAvatarSlot\(\)\)/, 'Opening a new mask mints a fresh slot');

console.log('OK  mask avatars: one Storage object per mask, drafts included');
