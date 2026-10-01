// Backfills posts.category_id from the owning topic, then reports whether any
// post disagrees with its topic.
//
// Why this matters beyond a counter fix: firestore.rules gates post reads with
//   hasCategoryPermission(resource.data.category_id, 'view_forum')
// and hasCategoryPermission() falls back to the GLOBAL role permission when the
// category document carries no `permissions` map. A post with no category_id
// resolves to an empty category document, hits that fallback, and is therefore
// readable by anyone holding the global view_forum — even when the post really
// lives in a restricted section. So the missing field is also an access-control
// gap, not just a stale denominator.
//
// Read-only unless --apply.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
const PROJECT = 'aerun-forum';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const log = (...a) => console.log(...a);

// ── Topics: the authority for a post's category ──────────────────────────────
const topics = new Map();
for (const t of (await db.collection('topics').get()).docs) topics.set(t.id, t.data());
log(`topics loaded: ${topics.size}`);

const cats = new Map();
for (const c of (await db.collection('categories').get()).docs) cats.set(c.id, c.data());
const gated = [...cats.entries()].filter(([, d]) => d.permissions && Object.keys(d.permissions).length);
log(`categories with an explicit permissions map: ${gated.length}/${cats.size}`);

// ── Walk every post ──────────────────────────────────────────────────────────
const toBackfill = [];   // post missing category_id
const toCorrect = [];    // post has one, but it disagrees with its topic
let scanned = 0, noTopic = 0, topicHasNoCategory = 0, cursor = null;

while (true) {
  let q = db.collection('posts').select('category_id', 'topic_id').limit(500);
  if (cursor) q = q.startAfter(cursor);
  const page = await q.get();
  if (page.empty) break;
  for (const d of page.docs) {
    scanned++;
    const data = d.data();
    const topic = topics.get(data.topic_id);
    if (!topic) { noTopic++; continue; }
    if (!topic.category_id) { topicHasNoCategory++; continue; }
    const want = topic.category_id;
    if (!data.category_id) toBackfill.push({ ref: d.ref, id: d.id, want });
    else if (data.category_id !== want) toCorrect.push({ ref: d.ref, id: d.id, from: data.category_id, want });
  }
  cursor = page.docs.at(-1);
  if (page.size < 500) break;
}

log(`\nposts scanned                : ${scanned}`);
log(`  missing category_id        : ${toBackfill.length}`);
log(`  disagreeing with topic     : ${toCorrect.length}`);
log(`  orphan (topic not found)   : ${noTopic}`);
log(`  topic itself has no category: ${topicHasNoCategory}`);

// ── Security impact of the gap being closed ─────────────────────────────────
const gatedBackfilled = toBackfill.filter(p => {
  const c = cats.get(p.want);
  return c && c.permissions && Object.keys(c.permissions).length;
});
log(`\nsecurity: ${gatedBackfilled.length} of the backfilled posts belong to categories that`);
log(`carry an explicit permissions map — those were readable via the global`);
log(`view_forum fallback and become correctly gated after the backfill.`);
const byCat = new Map();
for (const p of gatedBackfilled) byCat.set(p.want, (byCat.get(p.want) || 0) + 1);
for (const [cid, n] of byCat) {
  const c = cats.get(cid);
  const t = (c.title && typeof c.title === 'object') ? (c.title.ru ?? c.title.en) : c.title;
  log(`    ${String(t).padEnd(22)} ${cid}  ${n} post(s)`);
}

// ── A sample of the disagreements ────────────────────────────────────────────
// posts.category_id must equal its topic's (firestore.rules enforces that on
// create), so a mismatch is a violated invariant, not a legitimate state.
if (toCorrect.length) {
  const nameOf = (cid) => {
    const c = cats.get(cid);
    if (!c) return '(missing category)';
    const t = (c.title && typeof c.title === 'object') ? (c.title.ru ?? c.title.en) : c.title;
    return `${t}`;
  };
  log(`\nsample of ${Math.min(8, toCorrect.length)} disagreements:`);
  for (const p of toCorrect.slice(0, 8)) {
    const post = (await db.collection('posts').doc(p.id).get()).data();
    const topic = topics.get(post.topic_id);
    log(`  post ${p.id}`);
    log(`     post.category_id = ${nameOf(p.from)}`);
    log(`     topic.category_id= ${nameOf(p.want)}  (topic ${post.topic_id} "${String(topic.title).slice(0, 40)}")`);
  }
  const pairs = new Map();
  for (const p of toCorrect) {
    const k = `${p.from} -> ${p.want}`;
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  log(`\n  all disagreements (from -> to : count):`);
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
    const [from, to] = k.split(' -> ');
    log(`    ${String(nameOf(from)).padEnd(20)} -> ${String(nameOf(to)).padEnd(20)} ${n}`);
  }
}

if (!APPLY) {
  log(`\n=== DRY RUN COMPLETE — nothing written. Re-run with --apply ===`);
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────────
for (let i = 0; i < toBackfill.length; i += 400) {
  const chunk = toBackfill.slice(i, i + 400);
  const b = db.batch();
  for (const p of chunk) b.update(p.ref, { category_id: p.want });
  await b.commit();
}
log(`\nbackfilled ${toBackfill.length} post(s).`);

if (toCorrect.length) {
  for (let i = 0; i < toCorrect.length; i += 400) {
    const chunk = toCorrect.slice(i, i + 400);
    const b = db.batch();
    for (const p of chunk) b.update(p.ref, { category_id: p.want });
    await b.commit();
  }
  log(`corrected ${toCorrect.length} post(s) that disagreed with their topic.`);
}
log(`Now re-run: node scripts/recompute-counters.mjs --apply --include-categories`);
