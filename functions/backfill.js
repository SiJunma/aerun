const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'aerun-forum' });
const db = admin.firestore();

async function backfill() {
  const snap = await db.collection('topics').get();
  const missing = snap.docs.filter(d => d.data().is_pinned === undefined);
  console.log(`Found ${missing.length} topics missing is_pinned`);
  
  for (let i = 0; i < missing.length; i += 400) {
    const batch = db.batch();
    missing.slice(i, i + 400).forEach(d => batch.update(d.ref, { is_pinned: false }));
    await batch.commit();
    console.log(`Committed batch ${Math.floor(i/400) + 1}`);
  }
  console.log(`Backfilled ${missing.length} topics`);
}

backfill().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
