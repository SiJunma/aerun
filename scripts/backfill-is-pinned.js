// scripts/backfill-is-pinned.js — run once with admin credentials
const snap = await db.collection('topics').get();
const missing = snap.docs.filter(d => d.data().is_pinned === undefined);
for (let i = 0; i < missing.length; i += 400) {
  const batch = db.batch();
  missing.slice(i, i + 400).forEach(d => batch.update(d.ref, { is_pinned: false }));
  await batch.commit();
}
console.log(`backfilled ${missing.length} topics`);