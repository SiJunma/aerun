// Read-only diagnostic: verify the fate of a deleted topic.
// Uses the Firebase CLI's Application Default Credentials (OAuth user creds)
// to call the Firestore REST API. Never writes.
import { GoogleAuth } from 'google-auth-library';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = process.env.FIREBASE_PROJECT || 'aerun-forum';
const TOPIC_ID = process.argv[2];
if (!TOPIC_ID) {
  console.error('usage: node firestore-inspect.mjs <topicId>');
  process.exit(1);
}

const credDir = path.join(process.env.APPDATA || '', 'firebase');
const credFile = fs.readdirSync(credDir).find(f => f.includes('application_default'));
if (!credFile) { console.error('No ADC file found in', credDir); process.exit(1); }
process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(credDir, credFile);

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/datastore'] });
const client = await auth.getClient();
const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;

async function run(sqlish) {
  const res = await client.request({ url: `${base}/documents:runQuery`, method: 'POST', data: { structuredQuery: sqlish } });
  return (res.data || []).filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    ...r.document.fields,
    updateTime: r.document.updateTime,
    createTime: r.document.createTime,
  }));
}
async function getDoc(coll, id) {
  try {
    const res = await client.request({ url: `${base}/documents/${coll}/${id}`, method: 'GET' });
    return { id, ...res.data.fields, updateTime: res.data.updateTime, createTime: res.data.createTime };
  } catch { return null; }
}

console.log(`=== project: ${PROJECT} ===\n`);

// ── Ensure point-in-time recovery is on ─────────────────────────────────────
// Deleting a topic is an irreversible, cascading operation, so PITR is the
// only safety net. Enable it with the maximum retention (7 days for Standard
// edition) before doing anything else.
if (process.argv.includes('--enable-pitr')) {
  const retentionSeconds = 7 * 24 * 60 * 60;
  try {
    await client.request({
      url: `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)?updateMask=pointInTimeRecoveryEnablement,versionRetentionPeriod`,
      method: 'PATCH',
      data: {
        pointInTimeRecoveryEnablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
        versionRetentionPeriod: `${retentionSeconds}s`,
      },
    });
    console.log(`PITR enabled with ${retentionSeconds / 86400}-day retention.\n`);
  } catch (e) {
    console.log('Could not enable PITR automatically:', e.response?.data?.error?.message || e.message);
    console.log('Enable it manually:\n');
    console.log('  gcloud firestore backups schedules create --database="(default)" \\');
    console.log('    --recurring-daily --retention=7d\n');
    console.log('  or: Firebase console -> Firestore Database -> Backups -> Enable.\n');
  }
}

console.log('--- backup / PITR status ---');
try {
  const res = await client.request({
    url: `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`,
    method: 'GET',
  });
  const d = res.data;
  console.log('  pointInTimeRecoveryEnablement :', d.pointInTimeRecoveryEnablement);
  console.log('  deleteProtectionState         :', d.deleteProtectionState);
  console.log('  versionRetentionPeriod         :', d.versionRetentionPeriod);
  console.log('  earliestVersionTime           :', d.earliestVersionTime);
  console.log('  locationId                    :', d.locationId);
} catch (e) {
  console.log('  could not read database config:', e.message);
}
console.log('');

console.log(`--- topics/${TOPIC_ID} ---`);
const topic = await getDoc('topics', TOPIC_ID);
console.log(topic ? JSON.stringify(topic, null, 2) : '  NOT FOUND (hard-deleted)\n');

console.log(`--- posts where topic_id == ${TOPIC_ID} ---`);
const posts = await run({
  from: [{ collectionId: 'posts' }],
  where: { fieldFilter: { field: { fieldPath: 'topic_id' }, op: 'EQUAL', value: { stringValue: TOPIC_ID } } },
  limit: 500,
});
console.log(posts.length ? JSON.stringify(posts, null, 2) : '  none (cascade-deleted)\n');

console.log(`--- recent audit_logs (any) mentioning the topic id ---`);
const logs = await run({
  from: [{ collectionId: 'audit_logs' }],
  orderBy: [{ field: { fieldPath: 'created_at' }, direction: 'DESCENDING' }],
  limit: 200,
});
const hit = logs.filter(l => JSON.stringify(l).includes(TOPIC_ID));
console.log(`  scanned ${logs.length} recent logs; ${hit.length} reference the topic id`);
hit.forEach(l => console.log('  ', l.id, JSON.stringify(l.actionType || l.action_type), JSON.stringify(l.details || l.payload)));
console.log('');

