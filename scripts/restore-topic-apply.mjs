// Surgical restore of one deleted topic into Firestore, from restore/plan.json.
//
// SAFETY MODEL
//   * Insert-only. Documents are written with create(), never set()/update(), so
//     anything the forum wrote after the snapshot is never overwritten.
//   * The topic document is created BEFORE the posts: onPostCreated returns
//     early when topics/{id} is missing and would skip every counter and cache
//     update for all 693 posts.
//   * Counters are NOT bumped by hand. onTopicCreated / onPostCreated already
//     increment the category, topic, user and forum_stats counters plus the RTDB
//     mirrors. A manual bump would double-count. This script waits for that
//     chain to settle and then verifies the result.
//   * Post reputation is rebuilt from the LIVE reputation_logs, which survived
//     the cascade and therefore include votes cast after the snapshot.
//   * User reputation is untouched: deleting posts never rolled it back.
//   * Dry run unless --apply is passed.
//
// Credentials: Application Default Credentials
//   firebase login                       (ADC under %APPDATA%\firebase)
//   GOOGLE_APPLICATION_CREDENTIALS=...service-account.json
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PLAN = 'restore/plan.json';
const APPLY = process.argv.includes('--apply');
const WITH_NOTIFICATIONS = process.argv.includes('--restore-notifications');
const BATCH = 400;

