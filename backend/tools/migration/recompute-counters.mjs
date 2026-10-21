// Recomputes every denormalised post/topic counter from authoritative document
// counts.
//
// Why this is needed: onTopicDeleted cascades post deletes, and onPostDeleted
// returns early for those (functions/index.js ~line 2821, "skip counters for
// cascade/orphan post") because the topic document is already gone. So the
// deletion never decremented users.post_count, while onPostCreated DID
// increment it for every post that the restore re-created. The counters were
// already drifting before the incident; the restore added to the drift.
// The invariant the triggers maintain is "one increment per document", so the
// document count is the correct value.
//
// Read-only unless --apply. Prints a full before/after table either way.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const INCLUDE_CATEGORIES = process.argv.includes('--include-categories');
const PROJECT = 'aerun-forum';
admin.initializeApp({
  projectId: PROJECT,
  // .env.production leaves VITE_FIREBASE_DATABASE_URL unset, so the client falls
  // back to the default instance name; admin SDK needs it stated explicitly.
  databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com`,
});
const db = admin.firestore();
const log = (...a) => console.log(...a);

const count = async (coll, field, value) =>
  (await db.collection(coll).where(field, '==', value).count().get()).data().count;
const total = async (coll) => (await db.collection(coll).count().get()).data().count;

log(`mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
log(`project: ${PROJECT}\n`);

// ── Completeness guard ───────────────────────────────────────────────────────
// The per-field counters are only trustworthy when every document carries the
// field being counted. Posts always carry author_id and topic_id, so user
// counters are a clean partition. They do NOT always carry category_id (702 of
// 3156 posts have none), so a per-category document count understates reality
// and must never be written back.
async function completeness(coll, field) {
  let total = 0, missing = 0, cursor = null;
  while (true) {
    let q = db.collection(coll).select(field).limit(500);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    if (page.empty) break;
    for (const d of page.docs) { total++; if (!d.data()[field]) missing++; }
    cursor = page.docs.at(-1);
    if (page.size < 500) break;
  }
  return { total, missing };
}
for (const [coll, field] of [['posts', 'author_id'], ['posts', 'topic_id'], ['topics', 'author_id']]) {
  const { total, missing } = await completeness(coll, field);
  log(`guard: ${coll}.${field} present on ${total - missing}/${total}`);
  if (missing > 0 && coll === 'posts' && field === 'author_id') {
    log('  ! posts without author_id exist — user counters would be wrong. Aborting.');
    process.exit(1);
  }
}
const catGuard = await completeness('posts', 'category_id');
log(`guard: posts.category_id present on ${catGuard.total - catGuard.missing}/${catGuard.total}` +
  `${catGuard.missing ? `  -> ${catGuard.missing} posts are uncategorised` : ''}`);
log('');

const updates = [];   // { ref, field, from, to }
const report = [];
// Titles and nicknames are stored as maps ({en, ru}) in this schema, so always
// coerce before padding. forEach(log) would pass the array index as a second
// console.log argument, so each line is logged explicitly.
const label = (v, id, n) => {
  // Titles/nicknames are stored as maps ({en, ru}); show the Russian one.
  const t = (v && typeof v === 'object') ? (v.ru ?? v.en ?? Object.values(v)[0] ?? '') : v;
  return `${String(t ?? id).slice(0, n - 8).padEnd(n - 8)} ${id.slice(0, 7)}`;
};

// ── Users: post_count + topics_count ─────────────────────────────────────────
const users = await db.collection('users').get();
log(`=== users (${users.size}) ===`);
for (const u of users.docs) {
  const d = u.data();
  const realPosts = await count('posts', 'author_id', u.id);
  const realTopics = await count('topics', 'author_id', u.id);
  const changes = [];
  if ('post_count' in d && d.post_count !== realPosts) changes.push(['post_count', d.post_count, realPosts]);
  if ('topics_count' in d && d.topics_count !== realTopics) changes.push(['topics_count', d.topics_count, realTopics]);
  if (!changes.length) continue;
  for (const [field, from, to] of changes) updates.push({ ref: u.ref, field, from, to });
  report.push(`  ${label(d.nickname, u.id, 14)} ${changes.map(([f, a, b]) => `${f} ${a} -> ${b}`).join(', ')}`);
}
if (!report.length) log('  all user counters already correct');
else for (const line of report) log(line);

// ── Categories: SKIPPED unless explicitly requested ─────────────────────────
// Writing a per-category document count back would blank out real sections:
// «Архив» claims 1316 posts but 0 carry its category_id, «Информация по миру»,
// «Организаторская», «Дисскуссии» and others would all drop to 0 because their
// posts simply predate the category_id field. These counters need a data
// backfill, not a recompute.
const cats = await db.collection('categories').get();
log(`=== categories (${cats.size}) — ${INCLUDE_CATEGORIES ? 'INCLUDED' : 'SKIPPED'} ===`);
if (!INCLUDE_CATEGORIES) {
  log(`  ${catGuard.missing} posts carry no category_id, so per-category document counts`);
  log(`  understate reality. Recomputing would show real sections as empty.`);
  log(`  Pass --include-categories only after backfilling posts.category_id.`);
} else {
  const catReport = [];
  for (const c of cats.docs) {
    const d = c.data();
    const realPosts = await count('posts', 'category_id', c.id);
    const realTopics = await count('topics', 'category_id', c.id);
    const changes = [];
    if (d.posts_count !== realPosts) changes.push(['posts_count', d.posts_count, realPosts]);
    if (d.topics_count !== realTopics) changes.push(['topics_count', d.topics_count, realTopics]);
    if (!changes.length) continue;
    for (const [field, from, to] of changes) updates.push({ ref: c.ref, field, from, to });
    catReport.push(`  ${label(d.title, c.id, 30)} ${changes.map(([f, a, b]) => `${f} ${a} -> ${b}`).join(', ')}  (topics ${realTopics})`);
  }
  if (!catReport.length) log('  all category counters already correct');
  else for (const line of catReport) log(line);
}

// ── forum_stats/global ───────────────────────────────────────────────────────
const statsRef = db.collection('forum_stats').doc('global');
const stats = (await statsRef.get()).data() ?? {};
const realTotalPosts = await total('posts');
const realTotalTopics = await total('topics');
const statChanges = [];
if (stats.total_posts !== realTotalPosts) statChanges.push(['total_posts', stats.total_posts, realTotalPosts]);
if (stats.total_topics !== realTotalTopics) statChanges.push(['total_topics', stats.total_topics, realTotalTopics]);
for (const [field, from, to] of statChanges) updates.push({ ref: statsRef, field, from, to });
log(`\n=== forum_stats/global ===`);
log(statChanges.length
  ? statChanges.map(([f, a, b]) => `  ${f} ${a} -> ${b}`).join('\n')
  : '  already correct');

log(`\n${updates.length} counter field(s) differ from the document counts.`);
if (!APPLY) {
  log(`\n=== DRY RUN COMPLETE — nothing written. Re-run with --apply ===`);
  process.exit(0);
}

const byRef = new Map();
for (const u of updates) {
  if (!byRef.has(u.ref.path)) byRef.set(u.ref.path, { ref: u.ref, fields: {} });
  byRef.get(u.ref.path).fields[u.field] = u.to;
}
let done = 0;
for (const { ref, fields } of byRef.values()) {
  await ref.update(fields);
  done++;
}
log(`\nupdated ${done} document(s) covering ${updates.length} counter field(s).`);

// ── Mirror into the RTDB main-page cache ─────────────────────────────────────
// Only the counters actually written above are mirrored. Re-deriving every
// category here would push the unreliable per-category counts into the cache
// that the main page reads from.
const rtdb = admin.database();
const touchedCategories = cats.docs.filter(c => byRef.has(c.ref.path));
if (touchedCategories.length) {
  const catUpdates = {};
  for (const c of touchedCategories) {
    catUpdates[c.id] = {
      posts_count: (await c.ref.get()).data().posts_count,
      topics_count: (await c.ref.get()).data().topics_count,
    };
  }
  await rtdb.ref('main_page_cache/categories').update(catUpdates);
  log(`RTDB main_page_cache: mirrored ${touchedCategories.length} changed categor(y/ies).`);
} else {
  log(`RTDB main_page_cache: no category counters were changed, cache left alone.`);
}
// Global totals are derived from collection counts, which are reliable, so the
// stats mirror is always written even on a run that changed nothing.
await rtdb.ref('main_page_cache/stats').update({
  total_posts: realTotalPosts,
  total_topics: realTotalTopics,
});
log(`RTDB main_page_cache/stats mirrored (total_posts=${realTotalPosts}, total_topics=${realTotalTopics}).`);
