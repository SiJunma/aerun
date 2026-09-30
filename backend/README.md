> **Current status (2026-09-18): local serve WIRED and verified end-to-end.**
> Go 1.27.0 + PocketBase v0.40.4 installed; `go build ./...`, `go vet ./...` and
> `go test ./...` pass. The entry point now bootstraps and serves
> programmatically via `apis.Serve` (migrations apply, health self-probe passes,
> graceful shutdown on Ctrl+C). Verified live on 127.0.0.1:8090: health JSON,
> `/_/` dashboard, PB CORS per-origin echo with allowlist enforcement (204
> preflight, no header for disallowed origins), `idempotency_keys` migration
> applied. First run opens/prints a superuser installer URL
> (`/_/#/pbinstall/<token>`, valid 30 min) — create your admin there.
> Remaining gaps: production absolute data paths and no-mail-route enforcement
> (Sprint 2 guardrail), dedicated read-only export identity (Sprint 8), domain
> APIs (auth/forum/messaging/…, Sprint 2+). CI (gofmt/build/vet/test) is wired
> in `.github/workflows/backend.yml`. Note: CLI arguments are rejected, so
> `superuser upsert` is unreachable; use the installer URL on a fresh `pb_data`
> (or delete `pb_data/` to regenerate it).
> See `tools/migration/README.md` for the independently tested Node tools.
> PocketBase imports are allowed in the platform adapter AND schema migrations,
> not in future domain packages. Domain APIs (auth/forum/messaging/…) remain
> pending (Sprint 2+).


# Aerun backend (Go + PocketBase)

Isolated local-first replacement for the Firebase backend. Sprint 1 of
`BACKEND_MIGRATION_AUDIT_AND_SPRINT_PLAN.md`: an empty folder must bootstrap a
healthy server with applied migrations and no production secrets.

## Layout

- `cmd/aerun` — process entry point; rejects command-line arguments on purpose,
  configuration comes only from environment variables (see `.env.example`).
- `internal/config` — deployment configuration parsing and validation, decoupled
  from PocketBase so production guardrails are testable without a database.
- `internal/platform/pocketbase` — the only package allowed to import the
  PocketBase framework. Domain packages (`auth`, `forum`, `messaging`,
  `notifications`, `audit`, `storage`) will be added beside it framework-free.
- `internal/migrations` — versioned schema migrations, append-only.

## Run locally (no secrets required)

PowerShell, from `backend/`:

```powershell
$env:AERUN_ENV='local'
$env:AERUN_LISTEN='127.0.0.1:8090'
go run ./cmd/aerun
```

> The listener is the validated loopback `AERUN_LISTEN`; the process serves
> until interrupted (Ctrl+C triggers a graceful shutdown).

The process fails startup when command-line flags are used; this keeps one
configuration path between local and VPS deployments.

## Google login (optional, Sprint 2 task 3)

The `users` collection exposes the Google provider only while both credentials
exist in the process environment:

```powershell
$env:AERUN_GOOGLE_CLIENT_ID='…apps.googleusercontent.com'
$env:AERUN_GOOGLE_CLIENT_SECRET='…'
```

