import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, browserLocalPersistence, setPersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Boolean to check if storage is enabled (has a bucket name configured)
export const isStorageEnabled = !!firebaseConfig.storageBucket;

// Initialize services
export const auth = getAuth(app);
// Explicitly set persistence to LOCAL so the session survives tab freezes,
// browser restarts, and multi-tab scenarios (browsers with many open tabs
// may otherwise discard the session token when throttling background tabs).
setPersistence(auth, browserLocalPersistence).catch(e => console.warn('[Auth persistence]', e));
export const db = getFirestore(app);
export const storage = isStorageEnabled ? getStorage(app) : null;
export const functions = getFunctions(app);
export const googleProvider = new GoogleAuthProvider();

// Initialize App Check (helps prevent bot attacks and unauthorized API access)
if (import.meta.env.VITE_RECAPTCHA_SITE_KEY) {
  // In development, enable debug mode to allow localhost testing.
  // Check browser console for the debug token and add it to Firebase Console -> App Check -> Manage debug tokens.
  if (import.meta.env.DEV) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(import.meta.env.VITE_RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}

export default app;