console.log('--- most recent topic_deleted / post_deleted entries ---');
logs
  .filter(l => JSON.stringify(l).includes('topic_deleted') || JSON.stringify(l).includes('post_deleted'))
  .slice(0, 15)
  .forEach(l => console.log('  ', l.createTime, JSON.stringify(l.actionType || l.action_type), JSON.stringify(l.details || l.payload)));
console.log('');

console.log('--- search topics by title ---');
for (const t of ['Нортбейский мыслефлуд #2', 'Нортбейский мыслефлуд']) {
  const found = await run({
    from: [{ collectionId: 'topics' }],
    where: { fieldFilter: { field: { fieldPath: 'title' }, op: 'EQUAL', value: { stringValue: t } } },
    limit: 20,
  });
  console.log(`  "${t}" -> ${found.length} match(es)`);
  found.forEach(f => console.log('   ', f.id, JSON.stringify(f.title)));
}

// ── Recovery surfaces ───────────────────────────────────────────────────────
// onTopicDeleted removed the RTDB caches too, but check whether anything
// survives elsewhere: a topic that was moved to another topic keeps its posts
// under the *destination* topic_id, and post_voters is keyed per post.
console.log('\n--- RTDB remnants ---');
for (const p of [
  `topic_posts_cache/${TOPIC_ID}`,
  `main_page_cache/latest_topics/${TOPIC_ID}`,
]) {
  try {
    const res = await client.request({ url: `https://firebasedatabase.googleapis.com/v0/b/${PROJECT}.firebasedatabase.app/${p}.json`, method: 'GET' });
    console.log(`  ${p}:`, res.data === null ? 'absent' : JSON.stringify(res.data).slice(0, 200));
  } catch (e) {
    console.log(`  ${p}: not readable (${e.response?.status || e.message})`);
  }
}

console.log('\n--- post_voters for any post id seen in audit logs for this topic ---');
// Audit detail maps arrive as { mapValue: { fields: {...} } } from the REST API.
const auditDetails = l => (l.details?.mapValue?.fields) || (l.details?.fields) || {};
const postIds = new Set();
for (const l of logs) {
  const d = auditDetails(l);
  (d.postIds?.arrayValue?.values || []).forEach(v => v.stringValue && postIds.add(v.stringValue));
}
console.log(`  post ids recorded in the scanned audit logs: ${[...postIds].join(', ') || '(none)'}`);
for (const pid of postIds) {
  try {
    const res = await client.request({ url: `https://firebasedatabase.googleapis.com/v0/b/${PROJECT}.firebasedatabase.app/post_voters/${pid}.json`, method: 'GET' });
    if (res.data) console.log(`  post_voters/${pid}: PRESENT`, JSON.stringify(res.data).slice(0, 120));
  } catch { /* ignore */ }
}
console.log('  (post_voters holds only votes, never post text)');

// ── Posts moved OUT of the deleted topic ────────────────────────────────────
// movePosts rewrites post.topic_id, so anything moved to another topic before
// the deletion was never part of the cascade and its text may still exist.
console.log('\n--- posts moved out of the deleted topic (possible survivors) ---');
// Only post ids that audit records as leaving THIS topic are relevant; other
// ids in the scanned window belong to unrelated topics.
const movedOut = new Set();
for (const l of logs) {
  const d = auditDetails(l);
  const action = l.actionType?.stringValue || l.action?.stringValue;
  const src = d.sourceTopicId?.stringValue;
  if (action === 'posts_moved' && src === TOPIC_ID) {
    (d.postIds?.arrayValue?.values || []).forEach(v => v.stringValue && movedOut.add(v.stringValue));
  }
}
console.log(`  post ids audit records as moved OUT of ${TOPIC_ID}: ${[...movedOut].join(', ') || '(none)'}`);

const survivors = [];
for (const pid of movedOut) {
  const p = await getDoc('posts', pid);
  if (p) {
    survivors.push({ id: p.id, topic_id: p.topic_id?.stringValue, created_at: p.created_at?.timestampValue, content: p.content?.stringValue });
  }
}
if (survivors.length === 0) {
  console.log('  none of them still exist in Firestore (they were cascade-deleted with the topic)');
} else {
  for (const s of survivors) {
    console.log(`  SURVIVOR ${s.id} — now in topic ${s.topic_id} (${s.created_at})`);
    console.log(`     ${String(s.content || '').slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}
