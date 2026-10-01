// Type-correction pass for the restored topic.
//
// The plan decoded snapshot timestamps into ISO strings, so the restored posts
// were written with created_at as a STRING instead of a Firestore Timestamp.
// Application code calls .toDate() on it and paginates with orderBy, so this
// must be corrected even though the documents themselves are right.
//
// Read from the original snapshot (which still carries the type tags) and
// rewrite the 693 posts + the topic document with correctly typed values.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const plan = JSON.parse(fs.readFileSync('restore/plan.json', 'utf8'));
const TOPIC_ID = plan.topic.id;
const APPLY = process.argv.includes('--apply');
const BATCH = 400;

admin.initializeApp({ projectId: plan.project });
const db = admin.firestore();
const log = (...a) => console.log(...a);

// Snapshot nodes: {type:'scalar'|'timestamp'|'array'|'map'|'null'}
function toFirestore(node) {
  if (node === null || node === undefined) return null;
  if (typeof node !== 'object' || !('type' in node)) return node;
  switch (node.type) {
    case 'scalar': return node.value;
    case 'timestamp':
      return admin.firestore.Timestamp.fromMillis(
        Number(node.seconds) * 1000 + Math.floor((node.nanoseconds || 0) / 1e6));
    case 'array': return (node.value || []).map(toFirestore);
    case 'map': return Object.fromEntries(Object.entries(node.value || {}).map(([k, v]) => [k, toFirestore(v)]));
    case 'null': return null;
    default: throw new Error(`unknown node type ${node.type}`);
  }
}

const raw = JSON.parse(fs.readFileSync('backend/migration-data/stage-1.json', 'utf8'));
const wanted = new Set([TOPIC_ID, ...plan.documents.posts.map(p => p.id)]);
const records = raw.records.filter(r => r.path?.startsWith('posts/') && wanted.has(r.path.split('/')[1]));
const topicRec = raw.records.find(r => r.path === `topics/${TOPIC_ID}`);
// Pass r.data (the tagged outer map), NOT r.data.value: handing the inner object
// to toFirestore returns it untouched because it carries no 'type' key of its
// own, which is how the raw {type:'timestamp',seconds,nanoseconds} node ends up
// stored as a map.
const targets = [...records.map(r => ({ coll: 'posts', id: r.path.split('/')[1], data: toFirestore(r.data) }))];
if (topicRec) targets.push({ coll: 'topics', id: TOPIC_ID, data: toFirestore(topicRec.data) });

log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
log(`documents to re-type: ${targets.length}`);

// Report what is actually stored today.
const sample = await db.collection('posts').doc(plan.documents.posts[0].id).get();
log(`\ncurrent stored types on post ${plan.documents.posts[0].id}:`);
for (const [k, v] of Object.entries(sample.data())) {
  const t = v?.constructor?.name ?? typeof v;
  if (k === 'created_at' || k === 'updated_at') log(`  ${k}: ${t} = ${String(v)}`);
}
log(`  -> created_at is a ${sample.data().created_at?.constructor?.name}; must be a Timestamp`);

if (!APPLY) {
  log(`\n=== DRY RUN COMPLETE — nothing written ===`);
  process.exit(0);
}

let patched = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const chunk = targets.slice(i, i + BATCH);
  const b = db.batch();
  for (const t of chunk) b.update(db.collection(t.coll).doc(t.id), t.data);
  await b.commit();
  patched += chunk.length;
  log(`  retyped ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
}

const after = await db.collection('posts').doc(plan.documents.posts[0].id).get();
log(`\nafter: created_at is a ${after.data().created_at?.constructor?.name} = ${after.data().created_at?.toDate?.().toISOString?.()}`);
log(`posts retyped: ${patched - 1}, topic retyped: 1`);
