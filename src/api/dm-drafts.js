// Draft direct-message conversations: a thread that exists in the browser but
// NOT in the database until its first real message.
//
// THE PROBLEM THIS SOLVES. Opening `/messages/:uid` used to POST
// `/api/aerun/dms` with a literal `text: 'Conversation started'` seed the
// instant the page opened. That wrote a real conversation, a real message, a
// real unread badge on the correspondent and (if they were offline) a real
// email, all before the opener had typed a single character. The other
// participant saw a conversation they never agreed to, carrying a system
// bubble nobody wrote.
//
// THE RULE. A draft is client-only. It is enough to render "opened, but empty"
// on navigation and reload; the server is never asked to persist it. The
// moment the opener actually sends a message, the real conversation is created
// and the draft is pruned (see dms.js startConversationWithMessage and the
// merge triggers in DirectMessages.jsx). Until then the correspondent cannot
// see it and nothing notifies them.
//
// STORAGE. One key per account, keyed by peer uid:
//
//     aerun_dm_drafts_${uid}  ->  { "<peerUid>": { peerUid, nickname, avatar, createdAt } }
//
// The uid is a correctness requirement, not tidiness: the store is read only
// through the signed-in account's uid, so a draft opened by one member is
// physically invisible to another on a shared browser. Drafts deliberately
// SURVIVE sign-out (they are the member's own data, unlike the retired
// clearAllDmCache, which was a cache). No cross-device sync: out of scope.
//
// IDENTITY IS DETERMINISTIC. draft id = 'draft_' + peerUid, so one (me, peer)
// pair is exactly one draft BY CONSTRUCTION: a double click or a repeat visit
// from the profile cannot fork a second row (requirements 5 and 6 are closed
// structurally, not by a de-dup check). The draft_ prefix cannot collide with
// a real PocketBase id, which is 15 characters and contains no underscore.
//
// ZERO SILENT FAILURES. localStorage can throw on access (private-mode Safari,
// hardened configs) and can hold malformed JSON. Every read degrades to an
// empty store with a console.warn, never a thrown error that would blank the
// inbox, and never a half-parsed row that renders as a ghost.

export const DRAFT_PREFIX = 'aerun_dm_drafts_';
// The composer text lives under its own key so a draft row and the text being
// typed in it are independent: the row is addressable by peer, the text by
// conversation id (real or draft). Same principle as TopicPage's reply draft.
export const COMPOSER_PREFIX = 'aerun_dm_composer_';

// Whether an id names a draft rather than a real conversation.
//
// Load-bearing: every code path that would otherwise hit the server with a
// draft id (subscribe to messages, mark read, fetch older, delete) gates on
// this. A real PocketBase id is 15 characters of [a-z0-9] with no underscore,
// so the draft_ prefix is an unambiguous divider.
export const isDraftId = (id) => typeof id === 'string' && id.startsWith('draft_');

// The deterministic id for the (me, peerUid) draft: one pair, one id.
export const draftIdFor = (peerUid) => `draft_${peerUid}`;

// Opens localStorage, or reports that it cannot be opened.
//
// Guarded on ACCESS, not just on use: private-mode Safari and hardened browser
// configs throw when the property is merely READ, so a bare `localStorage`
// reference at module scope would break every importer of this module.
const openStore = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

