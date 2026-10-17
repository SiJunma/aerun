// The drafts and settings write contracts.
//
// Two unrelated data bugs, both reported as "the forum ate my data".
//
// DRAFTS were a leftover from before the drafts migration: the browser stored
// them in localStorage while the server had owned the whole feature since
// migration 1766700000. Three defects followed from that split, and all three
// were visible at once:
//
//   1. saving wrote a key and notified nobody, while the reader fired ONCE on
//      mount — so a new draft stayed invisible until a manual reload;
//   2. updating stored a DIFFERENT object shape than saving had, discarding
//      every author_* field, and again notified nobody — so the card showed
//      stale text and fell back to the "Guest" author;
//   3. buildPostData never set `is_draft`, so Delete fell through to the
//      real-post branch and called deletePost on an id that was never a post.
//
// SETTINGS are replaced wholesale by PUT /me/settings — a deliberate server
// contract. It only holds if the client sends the whole object, and the account
// form sends an enumeration of the fields it knows. Worse, the optimistic merge
// then overwrote the complete settings the server had just returned with that
// same partial object, so the NEXT save deleted every key the form omits
// (member_view_style, show_footer, ...) from the database.
//
// These are source-shape gates because the failure is structural: a handler
// that persists correctly and forgets to update state renders perfectly in
// review and behaves as if the write never happened.
//
// Run: node scripts/check-drafts-and-settings.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const forumApi = read('../src/api/forum.js');
const topicPage = read('../src/pages/TopicPage.jsx');
const authProvider = read('../src/contexts/AuthProvider.jsx');
const draftsGo = read('../backend/internal/platform/pocketbase/drafts.go');
const forumPostsGo = read('../backend/internal/platform/pocketbase/forum_posts.go');

