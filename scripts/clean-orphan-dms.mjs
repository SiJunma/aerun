// Remove direct-message conversations from Firestore that can never become real
// PocketBase rows because one participant is a GHOST account.
//
// A ghost is a users/{uid} stub left behind when an account was deleted: the
// auth record is gone and the profile was wiped, so the document keeps only
// orphaned leftovers (a readmap subcollection, last_seen) and has NO nickname,
// email or role_id. Such a uid never survives import — the importer skips any
// account without an email (buildUserRow) — so a thread naming a ghost produces
// a dm_conversations shell whose only real member is the other participant. The
// runtime then renders it as an empty "User" that never opens (bug M2).
//
// Deleting the orphan thread here means the shell can never be produced by a
// future re-import.
//
// SAFETY MODEL
//   * Dry run unless --apply is passed: it only reads and prints what it would
//     remove.
//   * A thread is removed ONLY when a participant is a ghost. A conversation
//     whose two members are both real accounts is left untouched even if one
//     side has no messages — an empty chat between two real people is
//     legitimate history, not garbage.
//   * recursiveDelete removes the conversation document AND its messages
//     subcollection in one Firestore delete.
//   * Point-in-time recovery is the only undo. Confirm PITR/backup is enabled
//     before --apply (Firebase console -> Firestore -> Backups).
//
// Credentials: Application Default Credentials
//   firebase login                         (ADC under %APPDATA%\firebase)
//   or  GOOGLE_APPLICATION_CREDENTIALS=...service-account.json
//
// Usage:
//   node scripts/clean-orphan-dms.mjs            # dry run (default)
//   node scripts/clean-orphan-dms.mjs --apply     # delete the orphans
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = process.env.FIREBASE_PROJECT || 'aerun-forum';
const APPLY = process.argv.includes('--apply');

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

// A real account carries at least one identity field. A ghost keeps none of
// them. The document being absent entirely (deleted outright) is also a ghost.
const IDENTITY_FIELDS = ['nickname', 'email', 'role_id'];

function classifyUser(doc) {
  if (!doc || !doc.exists) return { ghost: true, present: [] };
  const data = doc.data();
  const present = IDENTITY_FIELDS.filter(
    (f) => data[f] != null && String(data[f]).trim() !== ''
  );
  return { ghost: present.length === 0, present };
}

async function main() {
  console.log(`project : ${PROJECT}`);
  console.log(`mode    : ${APPLY ? 'APPLY (deletes from Firestore)' : 'DRY RUN (reads only)'}\n`);

  // --- index every user document by uid -----------------------------------
  const usersSnap = await db.collection('users').get();
  const userDocs = new Map(usersSnap.docs.map((d) => [d.id, d]));
  const ghostUIDs = [...userDocs.values()].filter((d) => classifyUser(d).ghost).map((d) => d.id);
  console.log(`users   : ${userDocs.size} scanned, ${ghostUIDs.length} ghost stub(s) (${ghostUIDs.join(', ') || 'none'})\n`);

  // --- scan conversations -------------------------------------------------
  const dmsSnap = await db.collection('dms').get();
  const orphans = [];
  for (const doc of dmsSnap.docs) {
    let participants = doc.data().participants;
    if (!Array.isArray(participants)) {
      // Fall back to the legacy "<uidA>_<uidB>" document id when the field is
      // missing or malformed. Firebase uids are alphanumeric, so the single
      // underscore is an unambiguous separator.
      participants = doc.id.split('_');
    }
    participants = participants.map((u) => String(u)).filter(Boolean);
    const ghosts = participants.filter((uid) => {
      // Absent from users/ is a ghost too.
      if (!userDocs.has(uid)) return true;
      return classifyUser(userDocs.get(uid)).ghost;
    });
    if (ghosts.length > 0) {
      orphans.push({ id: doc.id, participants, ghosts });
    }
  }

  console.log(`dms     : ${dmsSnap.size} conversations scanned`);
  console.log(`orphans : ${orphans.length} conversation(s) reference a ghost account\n`);

  if (orphans.length === 0) {
    console.log('Nothing to remove.');
    return;
  }

  for (const o of orphans) {
    console.log(`  dms/${o.id}`);
    console.log(`     participants : ${o.participants.join(' + ')}`);
    for (const g of o.ghosts) {
      const c = userDocs.has(g) ? classifyUser(userDocs.get(g)) : { present: [] };
      console.log(`     ghost member : ${g}  (${userDocs.has(g) ? 'stub, no nickname/email/role_id' : 'users/{uid} absent'})`);
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN complete. Nothing was deleted.`);
    console.log(`Re-run with --apply to remove the ${orphans.length} orphan conversation(s) and their`);
    console.log(`messages subcollection. Ensure PITR/backup is enabled first (Firebase console -> Backups).`);
    return;
  }

  const { recursiveDelete } = require('firebase-admin/firestore');
  console.log(`\nDeleting ${orphans.length} orphan conversation(s) (document + messages subcollection)...`);
  let done = 0;
  for (const o of orphans) {
    await recursiveDelete(db.doc(`dms/${o.id}`));
    console.log(`  deleted dms/${o.id}`);
    done++;
  }
  console.log(`\nDone. ${done} orphan conversation(s) removed.`);
}

main()
  .then(() => admin.app().delete())
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
