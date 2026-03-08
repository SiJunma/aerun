/* global process */
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, collection, addDoc } from 'firebase/firestore';
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

async function seed() {
  console.log('--- Initializing Firestore Structure ---');

  // 1. Global Settings
  const settingsRef = doc(db, 'settings', 'global');
  await setDoc(settingsRef, {
    forumName: 'Aerun Forum',
    registrationEnabled: true,
    maxUploadSize: 500,
    maintenanceMode: false,
    welcomeMessage: 'Welcome to Aerun! A private home for our TTRPG adventures.',
    enableReputation: true,
    enableCharacters: true,
    enableDice: true,
    logoUrl: ''
  });
  console.log('✅ Global settings initialized');

  // 2. Initial Categories
  const categories = [
    { title: 'General Discussion', description: 'Talk about anything and everything.', order: 1, icon: 'chat-dots' },
    { title: 'In-Game (IC)', description: 'Where the stories happen.', order: 2, icon: 'shield-shaded' },
    { title: 'Out-of-Game (OOC)', description: 'Technical talk, character sheets, and rules.', order: 3, icon: 'gear' }
  ];

  for (const cat of categories) {
    const catRef = await addDoc(collection(db, 'categories'), cat);
    console.log(`✅ Category "${cat.title}" created (ID: ${catRef.id})`);
  }

  console.log('--- Initialization Complete ---');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Error during initialization:', err);
  process.exit(1);
});
