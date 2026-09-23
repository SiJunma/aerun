# `backend/tools/ops` — one-off operational tools

These scripts are **not** part of the backend runtime. They exist to close a
specific audit item against the live Firebase project and are expected to be
deleted once the legacy project is retired (Sprint 9).

## `strip-profile-emails.mjs`

Runs the root-only `stripProfileEmails` callable in production and proves the
result is idempotent.

Why it is needed: legacy public Firestore `users` documents still carry a copy
of the account email while `firestore.rules` grants `allow read: if true` on
that collection, so those addresses are world readable. Firebase Auth is the
canonical source for email; see `BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md`
section "Why the email copy is removed, and what does NOT depend on it".

Why a custom token: the callable requires a real root user session
(`request.auth.uid` plus the Firestore role `root`), so a plain service account
token is refused. The tool signs a Firebase custom token for the root uid with a
throwaway service account key, exchanges it for an ID token, and then calls the
deployed callable exactly like the browser would.

Dependencies: none beyond Node 18+ (`node:crypto` and global `fetch`).

### Operator procedure

Run from the repository root. The key file path is gitignored via `.secrets/`.

```powershell
# 1. throwaway service account (signing rights only)
gcloud iam service-accounts create aerun-ops-token-mint `
  --project aerun-forum --display-name "temp: mint root session for one-off ops"

# 2. one short-lived key
gcloud iam service-accounts keys create .secrets/aerun-service-account.json `
  --iam-account aerun-ops-token-mint@aerun-forum.iam.gserviceaccount.com `
  --project aerun-forum

# 3. prove the whole path without modifying anything
$env:AERUN_CHECK_ONLY="1"; node backend/tools/ops/strip-profile-emails.mjs; Remove-Item Env:AERUN_CHECK_ONLY

# 4. the real run (idempotence is verified by the tool itself)
node backend/tools/ops/strip-profile-emails.mjs

# 5. remove the key and the service account
gcloud iam service-accounts keys list --iam-account aerun-ops-token-mint@aerun-forum.iam.gserviceaccount.com --project aerun-forum
gcloud iam service-accounts keys delete <KEY_ID> --iam-account aerun-ops-token-mint@aerun-forum.iam.gserviceaccount.com --project aerun-forum
gcloud iam service-accounts delete aerun-ops-token-mint@aerun-forum.iam.gserviceaccount.com --project aerun-forum
```

Permissions: creating the key needs `iam.serviceAccountKeys.create` (a project
Owner normally has it, otherwise grant Service Account Key Admin temporarily).
The tool resolves the root uid through the Identity Toolkit
`projects.accounts:lookup` API; if that call is refused, pass the uid directly
with `AERUN_ROOT_UID` (Console → Authentication → the root account) and no Auth
permission is needed at all.

Expected output is aggregates only — batch counts, `stripped`, `done`, and the
confirmation pass. **No email address is ever printed**, so the log is safe to
paste into the plan journal.

Interpreting the run:

- `RESULT: N public email copies removed; the collection is clean` — the item is
  closed; the addresses remain canonical in Firebase Auth.
- `RESULT: nothing to strip - the collection was already clean` — someone (or an
  earlier run) already closed it; nothing changed.
- `FAIL: ...` — nothing is written on a failure other than a completed batch;
  re-run after fixing the reported cause. The callable is idempotent, so a
  partial run is safe to repeat.