// Comments name the old symbols constantly while explaining why they went, so a
// gate that failed on its own documentation would be deleted rather than obeyed.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const code = {
  forumApi: stripComments(forumApi),
  topicPage: stripComments(topicPage),
  authProvider: stripComments(authProvider),
};

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// ── Drafts live on the server ───────────────────────────────────────────────
check(
  !/aerun_draft_/.test(code.forumApi),
  'src/api/forum.js must not persist drafts to localStorage: the server owns them (one per ' +
    'author per topic) and the browser copy was never notified, so a saved draft stayed invisible'
);
check(
  /export const saveTopicDraft = async \(topicId, content/.test(code.forumApi),
  'saveTopicDraft must exist and address a draft by TOPIC — the command is (author, topic) unique'
);
check(
  /character_id: characterId \|\| ''/.test(code.forumApi),
  'saveTopicDraft must transmit the picked mask as character_id — the server stores it on the ' +
    'draft row and publish promotes that row verbatim, so a draft filed without it publishes ' +
    'under the account name ("маска слетела")'
);
check(
  /export const deleteDraft = async \(draftId\)/.test(code.forumApi),
  'deleteDraft must take the DRAFT id; passing the topic id addresses nothing that can be deleted'
);
check(
  /export const publishDraft = async \(draftId\)/.test(code.forumApi),
  'publishDraft must take the DRAFT id — the server owns the draft→post transition'
);
check(
  /\/api\/aerun\/drafts\/\$\{draftId\}\/publish/.test(code.forumApi),
  'publishDraft must call POST /api/aerun/drafts/{id}/publish instead of faking a post with ' +
    'createPost, which would leave the topic counters and notifications uncorrected'
);

// ── A draft write must update the card ──────────────────────────────────────
// This is the defect the user saw twice: the row was saved and the page
// insisted it did not exist.
// The two saveTopicDraft call sites now pass the PROCESSED text (the body the
// server stores carries `[roll=…]` references) plus the roll map, so the gates
// below match on the argument list rather than on `replyContent.trim()` /
// `editContent.trim()` literally — what they are really asserting is that the
// picked mask is the second-to-last thing sent, not which local variable holds
// the text.
check(
  /await saveTopicDraft\(id, draftContent, selectedCharacterId,[\s\S]{0,200}?\);[\s\S]{0,400}setMyDraft\(decorateDraft\(saved/.test(code.topicPage),
  'handleSaveDraft must call setMyDraft after saving — the card renders from this state, so a ' +
    'silent write leaves the page claiming the draft does not exist until a manual reload'
);
check(
  /await saveTopicDraft\(\s*id,\s*draftContent,\s*editCharacterId,[\s\S]{0,200}?\);[\s\S]{0,400}setMyDraft\(decorateDraft\(saved/.test(code.topicPage),
  'handleUpdateDraft must call setMyDraft after saving — otherwise the card keeps rendering the ' +
    'pre-edit text, which is the second reported symptom'
);
check(
  /await deleteDraft\(deletingPost\.id\);[\s\S]{0,120}setMyDraft\(null\)/.test(code.topicPage),
  'deleting a draft must clear myDraft, or the card survives its own deletion'
);
check(
  !/deleteDraftPost/.test(code.topicPage) && !/createDraftPost/.test(code.topicPage) && !/updateDraftPost/.test(code.topicPage),
  'TopicPage must not call the removed localStorage draft helpers — they wrote a different ' +
    'shape than they read, which is what blanked the author fields'
);
// ── A draft card must never fall back to "Guest" ────────────────────────────
// The localStorage update stored {uid, topicId, content, metadata} over an
// object that had author_id/author_name/...; every one of them vanished at once.
check(
  /const decorateDraft = \(draft, charId = ''\)/.test(code.topicPage),
  'TopicPage must derive the author fields for the draft card (decorateDraft) instead of relying ' +
    'on fields persisted alongside the text - those were what got wiped, leaving a Guest author'
);
check(
  /is_draft: true/.test(code.topicPage),
  'decorateDraft must mark the row is_draft: true - handleDeletePost branches on that flag, and ' +
    'without it Delete addresses a real post with an id that was never one'
);

// ── A published draft keeps its mask ─────────────────────────────────────────
// Reported as "нажала опубликовать драфт — опубликовался, маска слетела". The
// draft command stored only the text, so author_character_id stayed empty on
// the row and publish promoted that row verbatim. Both hops failed silently:
// the publish answered 200 with a real post, just under the wrong identity.
check(
  /resolveAuthorCharacter\(txApp, e\.Auth\.Id, form\.CharacterID\)[\s\S]{0,200}post\.Set\("author_character_id"/.test(draftsGo),
  'upsertDraftHandler must resolve and store author_character_id — publish promotes the draft ' +
    'row as-is, so a draft without the column can only ever publish under the account name'
);
check(
  /func publishDraftHandler[\s\S]*decoratePostAuthors\(/.test(draftsGo),
  'publishDraftHandler must return a DECORATED post — a raw payload carries no author_name or ' +
    'is_character, and TopicPage renders the fresh card from that answer, so an undecorated ' +
    'response repaints the just-published post without its mask'
);
check(
  /func publishDraftHandler[\s\S]*setLastPostProjection\(topic, post\)/.test(draftsGo),
  'publishDraftHandler must advance the topic last-post projection through ' +
    'setLastPostProjection — the single writer that keeps id/timestamp/kind/' +
    'account-id/guest-name/mask in agreement (a bare topic.Set of one column ' +
    'let the others drift)'
);
check(
  /await saveTopicDraft\(id, draftContent, selectedCharacterId, rolls\)/.test(code.topicPage),
  'handleSaveDraft must send the picked mask — the composer already knows it and the server needs ' +
    'it to stamp the draft row'
);
check(
  /await saveTopicDraft\(\s*id,\s*draftContent,\s*editCharacterId,/.test(code.topicPage),
  'handleUpdateDraft must send the edited mask — editing a draft under a different identity and ' +
    'keeping the previous one is the same bug on the update path'
);
// The rolls must reach the draft row too: publish promotes it verbatim, so a
// throw that is not on the row at save time is a post carrying `[roll=…]` tags
// that resolve to nothing.
check(
  /handleSaveDraft[\s\S]{0,600}processDiceRolls\(replyContent\.trim\(\)\)/.test(code.topicPage),
  'handleSaveDraft must throw the dice BEFORE saving the draft — a draft stored with raw ' +
    '[dice=…] markup publishes a post whose [roll=…] reference points at nothing'
);
check(
  /const maskId = draft\.author_character_id \|\| charId/.test(code.topicPage),
  'decorateDraft must prefer the mask the SERVER stored on the draft row — that is the value ' +
    'publish will promote, and preferring the local picker silently disagrees with it'
);
check(
  /await fetchCharacter\(charId\)/.test(code.topicPage),
  "TopicPage must resolve another member's mask through fetchCharacter (the characters " +
    'collection) — reading users.settings.characters is the ADR-5 fold, which is empty since the ' +
    'migration, so every lookup resolved to null'
);
check(
  !/pb\.collection\('users'\)\.getOne\(uid\);\s*\n\s*const characters = u\?\.settings\?\.characters/.test(code.topicPage),
  'TopicPage must not rebuild the mask list out of users.settings.characters — that fold was ' +
    'retracted, and reading it per mask aborted the previous in-flight request every render pass'
);

// ── The edit form's mask picker is not a no-op ───────────────────────────────
// Same defect class on the edit path: `updatePost` named its argument
// `_metadata` and never read it, and `editPostForm` had no character field, so
// changing a post's mask repainted the card and then reverted on the next load.
check(
  /CharacterID \*string `json:"character_id"`/.test(forumPostsGo),
  'editPostForm must accept character_id as a POINTER — an absent key means "leave the mask ' +
    'alone" and cannot be told apart from "post as my account" by a plain string'
);
check(
  /form\.CharacterID != nil && isAuthor/.test(forumPostsGo),
  'the mask branch must be gated on isAuthor — edit_others_posts widens who may rewrite the ' +
    'text, never who owns the identity'
);
check(
  /export const updatePost = async \(postId, content, metadata = \{\}/.test(code.forumApi) &&
    /body\.character_id = metadata\.author_character_id \|\| ''/.test(code.forumApi),
  'updatePost must transmit character_id from the metadata — the parameter was named ' +
    '_metadata and never read, so the edit form mask picker did nothing'
);

// ── Settings must survive a save ────────────────────────────────────────────
check(
  /const stored = res\?\.settings \|\| updated;[\s\S]{0,200}return stored;/.test(code.authProvider),
  'updateSettings must return the object the server stored - the caller needs it to avoid ' +
    'overwriting the authoritative settings with the partial object the form supplied'
);
check(
  !/setProfile\(prev => \(\{ \.\.\.prev, \.\.\.newData \}\)\)/.test(code.authProvider),
  'updateProfile must not spread newData wholesale into the profile: that re-applies the FORM ' +
    'partial settings over the complete ones the server just returned, so the next PUT deletes ' +
    'every key the form omits (member_view_style, show_footer, ...)'
);
check(
  /\.\.\.\(savedSettings \? \{ settings: savedSettings \} : \{\}\)/.test(code.authProvider),
  'the optimistic merge must adopt savedSettings - dropping the form settings key is only safe ' +
    'if the server full object replaces it'
);

// ── The server side of both contracts ───────────────────────────────────────
check(
  /func upsertDraftHandler/.test(draftsGo) && /func publishDraftHandler/.test(draftsGo),
  'the draft commands must exist on the server - the browser has nothing to call otherwise'
);

if (failures.length > 0) {
  console.error(`draft/settings regressions (${failures.length}):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('OK  drafts: stored server-side, not in localStorage');
console.log('OK  drafts: save, edit, delete and publish all address the right id');
console.log('OK  drafts: a write updates the card, so it appears without a reload');
console.log('OK  drafts: the card never falls back to a Guest author');
console.log('OK  drafts: the picked mask is stored on the draft row and survives publish');
console.log('OK  drafts: publish answers with a decorated post, so the mask does not vanish');
console.log("OK  masks: another member's mask is resolved through the characters collection");
console.log('OK  masks: the edit form picker is transmitted, not silently dropped');
console.log('OK  masks: only the author may re-file a post under a different mask');
console.log('OK  settings: a save cannot delete keys the account form does not know');
