// Purge every trace of specific GHOST accounts from Firestore.
//
// WHY a dedicated script instead of extending clean-orphan-dms.mjs:
//   clean-orphan-dms.mjs AUTO-detects ghosts (a users/{uid} with no
//   nickname/email/role_id) and drops their DM threads. That is a heuristic and
//   could one day touch a half-created real account. This script takes an
//   EXPLICIT list of uids the owner has decided to erase, and sweeps every
//   collection for references to them. An explicit list is the safe direction
//   for an irreversible delete.
//
// WHAT a ghost is (INPROGRESS_GHOST_USER_CLEANUP plan, section A):
//   a users/{uid} stub left when an account was deleted without a cascade.
//   The auth record is gone, the profile is wiped, so the document keeps only
//   orphaned leftovers (last_seen, a readmap subcollection). Such a uid never
//   survives import (buildUserRow skips accounts with no email), so every
//   reference to it becomes either an invisible PocketBase shell (bug M2, the
//   empty "User" conversation) or, for reputation_votes / notifications, an
//   unresolved Required foreign key that the importer reports as a failure.
//   Erasing the uid from Firestore is what makes the next re-import clean.
//
// TARGETS for this run (owner decision, plan I1 = option C-a):
//   aCetMfSLI1RvsSsL56XiF3EIe412  ghost stub of a deleted predecessor of Kieran
//   BqWoHwU8z2Wx4wzmbCAHTTusU3p1  already removed from users/, kept for sweep
//
// WHAT IS DELETED (per uid):
//   users/{uid}                        recursiveDelete -> doc + readmap/characters/drafts subcollections
//   dms/*        where participants[]  recursiveDelete -> thread + messages subcollection
//   notifications     recipient_uid == uid
//   reputation_logs   target_id == uid || voter_id == uid   (unresolved FK after the ghost is gone)
//   topic_subscriptions user_id == uid
//   posts  author_id == uid            expected 0 - the ghosts wrote nothing
//   topics author_id == uid            expected 0
//   guest_activity/{uid}               expected absent
//
// WHAT IS NEVER DELETED:
//   audit_logs - append-only forensic ledger. A user_registered record for a
//   since-deleted account is exactly the kind of history an audit log exists to
//   keep. It is only REPORTED (performer_id / actor_uid == uid).
//
// SAFETY MODEL (mirrors restore-topic-apply.mjs):
//   * Dry run unless --apply is passed: reads and prints only.
//   * recursiveDelete removes a document AND its subcollections in one call.
//   * Point-in-time recovery is the only undo. Confirm PITR/backup is enabled
//     before --apply (Firebase console -> Firestore -> Backups).
//
// Credentials, in order:
//   GOOGLE_APPLICATION_CREDENTIALS=...service-account.json   (ADC)
//   else  .secrets/aerun-forum-1bbc6985f333.json              (repo service account)
//
// Usage:
//   node scripts/clean-ghost-users.mjs            # dry run (default)
//   node scripts/clean-ghost-users.mjs --apply     # delete the traces
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = process.env.FIREBASE_PROJECT || 'aerun-forum';
const APPLY = process.argv.includes('--apply');

const TARGET_UIDS = [
  'aCetMfSLI1RvsSsL56XiF3EIe412',
  'BqWoHwU8z2Wx4wzmbCAHTTusU3p1',
];

