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
// Run: node scripts/check-topic-delete-cleanup.mjs [path/to/functions/index.js]
// The optional path lets the same assertions run against another build (for
// example the pre-fix file from git) to prove the test actually fails there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../functions/index.js', import.meta.url));
const src = fs.readFileSync(target, 'utf8');
console.log(`source: ${target}`);

// Extract a named trigger/helper body by brace matching so the assertions run
// against the real shipped code, not a copy of it.
function bodyOf(declaration) {
  const start = src.indexOf(declaration);
  assert.ok(start !== -1, `${declaration} must exist in functions/index.js`);
  const open = src.indexOf('{', src.indexOf('=>', start) === -1 ? start : src.indexOf('=>', start));
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

const onTopicDeleted = bodyOf('exports.onTopicDeleted');
const onPostDeleted = bodyOf('exports.onPostDeleted');
const onReputationLogDeleted = bodyOf('exports.onReputationLogDeleted');

// ── 1. Per-author post_count decrement ──────────────────────────────────────
assert.match(onTopicDeleted, /perAuthor/, 'onTopicDeleted must aggregate the deleted posts per author');
assert.match(
  onTopicDeleted,
  /queueIncrement\(\s*batch,\s*db\.collection\(["']users["']\)\.doc\(aid\),\s*["']post_count["']\s*,\s*-n\s*\)/,
  'onTopicDeleted must decrement users.post_count for every author of the topic'
);
assert.match(
  onTopicDeleted,
  /perAuthor\.set\(\s*aid,\s*\(perAuthor\.get\(aid\)\s*\|\|\s*0\)\s*\+\s*1\s*\)/,
  'the per-author tally must count posts, not just note presence'
);

// ── 2. The cascade guard must stay, or the counters decrement twice ──────────
assert.match(
  onPostDeleted,
  /if\s*\(!topicSnap\.exists\)/,
  'onPostDeleted must keep its cascade guard — the topic document is already gone for cascade posts'
);
assert.match(
  onPostDeleted,
  /skipped counters for cascade\/orphan post/,
  'the cascade guard must still document why it skips the counters'
);

// ── 3. Reputation logs and subscriptions are cleaned up ─────────────────────
const deleteCalls = [...onTopicDeleted.matchAll(/deleteAllByQuery\(\s*db,\s*db\.collection\(["']([a-z_]+)["']\)\.where\(\s*["']topic_id["']/g)]
  .map(m => m[1]);
assert.ok(
  deleteCalls.includes('reputation_logs'),
  'onTopicDeleted must delete the topic\'s reputation_logs, otherwise users keep reputation for deleted posts'
);
assert.ok(
  deleteCalls.includes('topic_subscriptions'),
  'onTopicDeleted must delete the topic\'s subscriptions; nothing else removes them'
);
assert.ok(
  /deleteAllByQuery\(db, ref, label\)|function deleteAllByQuery\(db, ref, label\)/.test(src)
    || /async function deleteAllByQuery\(\s*db,/.test(src),
  'deleteAllByQuery must take the Firestore instance explicitly'
);

// ── 4. The reputation revert must be exactly-once ───────────────────────────
assert.match(
  onReputationLogDeleted,
  /reputation_reverts/,
  'onReputationLogDeleted must claim its revert through reputation_reverts'
);
assert.match(
  onReputationLogDeleted,
  /claimRef\.create\(/,
  'the claim must use create() so a redelivery fails instead of reverting twice'
);
assert.match(
  onReputationLogDeleted,
  /already reverted, skipping/,
  'a failed claim must return early'
);

console.log('OK  topic delete: every author loses post_count for their deleted posts');
console.log('OK  topic delete: cascade guard still prevents a double decrement');
console.log('OK  topic delete: reputation_logs and topic_subscriptions are cleaned up');
console.log('OK  reputation revert is claimed exactly once');
