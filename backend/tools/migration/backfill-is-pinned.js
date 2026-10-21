/* global process */
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, writeBatch } from 'firebase/firestore';
import fs from 'fs';
import path from 'path';

// Manual .env.local parsing
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) env[key.trim()] = value.trim();
});

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function backfill() {
  const snap = await getDocs(collection(db, 'topics'));
  const missing = snap.docs.filter(d => d.data().is_pinned === undefined);
  console.log(`Found ${missing.length} topics missing is_pinned`);
  
  for (let i = 0; i < missing.length; i += 400) {
    const batch = writeBatch(db);
    missing.slice(i, i + 400).forEach(d => batch.update(d.ref, { is_pinned: false }));
    await batch.commit();
    console.log(`Committed batch ${Math.floor(i/400) + 1}`);
  }
  console.log(`Backfilled ${missing.length} topics`);
  process.exit(0);
}

backfill().catch(err => {
  console.error(err);
  process.exit(1);
});