// --- credentials ----------------------------------------------------------
function resolveCredential() {
  const envKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const repoKey = path.join(process.cwd(), '.secrets', 'aerun-forum-1bbc6985f333.json');
  const keyPath = envKey || (fs.existsSync(repoKey) ? repoKey : null);
  if (!keyPath) {
    console.error('No credentials. Set GOOGLE_APPLICATION_CREDENTIALS or run `firebase login`.');
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  console.log(`creds   : ${envKey ? envKey : '.secrets/aerun-forum-1bbc6985f333.json'}`);
  return admin.credential.cert(sa);
}

admin.initializeApp({ projectId: PROJECT, credential: resolveCredential() });
const db = admin.firestore();
const log = (...a) => console.log(...a);

// A ref plus a label, so the delete loop can print a meaningful path.
// kind: 'recursive' uses recursiveDelete (doc + subcollections);
//       'plain' uses a single .delete() (leaf document).
function collect(refs, kind, label, ref) {
  refs.push({ kind, label, ref });
}

async function main() {
  log(`project : ${PROJECT}`);
  log(`mode    : ${APPLY ? 'APPLY (deletes from Firestore)' : 'DRY RUN (reads only)'}`);
  log(`targets : ${TARGET_UIDS.join(', ')}\n`);

  const refs = [];        // things to delete
  const keepAudit = [];   // audit rows we report but never delete

  for (const uid of TARGET_UIDS) {
    log(`── uid ${uid} ─────────────────────────────`);

    // 1. users/{uid} - the ghost stub itself (+ readmap/characters/drafts).
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      const subcolls = (await userRef.listCollections()).map((c) => c.id);
      log(`  users/${uid}            PRESENT  subcoll=[${subcolls.join(', ') || 'none'}]`);
      collect(refs, 'recursive', `users/${uid}`, userRef);
    } else {
      log(`  users/${uid}            absent (already gone)`);
    }

    // 2. guest_activity/{uid} - a leaf doc keyed by uid.
    const guestRef = db.collection('guest_activity').doc(uid);
    if ((await guestRef.get()).exists) {
      log(`  guest_activity/${uid}   PRESENT`);
      collect(refs, 'plain', `guest_activity/${uid}`, guestRef);
    }

    // 3. dms - scan the (few) threads; participants[] is authoritative, do not
    //    rely on the "<uidA>_<uidB>" id format.
    const dmsSnap = await db.collection('dms').get();
    for (const doc of dmsSnap.docs) {
      const participants = Array.isArray(doc.data().participants) ? doc.data().participants : [];
      if (participants.map(String).includes(uid)) {
        const subcolls = (await doc.ref.listCollections()).map((c) => c.id);
        log(`  dms/${doc.id}  PRESENT  participants=[${participants.join(' + ')}] subcoll=[${subcolls.join(', ') || 'none'}]`);
        collect(refs, 'recursive', `dms/${doc.id}`, doc.ref);
      }
    }

    // 4. Field-keyed collections: recipient_uid / target_id / voter_id /
    //    user_id / author_id. reputation_logs is checked on BOTH target_id and
    //    voter_id: after the ghost is gone either side is an unresolved FK.
    const fieldScans = [
      ['notifications', 'recipient_uid', 'plain'],
      ['reputation_logs', 'target_id', 'plain'],
      ['reputation_logs', 'voter_id', 'plain'],
      ['topic_subscriptions', 'user_id', 'plain'],
      ['posts', 'author_id', 'plain'],
      ['topics', 'author_id', 'plain'],
    ];
    const seen = new Set();
    for (const [coll, field, kind] of fieldScans) {
      const snap = await db.collection(coll).where(field, '==', uid).get();
      if (snap.empty) continue;
      for (const doc of snap.docs) {
        if (seen.has(doc.ref.path)) continue; // a doc hit by two fields once
        seen.add(doc.ref.path);
        log(`  ${coll}/${doc.id}  matched ${field}==${uid}`);
        collect(refs, kind, `${coll}/${doc.id}`, doc.ref);
      }
    }

    // 5. audit_logs - report only, never delete.
    const auditByPerformer = await db.collection('audit_logs').where('performer_id', '==', uid).get();
    const auditByActor = await db.collection('audit_logs').where('actor_uid', '==', uid).get();
    const auditIds = new Set([...auditByPerformer.docs, ...auditByActor.docs].map((d) => d.id));
    for (const id of auditIds) keepAudit.push(id);
    if (auditIds.size) {
      log(`  audit_logs: ${auditIds.size} record(s) reference uid (KEPT - forensic) [${[...auditIds].join(', ')}]`);
    }
  }

  // --- report -------------------------------------------------------------
  const recursive = refs.filter((r) => r.kind === 'recursive');
  const plain = refs.filter((r) => r.kind === 'plain');
  log(`\n=== SUMMARY ===`);
  log(`  to delete (recursive, doc+subcollections): ${recursive.length}`);
  recursive.forEach((r) => log(`    - ${r.label}`));
  log(`  to delete (leaf documents)              : ${plain.length}`);
  plain.forEach((r) => log(`    - ${r.label}`));
  log(`  audit rows kept (never deleted)          : ${keepAudit.length}`);

  if (refs.length === 0) {
    log(`\nNothing to remove. Both uids are already clean.`);
    return;
  }

  if (!APPLY) {
    log(`\nDRY RUN complete. Nothing was deleted.`);
    log(`Re-run with --apply to purge the ${refs.length} reference(s) above.`);
    log(`Ensure PITR/backup is enabled first (Firebase console -> Backups).`);
    return;
  }

  // --- apply --------------------------------------------------------------
  // firebase-admin v13 exposes recursiveDelete as an INSTANCE method, not as a
  // named export from 'firebase-admin/firestore' (that yields undefined and
  // throws at call time). db.recursiveDelete(ref) removes the doc + subcolls.
  log(`\nDeleting ${refs.length} reference(s)...`);
  let done = 0;
  for (const r of refs) {
    if (r.kind === 'recursive') {
      await db.recursiveDelete(r.ref);
    } else {
      await r.ref.delete();
    }
    log(`  deleted ${r.label}`);
    done++;
  }
  log(`\nDone. ${done} reference(s) removed, ${keepAudit.length} audit row(s) kept.`);
}

main()
  .then(() => admin.app().delete())
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
