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

## Aerun command endpoints (Sprint 2, 3 & 4)

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
  Supports `page`, `perPage` (max 100) and `status` filters; includes email
  for staff account management (not a public response) and never exposes
  `tokenKey`, `password` or `legacy_firebase_uid`.

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


Email stays hard-disabled (`AERUN_MAIL_MODE=disabled`): the PB verification
and password-reset endpoints answer `204` while the mailer guard blocks every
send, so registration-related flows must not claim that an email was sent.

## Migrations

Migrations are embedded Go files in `internal/migrations`; PocketBase applies
new unapplied migrations automatically during startup. Never edit an applied
migration — add a new timestamped file. Manual migration commands are not
exposed by this entry point because it intentionally rejects command-line
arguments; if manual control is needed later, it will be added behind the same
environment-validated path.

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
