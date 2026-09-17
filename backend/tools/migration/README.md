# Offline migration preparation

Status: rehearsal exporter + intermediate JSON staging, NOT a PocketBase domain
importer. No Firebase requests are made by the tests. Node >=20 is required.

From the repository root:

```powershell
node --test backend/tools/migration/snapshot.test.mjs src/api/backend/command-client.test.mjs
```

On the home machine, install the existing `functions` dependencies and configure
ADC for a dedicated read-only export identity. Select the project explicitly.
Never put credentials or exports into Git. Protect the export folder with OS
permissions (Windows ACLs); checksums are not encryption or signatures.

```powershell
npm ci --prefix functions
New-Item -ItemType Directory -Force backend/migration-data
node backend/tools/migration/cli.mjs export YOUR_PROJECT_ID backend/migration-data/first.json
node backend/tools/migration/cli.mjs stage backend/migration-data/first.json - backend/migration-data/stage-1.json
# Export again to second.json while the production forum continues operating.
node backend/tools/migration/cli.mjs diff backend/migration-data/first.json backend/migration-data/second.json backend/migration-data/diff.json
node backend/tools/migration/cli.mjs stage backend/migration-data/second.json backend/migration-data/stage-1.json backend/migration-data/stage-2.json
```

Files are exclusively created, not overwritten. Interrupted writes may leave an
incomplete artifact: remove that artifact manually and retry with a new name.

## Coverage

- Firestore documents and nested collections under existing documents; tagged
  timestamp values retain nanoseconds, references and bytes retain their types.
- Auth metadata excluding password hashes/salts/tokens. This is still PRIVATE
  data, including email and claims; never use it as a public profile response.
- SHA-256 manifest/record checksums and explicit source project identity.
- Deterministic copy-on-write staging by `(kind, full source path)`. Replays do
  not duplicate records; later source values replace earlier staged values.
- Missing records are retained and reported, never automatically deleted.
- Corrupt input, duplicate identities, older snapshots and project mismatch fail.

## Limits and cutover requirements

Live exports are NON-ATOMIC and fully buffered in memory. Subcollections under
nonexistent/deleted ancestor documents may be missed. Storage bytes and orphan
subcollection discovery are not implemented. This tool is not a complete backup
or final cutover exporter. RTDB is not read. Take official backups separately.

Staging files are source-owned artifacts, not an editable forum database.
Domain import still needs legacy-to-PocketBase mappings, foreign-key validation,
transactional checkpoints, counters/sequences reconstruction, file checksums,
password reset/provider linking and local-edit conflict resolution. Keep clean
import rehearsal and interactive test databases separate. Before final cutover,
freeze Firebase writes, take fresh complete exports, reconcile deletions and
relations, and only then switch the frontend. Do not dual-write production.

## Proposed frontend command contract

The isolated transport is not imported by the live UI and does not implement
server commands. It accepts a deployment origin and token getter, uses
`POST /api/aerun/commands/{name}`, a caller-retained `Idempotency-Key`, and
`Authorization: Bearer ...`. Success: `{data: ...}`. Failure:
`{error: {code, message, retryable}}`, with `X-Request-ID` for diagnostics.
Mutations are never automatically retried; manual retries retain the same key.
Server routes, RBAC, transaction/idempotency enforcement remain to be written.
