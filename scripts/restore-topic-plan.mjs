// Builds the restore plan for a deleted topic from the 2026-09-18 migration
// snapshot. Offline only: reads stage-1.json, writes restore/plan.json.
// Never talks to Firebase and never mutates Firestore.
import fs from 'node:fs';
import path from 'node:path';

const TOPIC_ID = process.env.TOPIC_ID || 'Ida29XJHy3FgLci5e1rS';
const SNAPSHOT = 'backend/migration-data/stage-1.json';
const OUT_DIR = 'restore';

// stage-1.json stores Firestore values as tagged nodes:
//   {type:'scalar',value} | {type:'timestamp',seconds,nanoseconds}
//   | {type:'array',value} | {type:'map',value} | {type:'null'}
function decode(node) {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object' || !('type' in node)) return node;
  switch (node.type) {
    case 'scalar': return node.value;
    case 'timestamp':
      return new Date(Number(node.seconds) * 1000 + Math.floor((node.nanoseconds || 0) / 1e6)).toISOString();
    case 'array': return (node.value || []).map(decode);
    case 'map': return Object.fromEntries(Object.entries(node.value || {}).map(([k, v]) => [k, decode(v)]));
    case 'null': return null;
    default: throw new Error(`unknown snapshot node type: ${node.type}`);
  }
}
const doc = (r) => Object.fromEntries(Object.entries(r.data?.value || {}).map(([k, v]) => [k, decode(v)]));
const collOf = (r) => (r.path || '').split('/')[0];
const idOf = (r) => r.path.split('/').slice(1).join('/');

const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
console.log(`snapshot   : ${SNAPSHOT}`);
console.log(`taken at   : ${raw.startedAt}`);

const topicRec = raw.records.find(r => r.path === `topics/${TOPIC_ID}`);
if (!topicRec) {
  console.error(`\nFATAL: topics/${TOPIC_ID} is not in the snapshot — nothing to restore from it.`);
  process.exit(1);
}
const topic = doc(topicRec);

const posts = raw.records
  .filter(r => collOf(r) === 'posts' && doc(r).topic_id === TOPIC_ID)
  .map(r => ({ id: idOf(r), data: doc(r) }))
  .sort((a, b) => String(a.data.created_at).localeCompare(String(b.data.created_at)));

const repLogs = raw.records
  .filter(r => collOf(r) === 'reputation_logs' && r.data?.value?.topic_id?.value === TOPIC_ID)
  .map(r => ({ id: idOf(r), data: doc(r) }));

const notifs = raw.records
  .filter(r => collOf(r) === 'notifications' && doc(r).payload?.topic_id === TOPIC_ID)
  .map(r => ({ id: idOf(r), data: doc(r) }));

const byAuthor = new Map();
for (const p of posts) byAuthor.set(p.data.author_id, (byAuthor.get(p.data.author_id) || 0) + 1);
const first = posts[0].data;
const last = posts.at(-1).data;
console.log(`\n=== snapshot contents for topics/${TOPIC_ID} ===`);
console.log(`  title        : ${topic.title}`);
console.log(`  category_id  : ${topic.category_id}`);
console.log(`  author_id    : ${topic.author_id} (${topic.author_name})`);
console.log(`  created_at   : ${topic.created_at}`);
console.log(`  posts        : ${posts.length}  (${first.created_at} .. ${last.created_at})`);
console.log(`  topic.posts_count (snapshot): ${topic.posts_count}`);
console.log(`  authors      : ${byAuthor.size}`);
for (const [uid, n] of [...byAuthor].sort((a, b) => b[1] - a[1])) console.log(`      ${uid}: ${n}`);
console.log(`  reputation_logs : ${repLogs.length} (sum ${repLogs.reduce((s, r) => s + Number(r.data.value || 0), 0)})`);
console.log(`  notifications   : ${notifs.length}`);
const gapNote = `Snapshot ends ${last.created_at}. Anything written after that is NOT in this plan.`;
console.log(`\n  ! ${gapNote}`);



// ── Emit the plan ────────────────────────────────────────────────────────────
// posts[].reputation is deliberately NOT trusted from the snapshot: votes cast
// between the snapshot and the deletion survive in the LIVE reputation_logs
// collection, so the apply step recomputes each post's reputation from the live
// logs. That makes the restore correct for the newer votes too.
const plan = {
  generatedAt: new Date().toISOString(),
  project: raw.projectId,
  snapshotTakenAt: raw.startedAt,
  snapshotId: raw.snapshot,
  topic: {
    id: TOPIC_ID,
    title: topic.title,
    category_id: topic.category_id,
    author_id: topic.author_id,
    snapshotPostsCount: topic.posts_count,
    snapshotLastPostAt: last.created_at,
  },
  documents: {
    topics: [{ id: TOPIC_ID, data: topic }],
    posts: posts.map(p => ({ id: p.id, data: p.data })),
    // Applied with create(), not set(): a document that already exists in the
    // live DB (written after the snapshot) is skipped, never overwritten.
    reputation_logs: repLogs,
    notifications: notifs,
  },
  counters: {
    // Recomputed from authoritative live counts by the apply step; these are
    // the snapshot's own values, kept only for cross-checking.
    topicPostsCount: posts.length,
    topicAuthorId: topic.author_id,
    categoryId: topic.category_id,
  },
  gap: { newestPostInSnapshot: last.created_at, warning: gapNote },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'plan.json');
fs.writeFileSync(outFile, JSON.stringify(plan, null, 1));
console.log(`\nplan written: ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB)`);
const d = plan.documents;
console.log(`  topics ${d.topics.length}, posts ${d.posts.length}, ` +
  `reputation_logs ${d.reputation_logs.length}, notifications ${d.notifications.length}`);
console.log('\nNo network access; nothing was written to Firestore.');
