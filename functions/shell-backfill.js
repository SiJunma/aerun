const admin = require('firebase-admin');

async function run() {
  const db = admin.firestore();
  const snap = await db.collection('topics').get();
  const missing = snap.docs.filter(d => d.data().is_pinned === undefined);
  
  console.log(`Found ${missing.length} topics missing is_pinned`);
  if (missing.length === 0) {
    console.log('Nothing to do!');
    return;
  }
  
  let count = 0;
  for (let i = 0; i < missing.length; i += 400) {
    const batch = db.batch();
    missing.slice(i, i + 400).forEach(d => batch.update(d.ref, { is_pinned: false }));
    await batch.commit();
    count += missing.slice(i, i + 400).length;
    console.log(`Committed batch ${Math.floor(i/400) + 1}`);
  }
  console.log(`Successfully backfilled ${count} topics!`);
}

run();
