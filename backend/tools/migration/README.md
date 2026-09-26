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

## Domain import rehearsal (Go)

`backend/tools/migration/importer` is the deterministic analysis stage of the
Sprint 7 domain importer: it loads a staging ledger plus the official Auth
export, decodes every record, validates foreign keys, derives a per-record
legacy-to-PocketBase id mapping, recomputes counters instead of trusting cached
values, and writes a reconciliation report. It does NOT write to PocketBase.

```powershell
go run ./tools/migration/importer/cmd/import-rehearse `
    -ledger ../../backend/migration-data/stage-1.json `
    -auth  ../../backend/migration-data/auth-official-2026-09-18.json `
    -out   ../../backend/migration-data/rehearsal-1
```

(replace relative paths with the actual locations from `backend/`). Outputs,
both exclusively created:

- `mapping.json` — the mapping table. Target ids are **derived**: SHA-256 of
  (collection space, legacy id) mapped onto PocketBase's 15-char alphabet, so
  two runs of one export produce byte-identical ids and re-runs address rows in
  place instead of duplicating them. Users additionally carry
  `legacy_firebase_uid`; other collections have no legacy column, which is why
  the id itself must be stable.
- `report.json` — record counts, skipped cache collections, foreign-key errors,
  compatibility findings (role/status translation, folded custom roles,
  recomputed post sequences) and cached-vs-recomputed counter mismatches.
  Durations are omitted from the file so reports of the same export diff clean.

**Sprint 7 DoD check:** run the command twice into two output directories and
compare `mapping.json` and `report.json`; they must be byte-identical, and the
reconciliation report must contain no *unexplained* mismatch (mismatches are
the stale cached counters that the import deliberately recomputes).

Exit code is non-zero only on input errors or dangling foreign keys.

## Role registry import

`import-roles` is the first writer of the migration. It does **not** copy the
source role documents: the target registry is the runtime authority, seeded from
the compiled matrix, and `users.role` is a closed select over exactly those
values. The writer therefore reconciles the registry against the compiled specs
and reports the legacy documents it refused to apply (custom roles, and any
drift between a legacy `permissions` array and the spec).

```powershell
# reconcile and report only, no database needed
go run ./tools/migration/importer/cmd/import-roles -ledger migration-data/stage-1.json -dry-run

# write into a local rehearsal database
go run ./tools/migration/importer/cmd/import-roles -data migration-data/roles-rehearsal-pb_data
```

The write is a single-transaction upsert keyed by the unique `role_id` index, so
it is idempotent (`changed=false` on a second run), repairs drift, recreates
deleted rows, and never deletes a row it did not create — extra rows are only
reported. A dry run needs no `-data`: it writes nothing.

## Role registry import (Go)

`import-roles` writes the `roles` collection of a local PocketBase database. It
is the first command that writes records rather than only analysing an export.

```powershell
New-Item -ItemType Directory -Force migration-data/roles-db
go run ./tools/migration/importer/cmd/import-roles `
    -data   migration-data/roles-db `
    -ledger migration-data/stage-1.json
```

The data directory must already exist and the command refuses to run without
it, so a clean rehearsal database is created deliberately and production can
never be passed by accident. Migrations run first, then the registry is written
as an **idempotent upsert keyed by the unique `role_id` index**: a second run
prints `unchanged=6 changed=false` and touches nothing. Role rows the command
did not create are reported in `ExtraRoleIDs` and never deleted.

`-dry-run` reconciles the compiled matrix against the legacy snapshot and
writes nothing.

### Which source wins

The **compiled matrix** (`internal/auth`) stays the authority for the *system*
roles; the legacy Firestore `roles` documents are only reconciled and reported.
In the legacy app the document *was* the effective grant
(`src/constants/permissions.js` resolves `roles.find(...)` before
`DEFAULT_ROLES`, with the compiled constants acting as a ceiling), so the
report is a real behavioural diff, not a cosmetic one. Per role it prints
legacy-only and compiled-only permissions, and the import never resolves the
drift silently — that is a product decision, not a tooling one.

**Custom roles are imported verbatim** (migration 1766500000 made them
first-class: `users.role` is a text field validated against `roles.role_id`,
and `categories.allowed_roles` may reference them). `import-roles` with
`-ledger` therefore writes system roles from the matrix *and* every legacy
`is_system=false` document with `role_id = legacy doc id`, `base_role_id`,
`max_characters_limit` and its own permission array (rank is inherited from
the base role because `roles.rank` is required). Permissions outside the
compiled vocabulary are dropped with a `custom_role_permission_unknown`
finding, never written. A second run over its own output reports
`changed=false`.

Observed on the 2026-09-18 snapshot (5 system + 4 custom legacy documents,
6 target system roles):

- `admin` and `guest` match the compiled matrix exactly.
- `moderator` gains `view_audit_log` and loses `edit_others_avatars`,
  `edit_others_nicknames`, `edit_others_signatures`, `edit_others_statuses`,
  `delete_reputation`, `use_direct_messages`.
- `player` gains `view_master_dice`.
- `spectator` loses `edit_self_avatar`, `edit_self_nickname`,
  `use_direct_messages`.
- `root` is a target role with no legacy document (owner of the live forum).
- The 4 custom roles (Demon, Anaptix, NorthbayСitizen, NorthbayCitizen+) are
  imported verbatim; their 7 members keep the role, reported as
  `custom_role_users_keep_role` per role.

## Limits and cutover requirements

Live exports are NON-ATOMIC and fully buffered in memory. Subcollections under
nonexistent/deleted ancestor documents may be missed. Storage bytes and orphan
subcollection discovery are not implemented. This tool is not a complete backup
or final cutover exporter. RTDB is not read and is intentionally not backed up:
it is a derived cache rebuilt from the database and all its data is temporary
(decision 2026-09-18). Take official backups separately for Firestore, Storage
and Auth.

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
