// Quantifies exactly what the 2026-09-18 snapshot cannot bring back.
// Read-only against Firestore. Uses the restore plan to decide which surviving
// artefacts can be re-attached and which are permanently lost.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const plan = JSON.parse(fs.readFileSync('restore/plan.json', 'utf8'));
const TOPIC_ID = plan.topic.id;
admin.initializeApp({
  projectId: plan.project,
  databaseURL: `https://${plan.project}-default-rtdb.firebaseio.com`,
});

const db = admin.firestore();
const log = (...a) => console.log(...a);

const planPostIds = new Set(plan.documents.posts.map(p => p.id));
const planPostById = new Map(plan.documents.posts.map(p => [p.id, p.data]));

log(`topic ${TOPIC_ID} "${plan.topic.title}"`);
log(`snapshot plan: ${plan.documents.posts.length} posts, ending ${plan.gap.newestPostInSnapshot}\n`);

// ── 1. Surviving reputation_logs ─────────────────────────────────────────────
// These were never removed by the cascade, so they are a witness list of posts
// that existed AFTER the snapshot. Any post id here that the plan does not
// contain is permanently lost content.
const logs = (await db.collection('reputation_logs').where('topic_id', '==', TOPIC_ID).get()).docs
  .map(d => ({ id: d.id, ...d.data() }));
log(`=== live reputation_logs for this topic: ${logs.length} ===`);
log(`  plan contains ${plan.documents.reputation_logs.length} of them`);

const newer = logs.filter(l => new Date(l.created_at?.toDate?.() ?? l.created_at) >
  new Date(plan.gap.newestPostInSnapshot));
log(`  cast AFTER the snapshot: ${newer.length}`);

const orphanIds = new Map();
for (const l of newer) {
  if (!l.post_id || planPostIds.has(l.post_id)) continue;
  const e = orphanIds.get(l.post_id) || { votes: 0, postNumber: l.post_number, author: l.target_id, first: l.created_at };
  e.votes++;
  if (new Date(l.created_at?.toDate?.() ?? l.created_at) < new Date(e.first)) e.first = l.created_at;
  orphanIds.set(l.post_id, e);
}
log(`\n=== posts voted on after the snapshot that the plan CANNOT restore ===`);
log(`  ${orphanIds.size} distinct post id(s)`);
const authorName = new Map();
for (const [, e] of orphanIds) {
  if (!authorName.has(e.author)) {
    const u = await db.collection('users').doc(e.author).get();
    authorName.set(e.author, u.exists ? (u.data().nickname || e.author) : `${e.author} (user gone)`);
  }
}
for (const [pid, e] of [...orphanIds].sort((a, b) => String(a[1].first).localeCompare(String(b[1].first)))) {
  const t = e.first?.toDate ? e.first.toDate().toISOString() : e.first;
  log(`  post ${pid}  #${e.postNumber ?? '?'}  by ${authorName.get(e.author)}  ${t}  (${e.votes} vote(s))`);
}

// Earliest witness tells us when the topic was still growing after the snapshot.
if (newer.length) {
  const times = newer.map(l => l.created_at?.toDate?.() ?? l.created_at).filter(Boolean).sort();
  log(`\n  earliest post-snapshot vote : ${new Date(times[0]).toISOString()}`);
  log(`  latest   post-snapshot vote : ${new Date(times.at(-1)).toISOString()}`);
}

// ── 2. Votes that DO land on restored posts ─────────────────────────────────
const recoverable = newer.filter(l => l.post_id && planPostIds.has(l.post_id));
log(`\n=== post-snapshot votes that land on restored posts: ${recoverable.length} ===`);
log(`  these raise restored post reputation above the snapshot value`);

// ── 3. Reputation already applied to the authors ─────────────────────────────
log(`\n=== authors of the lost posts ===`);
const lostAuthors = new Map();
for (const [, e] of orphanIds) lostAuthors.set(e.author, (lostAuthors.get(e.author) || 0) + 1);
for (const [uid, n] of [...lostAuthors].sort((a, b) => b[1] - a[1])) {
  const u = await db.collection('users').doc(uid).get();
  log(`  ${authorName.get(uid)} (${uid}): ${n} unrecoverable post(s), reputation ${u.data()?.reputation ?? '?'}`);
}
log(`\n  Their reputation was never rolled back, so these users keep credit for`);
log(`  posts that can no longer be displayed. That is a cosmetic inconsistency,`);
log(`  not data loss — and it cannot be undone without an audit of every vote.`);

// ── 4. Any other surviving traces of the topic ───────────────────────────────
const audits = (await db.collection('audit_logs').orderBy('created_at', 'desc').limit(300).get()).docs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(a => JSON.stringify(a).includes(TOPIC_ID));
log(`\n=== audit_logs mentioning the topic (last 300) : ${audits.length} ===`);
for (const a of audits.slice(0, 10)) {
  log(`  ${a.created_at?.toDate?.().toISOString?.() ?? ''} ${a.action_type ?? a.type ?? ''}`);
}

const subs = await db.collection('topic_subscriptions').where('topic_id', '==', TOPIC_ID).get();
log(`\n  surviving topic_subscriptions: ${subs.size}`);

// ── 5. Posts moved OUT of this topic may still exist ─────────────────────────
// movePosts rewrites post.topic_id. Anything moved away before the deletion
// never belonged to the cascade, so its text can still sit in Firestore under a
// different topic_id — the one real chance of salvaging post-snapshot content.
log(`\n=== posts moved OUT of this topic (possible survivors) ===`);
const movedOut = new Map();
for (const a of audits) {
  const action = a.action_type ?? a.type;
  if (action !== 'posts_moved') continue;
  const d = a.details ?? a.payload ?? {};
  const src = d.sourceTopicId ?? d.source_topic_id;
  if (src !== TOPIC_ID) continue;
  const ids = Array.isArray(d.postIds) ? d.postIds : (d.post_ids ?? []);
  for (const id of ids) movedOut.set(id, d.targetTopicId ?? d.target_topic_id ?? '(unknown)');
}
log(`  audit records ${movedOut.size} post id(s) as having left this topic`);
let survivors = 0;
for (const [pid, dest] of movedOut) {
  const s = await db.collection('posts').doc(pid).get();
  if (!s.exists) continue;
  survivors++;
  const d = s.data();
  log(`  SURVIVOR ${pid} -> now topic ${d.topic_id} (audit said ${dest}) ${d.created_at?.toDate?.().toISOString?.() ?? ''}`);
  log(`     ${String(d.content ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
}
log(survivors === 0
  ? '  none still exist — they were cascade-deleted with the topic'
  : `  ${survivors} post(s) survived and could be moved back`);


const rtdb = admin.database();
for (const p of [`topic_posts_cache/${TOPIC_ID}`, `main_page_cache/latest_topics/${TOPIC_ID}`]) {
  const s = await rtdb.ref(p).once('value');
  log(`  RTDB ${p}: ${s.exists() ? 'PRESENT' : 'absent'}`);
}
