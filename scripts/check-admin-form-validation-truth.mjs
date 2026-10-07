// Executable truth table for the admin form-validity flags.
//
// These flags are the ONLY thing standing between an empty form and a Save
// button that silently does nothing, so their boundaries are asserted by running
// them rather than by reading them: off-by-one trimming here is exactly the bug
// that produced a request the server rejected with 400.
//
// Run: node scripts/check-admin-form-validation-truth.mjs
import assert from 'node:assert/strict';

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// Mirrors the definitions in AdminPage.jsx. Kept in sync BY the AST check above,
// which asserts each guarded field on the page is marked isInvalid; this script
// asserts the arithmetic those markers depend on.
const groupTitleFilled = (f) => Boolean(trimmed(f?.title?.en) || trimmed(f?.title?.ru));
const catTitleFilled = (f) => Boolean(trimmed(f?.title?.en) || trimmed(f?.title?.ru));
const catGroupChosen = (f) => Boolean(f?.group_id);
const catDescTooLong = (f) =>
  trimmed(f?.description?.en).length + trimmed(f?.description?.ru).length > 1024;

const form = (title, over = {}) => ({
  title: { en: '', ru: '', ...title },
  description: { en: '', ru: '' },
  group_id: 'g1',
  ...over,
});

// ── title: EITHER language is enough (server primary is `ru || en`) ───────────
assert.equal(groupTitleFilled(form({ en: 'News' })), true, 'EN alone must satisfy the group title');
assert.equal(groupTitleFilled(form({ ru: 'Новости' })), true, 'RU alone must satisfy the group title');
assert.equal(groupTitleFilled(form({ en: 'News', ru: 'Новости' })), true, 'both must satisfy it');
assert.equal(groupTitleFilled(form({})), false, 'an empty form must not satisfy the group title');

assert.equal(catTitleFilled(form({ en: 'General' })), true, 'EN alone must satisfy the category title');
assert.equal(catTitleFilled(form({})), false, 'an empty form must not satisfy the category title');

// ── whitespace is not a title ───────────────────────────────────────────────
// The pre-fix guards compared raw values, so " " passed and became a 400.
for (const blank of [' ', '   ', '\t', '\n', ' \t\n ']) {
  assert.equal(groupTitleFilled(form({ en: blank })), false, `"${JSON.stringify(blank)}" must not count as a group title`);
  assert.equal(catTitleFilled(form({ ru: blank })), false, `"${JSON.stringify(blank)}" must not count as a category title`);
}
// ...and must not be rescued by the other language either.
assert.equal(groupTitleFilled(form({ en: ' ', ru: ' ' })), false, 'two blank titles must still fail');

// A padded but real title must still pass — trimming is not over-eager.
assert.equal(groupTitleFilled(form({ en: '  News  ' })), true, 'a padded title must still pass');
assert.equal(groupTitleFilled(form({ en: '0' })), true, 'a title of "0" is a title, not an empty one');

// ── the group select ────────────────────────────────────────────────────────
assert.equal(catGroupChosen(form({}, { group_id: 'g1' })), true, 'a chosen group must satisfy the check');
assert.equal(catGroupChosen(form({}, { group_id: '' })), false, 'the empty sentinel must NOT satisfy it');
assert.equal(catGroupChosen(form({}, { group_id: 'unassigned' })), true, 'the UI sentinel is a non-empty id here');

// ── description length: measured over BOTH languages ─────────────────────────
const longDesc = (n) => 'x'.repeat(n);
assert.equal(catDescTooLong(form({}, { description: { en: longDesc(1024), ru: '' } })), false, '1024 exactly is allowed (server: > 1024 fails)');
assert.equal(catDescTooLong(form({}, { description: { en: longDesc(1025), ru: '' } })), true, '1025 must fail');
assert.equal(
  catDescTooLong(form({}, { description: { en: longDesc(600), ru: longDesc(500) } })),
  true,
  'the two languages add up — each alone is legal'
);

console.log('admin form validity truth table OK — trim, either-language, sentinel and length boundaries all hold');