// Reads the whole per-account draft map, healing a malformed blob to empty.
//
// The value is an object keyed by peerUid, so a repeated upsertDraft of the
// same peer overwrites rather than appends: that is what makes the store
// idempotent by shape. A corrupted value is discarded with a warn (zero silent
// failures) instead of surfacing as a phantom inbox row.
const readAll = (uid) => {
  if (!uid) return {};
  const store = openStore();
  if (!store) return {};
  try {
    const raw = store.getItem(`${DRAFT_PREFIX}${uid}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    console.warn('[dm-drafts] corrupt draft store, treating as empty', err);
    return {};
  }
};

const writeAll = (uid, map) => {
  if (!uid) return;
  const store = openStore();
  if (!store) return;
  try {
    store.setItem(`${DRAFT_PREFIX}${uid}`, JSON.stringify(map));
  } catch (err) {
    console.warn('[dm-drafts] could not persist draft store', err);
  }
};

// Every draft this member has, newest first: the inbox rows to merge in.
export const listDrafts = (uid) => {
  const map = readAll(uid);
  return Object.values(map)
    .filter((d) => d && typeof d.peerUid === 'string')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};

// The single draft for a peer, or null.
export const getDraft = (uid, peerUid) => {
  if (!uid || !peerUid) return null;
  return readAll(uid)[peerUid] || null;
};

// Creates or refreshes the (me, peerUid) draft, returning the deterministic
// draft id.
//
// Upsert by peerUid: a repeat open (double click, revisit from the profile,
// second tab) refreshes the snapshot (nickname/avatar/createdAt) but never
// forks a second row, because the map is keyed by peer. createdAt is refreshed
// on every upsert so "just opened" sorts to the top of the inbox (owner ruling
// 2026-10-14).
export const upsertDraft = (uid, { peerUid, nickname, avatar } = {}) => {
  if (!uid || !peerUid) return null;
  const map = readAll(uid);
  const existing = map[peerUid];
  map[peerUid] = {
    peerUid,
    nickname: nickname || existing?.nickname || '',
    avatar: avatar || existing?.avatar || '',
    createdAt: Date.now(),
  };
  writeAll(uid, map);
  return draftIdFor(peerUid);
};

// Removes the (me, peerUid) draft. Client-only: no server call is implied.
export const removeDraft = (uid, peerUid) => {
  if (!uid || !peerUid) return;
  const map = readAll(uid);
  if (!(peerUid in map)) return;
  delete map[peerUid];
  writeAll(uid, map);
};

// Drops every draft whose peer now has a REAL conversation.
//
// The merge mechanism (requirement 3): when the peer's first message creates a
// real conversation, this runs so the draft row is replaced by the real one.
// It is driven by the inbox list update (the peer's dm.post signal or the list
// poll reaches the second participant), and by a successful first send from the
// opener. realConversations are the server rows, each carrying participants.
// Returns the remaining drafts so a caller can re-render without a second read.
export const pruneDrafts = (uid, realConversations = []) => {
  if (!uid) return [];
  const peersWithReal = new Set();
  for (const conv of realConversations || []) {
    for (const p of conv?.participants || []) {
      if (p && p !== uid) peersWithReal.add(p);
    }
  }
  const map = readAll(uid);
  let changed = false;
  for (const peerUid of Object.keys(map)) {
    if (peersWithReal.has(peerUid)) {
      delete map[peerUid];
      changed = true;
    }
  }
  if (changed) writeAll(uid, map);
  return listDrafts(uid);
};


// Composer text autosave (requirement 8).
//
// The text typed into the DM composer autosaves and is restored on return, for
// BOTH real and draft conversations: the same promise as a topic reply draft.
// convId is the real conversation id or the draft id (draft_${peerUid}), which
// is deterministic, so "the conversation with this peer" is stably addressable
// across a reload. The key is cleared ONLY by a successful send; a failed send
// leaves the text in place (the composer must not eat what the server refused).

export const loadComposerText = (convId, uid) => {
  if (!convId || !uid) return '';
  const store = openStore();
  if (!store) return '';
  try {
    return store.getItem(`${COMPOSER_PREFIX}${convId}_${uid}`) || '';
  } catch (err) {
    console.warn('[dm-drafts] could not read composer text', err);
    return '';
  }
};

export const saveComposerText = (convId, uid, text) => {
  if (!convId || !uid) return;
  const store = openStore();
  if (!store) return;
  try {
    const key = `${COMPOSER_PREFIX}${convId}_${uid}`;
    if (text) {
      store.setItem(key, text);
    } else {
      // An emptied composer has nothing to restore; drop the key so a later
      // return does not resurrect a blank as if it were saved text.
      store.removeItem(key);
    }
  } catch (err) {
    console.warn('[dm-drafts] could not save composer text', err);
  }
};

export const clearComposerText = (convId, uid) => {
  if (!convId || !uid) return;
  const store = openStore();
  if (!store) return;
  try {
    store.removeItem(`${COMPOSER_PREFIX}${convId}_${uid}`);
  } catch (err) {
    console.warn('[dm-drafts] could not clear composer text', err);
  }
};

