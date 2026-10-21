// Regression test for "deleting a topic left counters and reputation logs wrong".
//
// Two real bugs, both observed on the live forum:
//   1. users.post_count was never decremented for a deleted topic. onPostDeleted
//      returns early for cascade posts (the topic document is already gone), so
//      the per-author decrement had to move into onTopicDeleted.
//   2. reputation_logs for the topic survived, so the users kept the reputation
//      they had earned on posts that no longer exist — and topic_subscriptions
//      leaked as well.
//   3. onReputationLogDeleted had no at-least-once guard, so once a topic delete
//      removes many logs the revert can be applied twice.
//
// WHERE THE CONTRACT LIVES NOW. This gate used to read the Firestore Cloud
// Function (`functions/index.js`) that implemented those behaviours. That file
// was DELETED by the Firebase cleanup (commit a01ffb8), so the gate was
// reading a path that no longer exists and `npm test` was RED on this branch
// for a reason that had nothing to do with the code under test. The behaviour
// itself was NOT dropped with the file: it was ported to the PocketBase
// backend, and the port is what this gate reads now —
//
//	backend/internal/platform/pocketbase/forum_topics.go  (the delete command
//	    and the residue it settles: per-author counters, reputation payback,
//	    subscription cleanup, vote removal)
//	backend/internal/platform/pocketbase/forum_posts.go   (the guard that
//	    refuses to delete a topic's first post as a post)
//
// The EXECUTING proof of the same contract is the Go suite —
// `topic_delete_residue_test.go` and `hard_delete_test.go` — which runs in CI
// (.github/workflows/backend.yml). This gate stays because it fails LOUDLY and
// in the same npm run when the settlement is removed from the command, which
// is the shape of defect a Go test in another package would not be noticed for.
//
// Run: node scripts/check-topic-delete-cleanup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const topicsGo = read('../backend/internal/platform/pocketbase/forum_topics.go');
const postsGo = read('../backend/internal/platform/pocketbase/forum_posts.go');

// ── 1. Per-author post_count decrement ─────────────────────────────────────────
//
// The tally is aggregated per author BEFORE anything is deleted, and each
// author is decremented once by the number of posts they lose. A per-post
// loop that decremented and bailed out mid-way is the exact defect the
// 2026-09-30 incident turned into data loss.
assert.match(
  topicsGo,
  /GROUP BY author_id[\s\S]{0,600}?adjustUserPostCount\(txApp, row\.AuthorID, -row\.Cnt\)/,
  'the topic delete must aggregate the deleted posts per author and decrement each author once'
);
assert.match(
  topicsGo,
  /adjustUserTopicCount\(txApp, topic\.GetString\("author_id"\), -1\)/,
  'the topic delete must move the author\'s topic count down by one'
);

// ── 2. The opening post is a topic-level operation ────────────────────────────
//
// The first post IS the topic, so removing it must go through DELETE
// /topics/{id}. DELETE /posts/{id} refuses it, which is what keeps the
// "deleting a reply on page 2 wiped the whole topic" incident impossible
// regardless of what a client asks for.
assert.match(
  postsGo,
  /if isFirstPost \{[\s\S]{0,200}?conflictError\("cannot delete a topic's first post here - delete the topic instead"\)/,
  'DELETE /posts/{id} must refuse the topic\'s first post with a 409'
);

// ── 3. Reputation and subscriptions must not outlive the topic ────────────────
//
// A member who kept the reputation they earned on posts the forum can no
// longer show is the be6ca82 defect, and a subscription pointing at a topic
// id that will never resolve again is the leak that followed it.
assert.match(
  topicsGo,
  /adjustUserReputation\(txApp, row\.TargetID, -row\.Total\)/,
  'the topic delete must pay back the reputation its votes paid out'
);
assert.match(
  topicsGo,
  /topicSubscriptionsCollectionName[\s\S]{0,800}?txApp\.Delete\(sub\)/,
  'the topic delete must remove the topic\'s subscriptions'
);
assert.match(
  topicsGo,
  /DELETE FROM " \+ reputationVotesCollectionName \+ " WHERE topic_id = \{:topic\}/,
  'the vote rows must go with the topic — a vote whose post is gone is an orphan'
);

// ── 4. The settlement happens inside the delete's transaction ─────────────────
//
// Exactly-once is what the Firestore version had to buy with a separate
// reputation_reverts claim. Inside one transaction the deletion itself is the
// claim: the votes are gone by the end, so a second pass finds nothing to pay.
// That only holds if the settlement is part of the same command, so the
// residue purge and the post removal have to sit next to the topic deletion
// inside deleteTopicHandler.
const handler = topicsGo.slice(
  topicsGo.indexOf('func deleteTopicHandler('),
  topicsGo.indexOf('// deleteTopicPosts removes every post under a topic')
);
assert.ok(handler.length > 0, 'deleteTopicHandler must exist in forum_topics.go');
assert.match(
  handler,
  /purgeTopicResidue\(txApp, topic\)/,
  'the residue must be settled by the delete command itself'
);
assert.match(
  handler,
  /deleteTopicPosts\(txApp, topic\)/,
  'the posts must be removed by the delete command itself'
);
assert.match(
  handler,
  /runCommand\(e\.App, claim, func\(txApp core\.App\)/,
  'the whole delete — topic, posts and every denormalized copy — must run in one transaction'
);

console.log('OK  topic delete: every author loses post_count for their deleted posts');
console.log('OK  topic delete: a topic\'s first post is refused as a post delete');
console.log('OK  topic delete: reputation, votes and subscriptions are cleaned up');
console.log('OK  topic delete: the settlement runs inside the delete\'s own transaction');

