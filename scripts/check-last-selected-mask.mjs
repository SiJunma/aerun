// Regression test for "the reply picker always offers the wrong mask".
//
// The picker wrote the choice and then read it back from somewhere else:
//
//	onClick -> updateUser(uid, { last_selected_character_id: id })
//	                                  ^ PATCH /me/profile, and nothing else
//	render -> profile.last_selected_character_id
//	            ^ built from pb.authStore.record, which that fetch never touches
//
// The write landed in the database and the read kept answering with whatever
// was in the auth store at SIGN-IN time. Observed on a real account: the stored
// mask was "ПичX" and the newest post was written under "ПичX", while the picker
// offered "RoughX" — the first mask in the list, and the one selected at login.
// A full page reload did not help either, because PocketBase restores the auth
// store from localStorage and nothing had ever refreshed it.
//
// Run: node scripts/check-last-selected-mask.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const provider = fs.readFileSync(new URL('../src/contexts/AuthProvider.jsx', import.meta.url), 'utf8');
const topic = fs.readFileSync(new URL('../src/pages/TopicPage.jsx', import.meta.url), 'utf8');
const topicForm = fs.readFileSync(new URL('../src/pages/TopicFormPage.jsx', import.meta.url), 'utf8');
const forumApi = fs.readFileSync(new URL('../src/api/forum.js', import.meta.url), 'utf8');

const providerCode = provider
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── The write must reach the store the read comes from ──────────────────────
// A PATCH alone is the bug, not the fix: it moves the database while the
// picker keeps reading the auth store.
assert.match(
  provider,
  /const setLastSelectedMask = useCallback\(/,
  'AuthProvider must own the mask selection so it can keep the auth store in step'
);
assert.match(
  providerCode,
  /await sendApi\('\/api\/aerun\/me\/profile',\s*\{\s*method: 'PATCH',\s*body: \{ last_selected_character_id: id \}/,
  'the selection must be saved through /me/profile'
);
assert.match(
  providerCode,
  /pb\.authStore\.save\(pb\.authStore\.token,\s*\{\s*\.\.\.record, last_selected_character_id: id \}\)/,
  'the saved record must be written back to the auth store, or a reload resurrects the stale value'
);

// Order matters: writing the store before the server confirmed would leave the
// picker naming a mask the database rejected.
//
// SCOPED TO THE FUNCTION, not to the file. This used to take the FIRST
// `pb.authStore.save(` in the provider, which was correct while the mask was the
// only writer — and silently retargeted the moment updateProfile started
// persisting its own confirmed values, so the check began failing on a file
// that broke nothing. "Written back after the server confirmed" is a property OF
// A WRITE, so it has to be asked of each writer. updateProfile writes the store
// too, and it is held to the same rule below.
const orderedWrites = [
  {
    label: 'setLastSelectedMask',
    source: provider.match(
      /const setLastSelectedMask = useCallback\(async \(characterId\) => \{[\s\S]*?\n  \}, \[user\?\.uid\]\);/
    ),
    patch: "await sendApi('/api/aerun/me/profile'"
  },
  {
    label: 'updateProfile',
    source: provider.match(/const updateProfile = async \(newData, targetUid = null\) => \{[\s\S]*?\n  \};/),
    patch: "/api/aerun/me/profile"
  }
];

for (const { label, source, patch } of orderedWrites) {
  assert.ok(source, `${label} must be extractable so its write ordering can be checked in place`);
  const patchAt = source[0].indexOf(patch);
  const saveAt = source[0].indexOf('pb.authStore.save(');
  assert.ok(
    patchAt !== -1 && saveAt !== -1 && saveAt > patchAt,
    `${label} must update the auth store only AFTER the server confirms the write — a store ` +
      'saved first resurrects a value the database rejected on the next reload'
  );
}

// ── Neither picker may go back to the dead-end route ────────────────────────
for (const [name, src] of [['TopicPage', topic], ['TopicFormPage', topicForm]]) {
  assert.ok(
    !/updateUser\(/.test(src),
    `${name} must not save the mask through updateUser — it writes without refreshing the store`
  );
  assert.match(src, /setLastSelectedMask\(char\.id\)/, `${name} must save the chosen mask`);
  assert.match(src, /setLastSelectedMask\(''\)/, `${name} must clear the selection when posting as the account`);
}

// ── Both pickers must READ the stored selection ─────────────────────────────
// TopicFormPage never read it at all: the reply form remembered the mask and
// the new-topic form always opened on "post as account".
for (const [name, src] of [['TopicPage', topic], ['TopicFormPage', topicForm]]) {
  assert.match(
    src,
    /profile\?\.last_selected_character_id !== undefined && selectedCharacterId === ''/,
    `${name} must start the picker on the stored mask`
  );
}

// The guard is load-bearing: dropping the `=== ''` half would let the effect
// fight the user on every profile write, since picking a mask writes that field.
assert.match(topic, /eslint-disable-next-line react-hooks\/exhaustive-deps/, 'the one-shot init must stay intentional');

// ── The old helper has no remaining callers ─────────────────────────────────
// It still exists in api/forum.js for other callers; what must not come back is
// the picker reaching for it.
assert.match(
  forumApi,
  /'last_selected_character_id' in userData/,
  'api/forum.js keeps its mask branch for other callers'
);

console.log('OK  mask selection: picker write refreshes the store both pickers read from');