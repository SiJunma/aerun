/* global process */
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, updateDoc, doc } from 'firebase/firestore';
import fs from 'fs';
import path from 'path';

// Manual .env / .env.local parsing
const parseEnv = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length > 0) {
      // Remove inline comments and trim
      let val = rest.join('=').split('#')[0].trim();
      // Remove quotes if present
      val = val.replace(/^["'](.*)["']$/, '$1');
      env[key.trim()] = val;
    }
  });
  return env;
};

// Merge .env and .env.local
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');
const env = { ...parseEnv(envPath), ...parseEnv(envLocalPath) };

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

async function migrateStatusToRoles() {
  console.log('--- Starting migration from status to roles ---');
  
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    let migratedCount = 0;
    
    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      const updates = {};
      
      // If user has a legacy status but no matching role_id mapping
      if (data.status === 'banned' && data.role_id !== 'banned') {
        updates.role_id = 'banned';
        updates.previous_role_id = data.role_id || 'player';
      } else if (data.status === 'pending' && data.role_id !== 'pending') {
        updates.role_id = 'pending';
      }
      
      if (Object.keys(updates).length > 0) {
        console.log(`Migrating user ${data.email} (${userDoc.id}). Updates:`, updates);
        await updateDoc(doc(db, 'users', userDoc.id), updates);
        migratedCount++;
      }
    }
    
    console.log(`--- Migration complete. Migrated ${migratedCount} users. ---`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrateStatusToRoles();
