import { createRequire } from 'node:module';

// Reuse the existing functions dependency; importing this file does not open a
// connection. Caller supplies an explicit project and ADC on the home machine.
export function firebaseSource(projectId) {
  if (!projectId) throw new Error('An explicit Firebase project ID is required');
  const require = createRequire(new URL('../../../functions/package.json', import.meta.url));
  const { initializeApp, applicationDefault, deleteApp } = require('firebase-admin/app');
  const { getFirestore, Timestamp, GeoPoint, DocumentReference, FieldPath } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  const app = initializeApp({ projectId, credential: applicationDefault() }, `migration-${Date.now()}`);
  const db = getFirestore(app);

  // Tagged values avoid precision loss and ambiguity with user-authored objects.
  function encode(value) {
    if (value instanceof Timestamp) return { type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
    if (value instanceof GeoPoint) return { type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    if (value instanceof DocumentReference) return { type: 'reference', path: value.path };
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
    if (typeof value === 'number' && !Number.isFinite(value)) return { type: 'number', value: String(value) };
    if (value === null || typeof value !== 'object') return { type: 'scalar', value };
    if (Array.isArray(value)) return { type: 'array', value: value.map(encode) };
    return { type: 'map', value: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)])) };
  }

  async function* walk(collection) {
    let cursor;
    do {
      let query = collection.orderBy(FieldPath.documentId()).limit(250);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        yield { kind: 'firestore', path: doc.ref.path, data: encode(doc.data()) };
        for (const child of await doc.ref.listCollections()) yield* walk(child);
      }
      cursor = page.docs.at(-1);
      if (page.size < 250) break;
    } while (true);
  }

  return {
    async *records() {
      for (const collection of await db.listCollections()) yield* walk(collection);
      let pageToken;
      do {
        const page = await getAuth(app).listUsers(1000, pageToken);
        for (const user of page.users) {
          // Never export password hashes/salts or refresh tokens.
          yield { kind: 'auth', path: user.uid, data: {
            uid: user.uid, email: user.email ?? null, emailVerified: user.emailVerified,
            disabled: user.disabled, displayName: user.displayName ?? null,
            photoURL: user.photoURL ?? null, providerData: user.providerData,
            customClaims: user.customClaims ?? {}, metadata: user.metadata.toJSON(),
          } };
        }
        pageToken = page.pageToken;
      } while (pageToken);
    },
    close: () => deleteApp(app),
  };
}