if (!fs.existsSync(PLAN)) {
  console.error(`Missing ${PLAN}. Run: node scripts/restore-topic-plan.mjs`);
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const TOPIC_ID = plan.topic.id;

admin.initializeApp({ projectId: plan.project });
const db = admin.firestore();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

log(`plan        : ${PLAN}`);
log(`project     : ${plan.project}`);
log(`topic       : ${TOPIC_ID}  "${plan.topic.title}"`);
log(`mode        : ${APPLY ? 'APPLY (writes to Firestore)' : 'DRY RUN (no writes)'}`);
log(`snapshot    : ${plan.snapshotTakenAt}   <- the restore reaches only this far`);
log(`posts       : ${plan.documents.posts.length}`);

const topicSnap = await db.collection('topics').doc(TOPIC_ID).get();
const livePostCount = (await db.collection('posts').where('topic_id', '==', TOPIC_ID).count().get()).data().count;
const liveLogCount = (await db.collection('reputation_logs').where('topic_id', '==', TOPIC_ID).count().get()).data().count;

log(`\n--- live Firestore ---`);
log(`  topics/${TOPIC_ID} exists : ${topicSnap.exists}`);
log(`  live posts in this topic  : ${livePostCount}`);
log(`  live reputation_logs     : ${liveLogCount} (snapshot has ${plan.documents.reputation_logs.length})`);
if (liveLogCount > plan.documents.reputation_logs.length) {
  log(`    -> ${liveLogCount - plan.documents.reputation_logs.length} vote(s) cast AFTER the snapshot`);
  log(`       survived in Firestore; restored post reputation is rebuilt from them`);
}
if (livePostCount > 0) {
  log(`    ! ${livePostCount} post(s) already carry this topic_id and are left untouched.`);
}

async function partition(collection, entries) {
  const present = [], missing = [];
  for (let i = 0; i < entries.length; i += 300) {
    const chunk = entries.slice(i, i + 300);
    const snaps = await db.getAll(...chunk.map(e => db.collection(collection).doc(e.id)));
    snaps.forEach((s, idx) => (s.exists ? present : missing).push(chunk[idx]));
  }
  return { present, missing };
}

const tPart = await partition('topics', plan.documents.topics);
const pPart = await partition('posts', plan.documents.posts);
const rPart = await partition('reputation_logs', plan.documents.reputation_logs);
const nPart = await partition('notifications', plan.documents.notifications);

log(`\n--- insert-only preview ---`);
log(`  topics          : ${tPart.missing.length} to create, ${tPart.present.length} already there`);
log(`  posts           : ${pPart.missing.length} to create, ${pPart.present.length} already there`);
log(`  reputation_logs : ${rPart.missing.length} to create, ${rPart.present.length} already there`);
log(`  notifications   : ${nPart.missing.length} available (skipped unless --restore-notifications)`);
log(`  The ${nPart.missing.length} deleted notifications are not restored by default:`);
log(`  replaying week-old unread items into inboxes is worse than losing them.`);

if (!APPLY) {
  log(`\n=== DRY RUN COMPLETE — nothing was written ===`);
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
log(`\n=== APPLYING ===`);

const firstPost = plan.documents.posts[0];

// 1. The topic document first, so onPostCreated finds it for every post below.
if (!topicSnap.exists) {
  await db.collection('topics').doc(TOPIC_ID).create({
    ...plan.documents.topics[0].data,
    // The 2026-09-30 fix made createTopic persist first_post_id and the server
    // guard depends on it; the snapshot predates that field, so set it now.
    first_post_id: firstPost.id,
    // Seeded at 0 on purpose: onPostCreated increments once per restored post,
    // and that chain is the single owner of this counter.
    posts_count: 0,
  });
  log(`  topics/${TOPIC_ID} created (posts_count seeded 0, first_post_id=${firstPost.id})`);
} else {
  log(`  topics/${TOPIC_ID} already exists — left in place`);
}

// 2. Posts. Each create() fires onPostCreated, which owns the counters and the
//    RTDB topic_posts_cache / post_voters mirrors.
const createdPosts = [];
for (let i = 0; i < pPart.missing.length; i += BATCH) {
  const chunk = pPart.missing.slice(i, i + BATCH);
  const batch = db.batch();
  for (const e of chunk) batch.create(db.collection('posts').doc(e.id), e.data);
  await batch.commit();
  createdPosts.push(...chunk);
  log(`  posts: ${Math.min(i + BATCH, pPart.missing.length)}/${pPart.missing.length}`);
}

// 3. reputation_logs. The cascade never removed these, so usually nothing to do.
for (let i = 0; i < rPart.missing.length; i += BATCH) {
  const chunk = rPart.missing.slice(i, i + BATCH);
  const batch = db.batch();
  for (const e of chunk) batch.create(db.collection('reputation_logs').doc(e.id), e.data);
  await batch.commit();
}
log(`  reputation_logs created: ${rPart.missing.length}`);

if (WITH_NOTIFICATIONS) {
  for (let i = 0; i < nPart.missing.length; i += BATCH) {
    const chunk = nPart.missing.slice(i, i + BATCH);
    const batch = db.batch();
    for (const e of chunk) batch.create(db.collection('notifications').doc(e.id), { ...e.data, read: true });
    await batch.commit();
  }
  log(`  notifications created: ${nPart.missing.length} (marked read)`);
}

// ── Rebuild post reputation from the LIVE reputation_logs ────────────────────
// The snapshot's posts[].reputation stops at 2026-09-18, but the logs survived
// the cascade and carry every vote since. Summing them per post makes the
// restored posts carry the reputation they had right before deletion.
const logSnaps = await db.collection('reputation_logs').where('topic_id', '==', TOPIC_ID).get();
const repByPost = new Map();
for (const s of logSnaps.docs) {
  const d = s.data();
  if (d.applied === false) continue;
  repByPost.set(d.post_id, (repByPost.get(d.post_id) || 0) + Number(d.value || 0));
}
log(`\n  reputation: ${logSnaps.size} live logs across ${repByPost.size} posts`);

const allPostIds = plan.documents.posts.map(p => p.id);
for (let i = 0; i < allPostIds.length; i += 400) {
  const chunk = allPostIds.slice(i, i + 400);
  const snaps = await db.getAll(...chunk.map(id => db.collection('posts').doc(id)));
  const batch = db.batch();
  let patched = 0;
  snaps.forEach((s, idx) => {
    if (!s.exists) return;
    const want = repByPost.get(chunk[idx]) || 0;
    if ((s.data().reputation || 0) === want) return;
    batch.update(s.ref, { reputation: want });
    patched++;
  });
  if (patched) { await batch.commit(); }
  log(`  reputation patched: ${pPart.missing.length ? patched : 0} of ${chunk.length}`);
}

// ── Let the trigger chain settle, then verify ────────────────────────────────
// 693 onPostCreated invocations at maxInstances:10 take a while. Poll the topic
// document until posts_count stops moving and matches the real document count.
log(`\n=== waiting for onTopicCreated / onPostCreated to settle ===`);
const expected = (await db.collection('posts').where('topic_id', '==', TOPIC_ID).count().get()).data().count;
let last = -1, stableFor = 0, waited = 0;
while (waited < 15 * 60 * 1000) {
  const s = await db.collection('topics').doc(TOPIC_ID).get();
  const now = s.exists ? (s.data().posts_count || 0) : -1;
  if (now === last && now === expected) { if (++stableFor >= 3) break; }
  else { stableFor = 0; last = now; }
  process.stdout.write(`\r  posts_count=${now} expected=${expected}  (${Math.round(waited / 1000)}s)`);
  await sleep(5000);
  waited += 5000;
}
process.stdout.write('\n');

const finalTopic = (await db.collection('topics').doc(TOPIC_ID).get()).data();
const cat = (await db.collection('categories').doc(plan.topic.category_id).get()).data();
const stats = (await db.collection('forum_stats').doc('global').get()).data();
const author = (await db.collection('users').doc(plan.topic.author_id).get()).data();

log(`\n=== VERIFICATION ===`);
log(`  posts restored        : ${createdPosts.length} created this run`);
log(`  posts in topic (live) : ${expected}`);
log(`  topic.posts_count     : ${finalTopic.posts_count}  ${finalTopic.posts_count === expected ? 'OK' : 'MISMATCH'}`);
log(`  topic.first_post_id   : ${finalTopic.first_post_id}  ${finalTopic.first_post_id === firstPost.id ? 'OK' : 'MISMATCH'}`);
log(`  category.posts_count  : ${cat?.posts_count}`);
log(`  category.topics_count : ${cat?.topics_count}`);
log(`  forum_stats.total_posts  : ${stats?.total_posts}`);
log(`  forum_stats.total_topics : ${stats?.total_topics}`);
log(`  author.topics_count   : ${author?.topics_count}`);
log(`  author.post_count     : ${author?.post_count}`);
log(`  author.reputation     : ${author?.reputation}  (never rolled back — expected to be unchanged)`);
log(`\n  If any counter shows MISMATCH, re-run with --verify-only to re-check.`);