Local runs may keep the pair in `.env.local` at the repository root instead
(gitignored): `cmd/aerun` seeds unset keys from it before `config.Load` (cwd
first, then its parent, so a server started from `backend/` finds the root
file), and a real environment variable always wins. On every startup
`configureOAuth2` reconciles the collection with the environment — with the
pair present it enables the `google` provider (endpoints, PKCE and scopes come
from PocketBase's Google defaults; only the client id/secret are stored),
without it OAuth2 goes back to the migration baseline of off. Password login
is unaffected either way; `GET /api/collections/users/auth-methods` reports
the result.

The Google Cloud console must list the exact redirect URI of the PocketBase
URL: `<AERUN_PUBLIC_URL origin>/api/oauth2-redirect` (locally
`http://127.0.0.1:8090/api/oauth2-redirect`), plus the frontend origins
`http://localhost:5173` / `http://127.0.0.1:5173`. Known limits: once enabled
the client secret lives in the collection JSON inside `pb_data/` (gitignored —
keep `pb_data` out of repositories and shared backups), and a Google account
whose email is not in `users` yet cannot self-register through Google (the
required Aerun profile fields are not derivable from the provider); imported
and registered accounts link by email on their first Google login.

## CI

GitHub Actions (`.github/workflows/backend.yml`) runs gofmt, `go build`,
`go vet` and `go test` on every push touching `backend/**`, on a clean Linux
runner with the Go version from `go.mod`. Each run also publishes a
machine-readable result to the `ci-report` branch (`report.json`); read it from
anywhere with plain git — no tokens or GitHub API access required, which matters
because this repository is private:

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

Report schema `aerun-ci-report/1`:

```json
{
  "schema": "aerun-ci-report/1",
  "run_number": 2,
  "status": "success",
  "branch": "feature/pocketbase-migration",
  "commit": "<full sha>",
  "checks": {"gofmt": "ok", "build": "ok", "vet": "ok", "test": "ok"},
  "run_url": "https://github.com/<owner>/<repo>/actions/runs/<id>",
  "finished_at": "2026-09-18T20:12:23Z"
}
```

How to read it: `checks` holds a key only for a step that ran and passed, so a
missing `gofmt`/`build`/`vet`/`test` key means that step failed or was skipped;
`status` is the overall job status. The publish step runs with `if: always()`,
so failing runs are reported too. The branch is force-pushed to a single commit,
so only the newest run is available there — use `run_url` (or the Actions tab)
for history. Treat the report as the authoritative external check: local results
come from a developer machine, the report comes from a clean checkout.

## Health check

```
GET http://127.0.0.1:8090/api/aerun/health
```

The application also verifies the endpoint itself after startup and logs the
health result with structured (JSON) fields including a correlation-ready env
context.

Every response carries an `X-Request-ID` header: a valid incoming ID is echoed
(max 64 chars, `[A-Za-z0-9_.:-]`), otherwise a fresh random ID is generated.
The same value is returned in the health body as `request_id` and is available
to handlers for structured-log correlation.

## Aerun command endpoints (Sprint 2, 3, 4 & 5)

All business commands live under `/api/aerun/*` and resolve the access context
(role + status + permissions) from the AccessResolver middleware. Deny-by-
default: the collections have locked mutation rules, so these commands are the only
supported way to change state.

Role permissions are read from the seeded `roles` collection, with the compiled
matrix in `internal/auth` as the fallback when a row is missing, so a broken
lookup degrades to deny-by-default instead of failing open. The guest identity
(unauthenticated requests) holds the global `view_forum` baseline, so anonymous
visitors can read the public forum; category-level narrowing arrives with the
Sprint 4 category read models. `pending` narrows any role to `view_forum` plus
the self-edit rights, `banned` denies everything.

### Identity & Settings (Sprint 2)

- `POST /api/aerun/auth/register` — guest-only email/password registration.
  Creates a `player` account in the safe pending state (`status=pending`,
  `verified=false`); the response never contains the email address, password
  hash or token key. Conflicts: `409` for duplicate email or nickname
  (case/whitespace variants collide via `nickname_normalized`); reserved
  nicknames (role names, "aerun", "staff", …) are rejected. Bodies beyond
  64 KiB get `413`.
- `GET /api/aerun/me` — public profile DTO of the caller (no email, no
  `legacy_firebase_uid`); guests receive the guest identity.
- `PUT /api/aerun/me/settings` — owner-only replacement of the caller's
  `users.settings` JSON object (≤256 KiB, ≤8 nesting levels). Banned accounts
  get `403`; pending accounts keep their legacy self-service rights.
- `GET /api/aerun/admin/users` — staff-only account list
  (`admin_access` permission: root/admin only; moderators get `403`).
  Supports `page`, `perPage` (default and cap both `30`) and `status` filters.
  The payload is an explicit whitelist: it carries `id`, `nickname`, `role`,
  `status`, `verified`, `avatar_url`, `created`, `updated`, `post_count`,
  `topics_count` and `reputation` — and **never** `email`, `tokenKey`,
  `password` or `legacy_firebase_uid`. Addresses are authentication
  credentials, not profile data, so they are absent rather than masked; staff
  who need one use the PocketBase console. Consumers must page through the
  result instead of asking for one large page — a `perPage` above the cap is
  clamped, not honoured.

### Forum Command Layer (Sprint 3)

Every mutating forum command requires an `Idempotency-Key` header (`[A-Za-z0-9_.:-]{1,255}`).
Mutations execute in a single SQLite transaction together with their idempotency envelope.
Concurrent duplicate requests replay the winner's byte-identical response (`Idempotency-Replayed: true`),
while payload mismatches with a reused key return `409 Conflict`.
All errors return the machine-readable error contract:
`{ "data": { "retryable": bool, "conflict": bool, "forbidden": bool, "validation": bool, "kind": string, "request_id": string }, "message": string, "status": int }`.

- `POST /api/aerun/topics` — create a new topic with its opening post (`sequence=1`) in one transaction. Requires `create_topic` permission.
- `GET /api/aerun/topics` — list active topics with keyset pagination (`pinned DESC, last_post_created DESC, id DESC`).
- `GET /api/aerun/topics/:id` — get topic details.
- `PATCH /api/aerun/topics/:id` — update topic title, lock, or pin state.
- `POST /api/aerun/topics/:id/move` — move topic to a different category (`move_topics` permission).
- `DELETE /api/aerun/topics/:id` — soft delete a topic (`moderate_content` or author).
- `POST /api/aerun/topics/:id/posts` — create a reply. Monotonically assigns sequence inside the topic transaction, verifies max post limit and locked state, and advances topic metadata atomically (`post_reply` permission).
- `GET /api/aerun/topics/:id/posts` — list posts in a topic ordered by sequence.
- `GET /api/aerun/topics/:id/posts/by-sequence/:sequence` — deep-link lookup by topic sequence number.
- `PATCH /api/aerun/posts/:id` — edit post content (`moderate_content` or author).
- `DELETE /api/aerun/posts/:id` — soft delete post, updates visible post count and topic `last_post_*` fallback.
- `POST /api/aerun/topics/:id/posts/move` — move posts between topics, resequencing in target topic and updating projections for both topics in one transaction.
 
### Reputation, Subscriptions and Audit (Sprint 4)
 
- `POST /api/aerun/posts/:id/vote` — cast or update vote on a post (`value`: `1` or `-1`, `comment` up to 1024 chars). Atomically updates post score and author profile reputation. Requires `use_reputation` permission.
- `DELETE /api/aerun/posts/:id/vote` — remove voter's own vote on a post, reverting post and user scores atomically.
- `POST /api/aerun/users/:id/vote` — cast or update a profile reputation vote. Requires `use_reputation` permission.
- `DELETE /api/aerun/users/:id/vote` — remove voter's own profile vote.
- `DELETE /api/aerun/reputation/:id` — administrative deletion of any reputation vote (`delete_reputation` permission). Automatically appends an audit log entry.
- `GET /api/aerun/posts/:id/voters` — get voters for a post. Enforces category access control: users without category view permission receive `403 Forbidden`.
- `GET /api/aerun/users/:id/reputation` — list reputation history with keyset pagination. Enforces privacy masking (`rep_show_history`, `rep_show_comments`) for non-staff callers, and scrubs post ID / topic title for votes on posts in restricted categories.
- `POST /api/aerun/topics/:id/subscribe` — subscribe to topic updates. Strictly idempotent: duplicate requests cannot create duplicate subscription records.
- `POST /api/aerun/topics/:id/unsubscribe` & `DELETE /api/aerun/topics/:id/subscription` — unsubscribe from topic updates. Idempotent no-op if not subscribed.
- `GET /api/aerun/topics/:id/subscription` — check caller's subscription status for a topic.
- `GET /api/aerun/me/subscriptions` — list topics the caller is subscribed to with keyset pagination.
- `GET /api/aerun/admin/audit-logs` — keyset-paginated audit trail for administrative actions (`view_audit_log` permission: root/admin). Supports filtering by `action_type` and `performer_id`.

### Direct Messages, Notifications and Outbox (Sprint 5)

- `POST /api/aerun/dms` — create a new DM conversation with recipient(s) and opening message in one transaction. Requires `use_direct_messages` permission. Creates in-app notifications and queues deduplicated outbox email (`dm:first-unread:{conv}:{recipient}`).
- `GET /api/aerun/dms` — list conversations for caller with keyset pagination, unread counters, and last message metadata. Cleared conversations without new messages are excluded.
- `POST /api/aerun/dms/:id/messages` — send a reply message. Sequenced monotonically within the conversation transaction. Updates conversation unread state, notifies other members, and queues deduplicated outbox event.
- `GET /api/aerun/dms/:id/messages` — list ordered messages in conversation. Filters out messages prior to member's `cleared_at`.
- `POST /api/aerun/dms/:id/read` — mark conversation as read, advancing member's read sequence to latest message and clearing unread state.
- `POST /api/aerun/dms/:id/clear` — clear conversation history for caller (`cleared_at`).
- `GET /api/aerun/me/notifications` — list in-app notifications with keyset pagination and `unread` filter.
- `PATCH /api/aerun/me/notifications/:id/read` — mark single notification as read.
- `POST /api/aerun/me/notifications/read-all` — mark all caller's notifications as read.
- `PATCH /api/aerun/me/notifications/:id/archive` — archive notification.
- `GET /api/aerun/me/unread-counts` — aggregated unread counters (`unread_notifications`, `unread_conversations`, `total_unread_messages`), replacing RTDB unread badges.
- `GET /api/aerun/admin/outbox-events` — keyset-paginated outbox events for staff visibility (`view_audit_log` permission: root/admin).
- `POST /api/aerun/admin/outbox-events/:id/retry` — reset failed outbox event to pending (`view_audit_log` permission).

`AERUN_MAIL_MODE`: supports `disabled` (explicit no-SMTP mode for local development and tests) and `smtp` (production relay). Disabling SMTP permits all forum and DM actions without interruption. Outbox worker processes events with exponential backoff and never re-dispatches already successful events.


## Full migration runbook (Firebase -> PocketBase)

The cutover is a sequence of CLI tools. Every step is idempotent: re-running any
of them against a **fresher** dump converges on the same rows instead of
duplicating them, so release day is "take a new dump, run the same commands
again" rather than a bespoke procedure.

Two rules make re-runs safe:

- **Every row writer is an upsert keyed by a derived id.** `DeriveID(space, key)`
  is a pure function of the legacy identity, so the same legacy row always
  resolves to the same PocketBase id — which is what keeps posts referencing
  characters (and characters referencing accounts) pointing at the right record
  across runs.
- **`avatar_url` is co-owned.** The row importer copies the legacy URL; the
  storage importer then replaces it with a `/api/files` path. Once a row carries
  a local path the row importer leaves it alone, so the two steps never undo
  each other.

Run every command from `backend/`. Stop the running backend first for any
command that takes `-data` — it holds the SQLite handle. Every command supports
`-dry-run`, which reports exactly what a real run would do and writes nothing.

```powershell
# ── 0. Extract a fresh snapshot (Node.js; needs firebase-admin credentials) ──
node tools/migration/cli.mjs snapshot                 # Firestore + RTDB + Storage
node tools/migration/cli.mjs stage                    # -> migration-data/stage-*.json
# the official Firebase Auth export stays a separate artefact:
#   migration-data/auth-official-<date>.json

# ── 1. Analyse before writing anything (needs no database) ──
go run ./tools/migration/importer/cmd/import-rehearse `
    -ledger migration-data/stage-1.json `
    -auth    migration-data/auth-official-2026-09-18.json `
    -out     migration-data/rehearsal

# ── 2. Write. Order matters: each step is a dependency of the next. ──
go run ./tools/migration/importer/cmd/import-roles -data pb_data -dry-run
go run ./tools/migration/importer/cmd/import-roles -data pb_data

go run ./tools/migration/importer/cmd/import-users `
    -ledger migration-data/stage-1.json `
    -auth   migration-data/auth-official-2026-09-18.json `
    -data   pb_data -dry-run
go run ./tools/migration/importer/cmd/import-users `
    -ledger migration-data/stage-1.json `
    -auth   migration-data/auth-official-2026-09-18.json `
    -data   pb_data

# characters need their owner to exist, so this comes after import-users
go run ./tools/migration/importer/cmd/import-characters `
    -ledger migration-data/stage-1.json `
    -auth   migration-data/auth-official-2026-09-18.json `
    -data   pb_data -dry-run
go run ./tools/migration/importer/cmd/import-characters `
    -ledger migration-data/stage-1.json `
    -auth   migration-data/auth-official-2026-09-18.json `
    -data   pb_data

# the board itself: groups -> categories -> topics -> posts + drafts.
# It needs import-roles (allowed_roles names roles) and import-users (authors),
# and it runs the four levels internally in that order.
go run ./tools/migration/importer/cmd/import-board `
    -ledger migration-data/stage-1.json -dry-run
go run ./tools/migration/importer/cmd/import-board `
    -ledger migration-data/stage-1.json -data pb_data
# -verbose prints every planned row, including the per-category allowed_roles
# list — the field that decides who can see a board section.

# ── 3. Storage: turn legacy avatar URLs into real files ──
go run ./tools/migration/importer/cmd/import-avatars `
    -data pb_data -storage migration-data -scope all -dry-run
go run ./tools/migration/importer/cmd/import-avatars `
    -data pb_data -storage migration-data -scope all

# ── 4. Derive the counters from the rows that now exist ──
go run ./tools/migration/importer/cmd/recompute-counters -data pb_data -dry-run
go run ./tools/migration/importer/cmd/recompute-counters -data pb_data

go run ./cmd/aerun        # migrations apply at startup
```

`import-avatars -scope all` covers both collections. A re-run reports
`unchanged=N` and `-dry-run` reports `planned=N`, so "did anything change?" is
answered by the output instead of by remembering.

### What does not exist yet

An honest inventory, because a runbook that implies more coverage than it has is
worse than none:

| Legacy collection | Writer | Status |
| --- | --- | --- |
| `roles` | `import-roles` | done |
| `users` | `import-users` | done |
| `users/{uid}/characters/{cid}` | `import-characters` | done |
| `category_groups`, `categories` | `import-board` | done (L2/L3) |
| `topics`, `posts`, `users/{uid}/drafts/{tid}` | `import-board` | done (L5/L6, sequence reconstructed) |
| `reputation_logs` | `import-board` | done (L7 → `reputation_votes`) |
| `topic_subscriptions` | `import-board` | done (L7) |
| Firebase Storage avatars | `import-avatars` | done (users + characters) |
| derived counters | `recompute-counters` | done (users + post reputation) |
| `notifications` | `import-board` | done (L8, payload ids rewritten) |
| `dms`, `dms/{id}/messages` | `import-board` | done (L8, per-conversation sequence) |
| `audit_logs` | `import-board` | done (L9, `details` verbatim) |
| `settings`, `designs` | — | skipped by design (theme/config, not forum data) |

`recompute-counters` rebuilds `users.posts_count`, `users.topics_count`,
`users.reputation` and `posts.reputation` from the rows that exist — never from
the legacy cached values. It is idempotent and safe to re-run.

### Two things the board rehearsal taught, recorded so they are not re-learned

- **Every writer keys its rows by `DeriveID(space, legacyID)`**, and a re-run
  recomputes the same ids. That is what makes `-data pb_data` safe to run twice:
  the second run reports `unchanged`, never a duplicate.
- **A column that does not exist is silently ignored on write.** The category
  writer shipped writing `created_at` while `categories` only has the autodate
  `created`/`updated`, and every run afterwards reported `updated=15` forever
  without a single error. `TestImportCategoriesPreservesHistoricalDate` now
  asserts the stored date, not just the idempotency — an empty stored value and a
  wrong one fail the same way.

## Migrations

Migrations are embedded Go files in `internal/migrations`; PocketBase applies
new unapplied migrations automatically during startup. Never edit an applied
migration — add a new timestamped file. Manual migration commands are not
exposed by this entry point because it intentionally rejects command-line
arguments; if manual control is needed later, it will be added behind the same
environment-validated path.

## Avatar upload

`users.avatar` is a PocketBase file field (migration `1767000000`) and
`users.avatar_url` holds the host-agnostic `/api/files/...` reference to it, so
the rows survive a domain change. `PUT /api/aerun/me/avatar` writes both:
multipart `file` part, ≤2 MB, PNG/JPEG/WebP/GIF.

The format is sniffed from the **bytes**, never from the client's
`Content-Type` or filename, and the stored name is derived from the sniffed
extension so PocketBase serves the right type back. Any authenticated forum
account may change its own avatar; banned accounts get `403`.

That route is deliberately **not** bound to `enforceIdempotency`: the middleware
buffers the whole body into the idempotency envelope and caps it at 512 KB, so a
multipart avatar can never satisfy it. The command is safe without the envelope
because it replaces rather than accumulates — PocketBase deletes the previous
file when a single-select `FileField` is overwritten.

### Legacy avatar import

The bytes come out of the verified Sprint 0 export
(`migration-data/storage`) and every file is checked against the md5 in
`storage-manifest.json`:

```powershell
go run ./tools/migration/importer/cmd/import-avatars `
    -data pb_data -storage migration-data -dry-run
go run ./tools/migration/importer/cmd/import-avatars `
    -data pb_data -storage migration-data
```

Stop the running backend first — it holds the SQLite handle. The run is
idempotent (`unchanged=N` on a second pass), never deletes anything, and
touches only legacy Firebase objects: a DiceBear or third-party avatar is
reported with a reason and left alone. `-download` re-fetches from the live
bucket instead of the export, for an avatar that changed after the snapshot.
Files are served under the collection `ViewRule`, so an active account's
avatar is public and a pending/banned one is not.

## User activity counters

`users.posts_count`, `users.topics_count` and `users.reputation` (migrations
`1766300000` + `1767100000`) are denormalised. They are defined by the rows, not
by events:

- `posts_count` — posts with `author_id` = user, `deleted = false` and
  `is_draft = false` (an unsent draft is not a post).
- `topics_count` — topics with `author_id` = user and `deleted = false`.
- `reputation` — the sum of `value` over **every** `reputation_votes` row whose
  `target_id` is the user, profile votes and post votes alike. A post vote moves
  `posts.reputation` *and* `users.reputation` in the same command
  (`reputation.go`), so a recompute that counted only profile votes would build a
  base the command layer disagrees with. Checked against the export: the legacy
  cached value matches the all-votes sum for 10 of 11 users, the profile-only sum
  for 4.
- `posts.reputation` — the sum over the votes that name that post, rebuilt by
  `RecomputePostReputation`. The importer writes zero and never copies the legacy
  cache, so a stale score cannot sit next to the votes that contradict it.

The command layer moves all three inside the same transaction as the post, topic
or vote that justifies the change, so the members table never lags the forum. A
counter that is only ever moved by a command, however, starts at zero — so a
database filled by the import has the right columns and wrong numbers until the
recompute pass runs:

```powershell
go run ./tools/migration/importer/cmd/recompute-counters -data pb_data -dry-run
go run ./tools/migration/importer/cmd/recompute-counters -data pb_data
```

## 5. Prove the result: two independent databases, compared

Not a re-run. Two runs on ONE database prove idempotency, not determinism: a
writer that depends on map iteration order, or that only writes a row when another
row happens to be present, reproduces its own leftovers perfectly and produces
something else entirely on a clean database. Create two empty data directories,
run the whole pipeline into each, then compare.

```powershell
go run ./tools/migration/importer/cmd/verify-equivalence -a pb_data_a -b pb_data_b
```

Exits non-zero and names the row, the field and both values on any difference.
`created`/`updated` are PocketBase-owned and are excluded on purpose — the two
databases are written minutes apart, so comparing them would flag every row and
hide a real one.

On the 2026-09 export this reports **5132 rows across 14 collections, 0
differences**. Building it was worth it: the first run found that migration-seeded
rows (the role registry, the bootstrap "General" category) and imported custom
roles were being created with RANDOM PocketBase ids, so no two fresh installs
could ever be proven to hold the same data. Fixed by migration
`1767600000_deterministic_seed_ids` and by deriving the id in the role writer.

Stop the running backend first (it holds the SQLite handle). The pass is
idempotent — a second run reports `updated=0` — never deletes anything, and
prints record ids with their derived values, never email addresses. Run it after
any bulk content import.

## Current limitations

- Email delivery is deliberately disabled (`AERUN_MAIL_MODE=disabled`).
- Command-line flags (`--http`, `--origins`, `--dir`) are intentionally
  rejected; all configuration comes from environment variables. The listener,
  migrations and CORS are wired programmatically through `apis.Serve` (verified
  against v0.40.4 source and live probes; `RunAllMigrations()` runs inside
  `apis.Serve` itself). Consequence: the built-in `superuser upsert`
  subcommand is unreachable — create the first superuser via the installer URL
  printed on first run with a fresh `pb_data/`.
- Production mode requires `AERUN_ENCRYPTION_KEY`, absolute `AERUN_DATA_DIR`
  and explicit `AERUN_ALLOWED_ORIGINS`; missing values abort startup.
