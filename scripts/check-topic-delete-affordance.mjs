// The delete-topic affordance must EXIST for the ordinary author.
//
// REPORTED DEAD END. An author who opened a topic and then wanted to remove
// it had no way to do so:
//
//   1. the post menu answered "This is the topic's first post. Use the topic
//      menu to delete the whole topic." — a refusal, not a path;
//   2. the topic menu it pointed at showed "Delete Topic" ONLY to holders of
//      `delete_others_topics`, and that key is granted to admins and root
//      alone (backend/internal/auth/role.go: moderators are deliberately
//      denied it, and the owner ruled that a moderator does not delete
//      another account's topic).
//
// So the author was told to go somewhere that did not exist for them. The
// server was never the obstacle: DELETE /topics/{id} accepts the author of
// a topic (see deleteTopicHandler in
// backend/internal/platform/pocketbase/forum_topics.go) and answers 409 only
// when the thread holds replies from other members.
//
// WHY THIS IS AN EXECUTED TEST, NOT A GREP. The rule used to live inside
// TopicPage's render body, where the only way to "check" it was to read its
// text — and a grep cannot tell a rule that works from a rule that was
// merely typed. The rule now lives in src/utils/topic-delete.js as plain
// data in, boolean out, and this file imports and RUNS it. It also pins the
// server's own answer, because the client's promise ("the action exists")
// is only true if the server has such a path.
//
// Run: node scripts/check-topic-delete-affordance.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from '../src/constants/permissions.js';
import { canDeleteTopic, resolveTopicOwnerId, topicDeleteErrorText } from '../src/utils/topic-delete.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const PLAYER = 'userplayer00001';
const STRANGER = 'usermoder000001';

// A viewer with an explicit permission set. The permission probe is the
// client's own contract: `hasPermission(perm)` answers whether the CALLER
// holds the key, and the account's own id decides authorship.
const viewer = (uid, permissions = []) => ({
  user: { uid },
  hasPermission: (perm) => permissions.includes(perm),
});

// The topic page is driven by GET /topics/{id}/stats, whose payload carries
// the FLAT author_id; the full topic payload carries the nested author DTO.
// Both shapes must resolve to the same owner.
const flatTopic = (authorId) => ({ id: 'topic1', author_id: authorId, posts_count: 3 });
const nestedTopic = (authorId) => ({ id: 'topic1', author: { user_id: authorId }, posts_count: 3 });

// ── 1. The author may delete their own topic ───────────────────────────────────
//
// This is the case that was broken. The author holds no `delete_others_topics`
// — the very key whose absence made the old topic menu useless to them — and
// the action must still be offered, because the server has that path.
for (const [label, topic] of [['flat author_id', flatTopic(PLAYER)], ['nested author DTO', nestedTopic(PLAYER)]]) {
  assert.equal(
    canDeleteTopic({ topic, ...viewer(PLAYER) }),
    true,
    `the author must be offered the topic delete (${label}) — the server accepts it`
  );
}

// ── 2. A stranger may NOT ──────────────────────────────────────────────────────
//
// The server answers 403 for somebody else's topic, so the client must not
// offer the action. Offering it would be the mirror-image dead end: a button
// that always ends in a refusal.
assert.equal(
  canDeleteTopic({ topic: flatTopic(PLAYER), ...viewer(STRANGER) }),
  false,
  'a stranger must not be offered the delete of another account\'s topic'
);
assert.equal(
  canDeleteTopic({ topic: flatTopic(PLAYER), ...viewer(STRANGER, [PERMISSIONS.DELETE_OTHERS_POSTS]) }),
  false,
  'delete_others_posts is a POST right — it must not widen into a topic delete'
);

// ── 3. Staff with the topic key may ───────────────────────────────────────────
assert.equal(
  canDeleteTopic({ topic: flatTopic(PLAYER), ...viewer(STRANGER, [PERMISSIONS.DELETE_OTHERS_TOPICS]) }),
  true,
  'a holder of delete_others_topics must be offered the delete of any topic'
);

// ── 4. A signed-out visitor may NOT ───────────────────────────────────────────
assert.equal(
  canDeleteTopic({ topic: flatTopic(PLAYER), ...viewer(null) }),
  false,
  'a guest must not be offered a topic delete'
);
assert.equal(
  canDeleteTopic({ topic: flatTopic(PLAYER), user: null, hasPermission: () => false }),
  false,
  'a missing account must not be offered a topic delete'
);

