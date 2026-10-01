// Reconciles every denormalised counter against an authoritative Firestore
// count. Read-only. Run after a restore: the restore itself relies on the
// onPostCreated / onTopicCreated chain, and this proves the chain landed.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const plan = JSON.parse(fs.readFileSync('restore/plan.json', 'utf8'));
const TOPIC_ID = plan.topic.id;
const CATEGORY_ID = plan.topic.category_id;
admin.initializeApp({
  projectId: plan.project,
  databaseURL: `https://${plan.project}-default-rtdb.firebaseio.com`,
});
const db = admin.firestore();
const log = (...a) => console.log(...a);

const count = async (coll, field, value) =>
  (await db.collection(coll).where(field, '==', value).count().get()).data().count;

const check = (label, real, stored) => {
  const ok = real === stored;
  log(`  ${label.padEnd(42)} real=${String(real).padStart(5)}  stored=${String(stored).padStart(5)}  ${ok ? 'OK' : 'MISMATCH' + (stored - real > 0 ? ` (+${stored - real})` : ` (${stored - real})`)}`);
  return ok;
};

let bad = 0;

log(`=== topic ${TOPIC_ID} "${plan.topic.title}" ===`);
const t = (await db.collection('topics').doc(TOPIC_ID).get()).data();
const topicPosts = await count('posts', 'topic_id', TOPIC_ID);
if (!check('topic.posts_count', topicPosts, t.posts_count)) bad++;
const newest = (await db.collection('posts').where('topic_id', '==', TOPIC_ID).orderBy('created_at', 'desc').limit(1).get()).docs[0];
log(`  newest post                        ${newest.id} ${newest.data().created_at.toDate().toISOString()}`);
log(`  last_post_at on topic               ${t.last_post_at?.toDate?.().toISOString?.() ?? t.last_post_at}`);
log(`  first_post_id                       ${t.first_post_id}`);

log(`\n=== category ${CATEGORY_ID} ===`);
const cat = (await db.collection('categories').doc(CATEGORY_ID).get()).data();
if (!check('categories.posts_count', await count('posts', 'category_id', CATEGORY_ID), cat.posts_count)) bad++;
if (!check('categories.topics_count', await count('topics', 'category_id', CATEGORY_ID), cat.topics_count)) bad++;

log(`\n=== forum_stats/global ===`);
const stats = (await db.collection('forum_stats').doc('global').get()).data();
if (!check('forum_stats.total_posts', await db.collection('posts').count().get().then(s => s.data().count), stats.total_posts)) bad++;
if (!check('forum_stats.total_topics', await db.collection('topics').count().get().then(s => s.data().count), stats.total_topics)) bad++;

log(`\n=== authors of the restored topic ===`);
const all = await db.collection('posts').where('topic_id', '==', TOPIC_ID).select('author_id').get();
const byAuthor = new Map();
for (const d of all.docs) byAuthor.set(d.data().author_id, (byAuthor.get(d.data().author_id) || 0) + 1);
for (const uid of [...byAuthor.keys()].sort()) {
  const u = (await db.collection('users').doc(uid).get()).data();
  if (!check(`  ${u?.nickname ?? uid} post_count`, await count('posts', 'author_id', uid), u?.post_count)) bad++;
}
const topicAuthor = (await db.collection('users').doc(plan.topic.author_id).get()).data();
if (!check(`  ${topicAuthor?.nickname} topics_count`, await count('topics', 'author_id', plan.topic.author_id), topicAuthor?.topics_count)) bad++;

log(`\n=== RTDB caches for the topic ===`);
const rtdb = admin.database();
for (const p of [`topic_posts_cache/${TOPIC_ID}`, `main_page_cache/latest_topics/${TOPIC_ID}`]) {
  const s = await rtdb.ref(p).once('value');
  log(`  ${p}: ${s.exists() ? 'PRESENT' : 'absent'}`);
}

log(`\n=== ${bad === 0 ? 'ALL COUNTERS CONSISTENT' : bad + ' MISMATCH(ES) FOUND'} ===`);
