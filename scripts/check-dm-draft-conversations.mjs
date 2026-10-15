// Draft DM conversations: an EXECUTION test, not a source grep.
//
// WHY EXECUTION AND NOT A REGEX. The whole defect this replaces ("opening a DM
// POSTs a 'Conversation started' seed before anybody typed") was invisible to a
// grep for getOrCreateConversation, because the write lived in a branch that
// looked correct in review. So this file installs a fake localStorage, imports
// the real draft store, and drives it the way the app does: the store's
// idempotency, its per-account isolation, its merge-on-real-conversation, its
// healing of a corrupted blob, and the composer autosave helpers.
//
// The source-shape checks (no 'Conversation started' literal, POST only in
// startConversationWithMessage, isDraftId guards) are added by later sprints as
// the code they describe lands; this file owns the module behaviour.
//
// Run: node scripts/check-dm-draft-conversations.mjs
import assert from 'node:assert/strict';

// A localStorage stand-in shaped like the real Storage object, including
// key(i)/length iteration, so a fake that leaned on a plain object cannot pass
// a broken real store.
const makeStore = () => {
  const data = new Map();
  return {
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
    _raw: data,
  };
};

const store = makeStore();
globalThis.localStorage = store;

const {
  isDraftId,
  draftIdFor,
  listDrafts,
  getDraft,
  upsertDraft,
  removeDraft,
  pruneDrafts,
  loadComposerText,
  saveComposerText,
  clearComposerText,
  DRAFT_PREFIX,
  COMPOSER_PREFIX,
} = await import('../src/api/dm-drafts.js');

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ok  ${message}`); };

// isDraftId: the divider every server-guarded path keys on.
{
  assert.equal(isDraftId('draft_uPeer123'), true, 'a draft_ id is a draft');
  assert.equal(isDraftId(draftIdFor('uPeer123')), true, 'draftIdFor produces a draft id');
  assert.equal(isDraftId('abcdefghij12345'), false, 'a real PocketBase id is NOT a draft');
  assert.equal(isDraftId(null), false, 'null is not a draft id');
  assert.equal(isDraftId(undefined), false, 'undefined is not a draft id');
  assert.equal(isDraftId(42), false, 'a number is not a draft id');
  assert.equal(draftIdFor('uPeer123'), 'draft_uPeer123', 'the id is deterministic per peer');
  ok('isDraftId divides draft ids from real ones by construction');
}

// Upsert is idempotent by shape: one (me, peer) pair is one draft.
{
  store.clear();
  const id = upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui', avatar: '/a.png' });
  assert.equal(id, 'draft_uPeer', 'upsert returns the deterministic draft id');
  assert.equal(listDrafts('acc1').length, 1, 'the first upsert creates one row');

  // A repeat open (double click, revisit, second tab) must NOT fork a row.
  upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui', avatar: '/a.png' });
  upsertDraft('acc1', { peerUid: 'uPeer' });
  assert.equal(listDrafts('acc1').length, 1,
    'repeated upsert of the same peer must stay one row (requirements 5, 6)');
  ok('repeated opens never fork a second draft row (idempotent by shape)');

  const d = getDraft('acc1', 'uPeer');
  assert.equal(d.nickname, 'Roui', 'the snapshot is kept');
  assert.equal(d.avatar, '/a.png', 'a later empty upsert keeps the earlier avatar');
  assert.equal(getDraft('acc1', 'uOther'), null, 'an unknown peer has no draft');
  ok('the snapshot survives an empty refresh and unknown peers stay empty');
}

// Per-account isolation: another member cannot see this draft.
{
  store.clear();
  upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui' });
  assert.equal(getDraft('acc2', 'uPeer'), null,
    'a different account must not read acc1 draft (the uid is in the key)');
  assert.equal(listDrafts('acc2').length, 0, 'another account lists no drafts');
  ok('drafts are isolated per account (uid is in the key)');

  upsertDraft('acc1', { peerUid: 'uB', nickname: 'B' });
  upsertDraft('acc1', { peerUid: 'uC', nickname: 'C' });
  assert.equal(listDrafts('acc1').length, 3, 'drafts with different peers coexist');
  removeDraft('acc1', 'uB');
  assert.equal(listDrafts('acc1').length, 2, 'removing one draft leaves the others');
  assert.equal(getDraft('acc1', 'uB'), null, 'the removed draft is gone');
  ok('drafts with different peers coexist; deleting one keeps the rest');
}

// Every stored key carries the dedicated prefix.
{
  store.clear();
  upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui' });
  assert.ok(
    [...store._raw.keys()].every((k) => k.startsWith(DRAFT_PREFIX)),
    'the draft store must live under its own prefix',
  );
  ok('draft rows are stored under the dedicated draft prefix');
}

// Merge: a peer with a REAL conversation prunes the draft.
{
  store.clear();
  upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui' });
  upsertDraft('acc1', { peerUid: 'uOther', nickname: 'Other' });

  // The inbox list update carries real conversations with participants.
  const real = [{ id: 'realconv1', participants: ['acc1', 'uPeer'] }];
  const remaining = pruneDrafts('acc1', real);
  const remainingPeers = remaining.map((d) => d.peerUid).sort();
  assert.deepEqual(remainingPeers, ['uOther'],
    'a draft whose peer now has a real conversation is pruned');
  assert.equal(getDraft('acc1', 'uPeer'), null, 'the pruned draft is gone from the store');
  ok('a peer with a real conversation prunes its draft (merge, requirement 3)');

  const before = listDrafts('acc1').map((d) => d.peerUid).sort();
  pruneDrafts('acc1', []);
  assert.deepEqual(listDrafts('acc1').map((d) => d.peerUid).sort(), before,
    'pruning with an empty real list is a no-op');
  ok('pruning with no real conversations changes nothing');
}

// A corrupted blob degrades to empty, never a throw or a ghost row.
{
  store.clear();
  globalThis.localStorage.setItem(`${DRAFT_PREFIX}acc1`, '{not valid json');
  assert.deepEqual(listDrafts('acc1'), [], 'a corrupted store reads as empty, not a throw');
  assert.equal(getDraft('acc1', 'uPeer'), null, 'a corrupted store has no drafts');
  upsertDraft('acc1', { peerUid: 'uPeer', nickname: 'Roui' });
  assert.equal(listDrafts('acc1').length, 1, 'a write after corruption restores a sane store');
  ok('a corrupted draft store degrades to empty and self-heals on write');
}

// Composer autosave: save, load, clear, per-account and per-conversation.
{
  store.clear();
  saveComposerText('draft_uPeer', 'acc1', 'half a thought');
  assert.equal(loadComposerText('draft_uPeer', 'acc1'), 'half a thought',
    'the typed text is restored on return (requirement 8)');
  assert.equal(loadComposerText('draft_uPeer', 'acc2'), '',
    'composer text is isolated per account');
  assert.equal(loadComposerText('realconv1', 'acc1'), '',
    'composer text is isolated per conversation');
  ok('composer text is restored per (conversation, account) and isolated');

  clearComposerText('draft_uPeer', 'acc1');
  assert.equal(loadComposerText('draft_uPeer', 'acc1'), '',
    'a cleared key restores nothing (cleared only on a successful send)');
  ok('a successful send clears the composer key; nothing resurrects it');

  saveComposerText('draft_uPeer', 'acc1', 'x');
  saveComposerText('draft_uPeer', 'acc1', '');
  assert.equal(loadComposerText('draft_uPeer', 'acc1'), '',
    'emptying the composer drops the key, not a blank string');
  assert.ok(
    [...store._raw.keys()].every((k) => k.startsWith(COMPOSER_PREFIX) || k.startsWith(DRAFT_PREFIX)),
    'composer text lives under its own prefix',
  );
  ok('composer text is stored under the dedicated composer prefix');
}

console.log(`\n[OK] draft DM conversations: ${passed} checks passed`);