// ── 5. A guest topic has no owner ─────────────────────────────────────────────
//
// A topic opened by a guest carries an EMPTY author_id. An empty id must not
// compare equal to an account id, or the first signed-in member on the forum
// would be handed the delete of every guest thread.
assert.equal(resolveTopicOwnerId(flatTopic('')), null, 'a guest topic must resolve to no owner');
assert.equal(resolveTopicOwnerId(nestedTopic(null)), null, 'a guest topic must resolve to no owner (nested shape)');
assert.equal(
  canDeleteTopic({ topic: flatTopic(''), ...viewer(PLAYER) }),
  false,
  'a guest topic must not be deletable by an ordinary account'
);

// ── 6. An unknown topic is not deletable by anybody ───────────────────────────
assert.equal(
  canDeleteTopic({ topic: null, ...viewer(PLAYER) }),
  false,
  'an absent topic must not be deletable'
);
assert.equal(
  canDeleteTopic({ topic: undefined, ...viewer(PLAYER, [PERMISSIONS.DELETE_OTHERS_TOPICS]) }),
  false,
  'an absent topic must not be deletable even by staff'
);

// ── 7. The refusals are named, not raw ─────────────────────────────────────────
//
// A 409 is a POLICY answer ("the thread holds other members' replies"), not a
// broken request, so it gets its own text. A 403 is the authority answer.
// Both must name the reason instead of surfacing the API's English sentence.
const conflict = topicDeleteErrorText({ status: 409 }, 'ru');
assert.match(conflict, /ответы других участников/, 'a 409 must say the thread holds other members\' replies');
assert.notEqual(
  conflict,
  topicDeleteErrorText({ status: 409 }, 'en'),
  'the refusal text must be localised, not one fixed sentence'
);
assert.match(
  topicDeleteErrorText({ status: 403 }, 'ru'),
  /Недостаточно прав/,
  'a 403 must say the viewer lacks the rights'
);
assert.equal(
  topicDeleteErrorText({ status: 500, message: 'boom' }, 'ru'),
  'boom',
  'an unexpected failure must still surface the server\'s own message'
);
assert.ok(
  topicDeleteErrorText({ status: 0 }, 'ru').length > 0,
  'a network failure must still produce a message — never a blank toast'
);

// ── 8. The page must not have grown a second, divergent rule ──────────────────
//
// The point of extracting the rule is that there is exactly ONE of it. A copy
// left behind in the page would drift, and the copy is what a reader would
// find and "fix" in the wrong place.
const topicPage = read('../src/pages/TopicPage.jsx');
assert.ok(
  /import \{[^}]*canDeleteTopic[^}]*\} from '\.\.\/utils\/topic-delete'/.test(topicPage),
  'TopicPage must import canDeleteTopic from src/utils/topic-delete.js'
);
assert.ok(
  !/const canDeleteTopic = isTopicOwner/.test(topicPage),
  'TopicPage must not keep its own copy of the rule — the extracted module is the single source'
);
assert.ok(
  !/Это первое сообщение темы|Use the topic menu to delete the whole topic/.test(topicPage),
  'the dead-end refusal must be gone from the page — the author has a real path now'
);

// The first post must still go through the TOPIC route, never DELETE
// /posts/{id}: the server refuses the opening post there with a 409, by
// design (the first post IS the topic).
const branchStart = topicPage.indexOf('const isFirstPost = isTopicFirstPost(');
assert.ok(branchStart !== -1, 'TopicPage must keep its first-post branch');
const firstPostBranch = topicPage.slice(branchStart, topicPage.indexOf('} else {', branchStart));
assert.match(
  firstPostBranch,
  /deleteTopics\(\[id\]/,
  'deleting the first post must go through DELETE /topics/{id}'
);
assert.ok(
  !/deletePost\(/.test(firstPostBranch),
  'the first-post branch must never call DELETE /posts/{id} — the server refuses the opening post there'
);

console.log('OK  topic delete: the author is offered the delete of their own topic');
console.log('OK  topic delete: a stranger and a guest are not');
console.log('OK  topic delete: staff with delete_others_topics are');
console.log('OK  topic delete: a guest topic has no owner');
console.log('OK  topic delete: the 409/403 refusals are named, not raw');
console.log('OK  topic delete: the rule lives in one place and the page imports it');