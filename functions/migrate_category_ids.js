const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

async function backfillCategoryIds() {
  console.log('Starting category_id backfill for posts...');
  let totalProcessed = 0;
  let updatedCount = 0;

  // Cache topics to minimize reads
  const topicCache = {};

  const postsRef = db.collection('posts');
  
  // We process in batches to avoid overwhelming memory
  const snapshot = await postsRef.get();
  const docs = snapshot.docs;
  console.log(`Found ${docs.length} posts to process.`);

  const batchSize = 100;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + batchSize);
    let batchUpdates = 0;

    for (const doc of chunk) {
      const data = doc.data();
      totalProcessed++;
      
      // Skip if already has category_id
      if (data.category_id) continue;

      const topicId = data.topic_id;
      if (!topicId) continue; // corrupted post

      if (!topicCache[topicId]) {
        const topicSnap = await db.collection('topics').doc(topicId).get();
        if (topicSnap.exists) {
          topicCache[topicId] = topicSnap.data().category_id;
        } else {
          topicCache[topicId] = null;
        }
      }

      const catId = topicCache[topicId];
      if (catId) {
        batch.update(doc.ref, { category_id: catId });
        batchUpdates++;
        updatedCount++;
      }
    }

    if (batchUpdates > 0) {
      await batch.commit();
      console.log(`Committed batch: updated ${batchUpdates} posts. Total processed: ${totalProcessed}/${docs.length}`);
    }
  }

  console.log(`Migration complete. Processed: ${totalProcessed}. Updated: ${updatedCount}.`);
}

backfillCategoryIds()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
