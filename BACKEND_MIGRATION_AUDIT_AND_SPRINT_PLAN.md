# Backend audit and Go/PocketBase migration plan

**Status:** approved planning baseline  
**Scope:** current Firebase application, a local-first replacement backend, and later single-VPS deployment  
**Primary audience:** implementation agents and maintainers  
**Last reviewed:** 2026-09-14

## 1. Executive decision

The migration must **not** reproduce the current topology of Firestore as the
source of truth, RTDB as a live cache, and background triggers as a
synchronisation layer. The target has one authoritative relational store and a
transactional Go command layer.

The recommended first target is a custom Go application built around PocketBase
on one VPS:

```text
React SPA
  │ PocketBase SDK: safe reads, Auth and SSE
  │ /api/aerun/*: all business commands
  ▼
PocketBase custom Go app
  ├─ short SQLite transactions
  ├─ RBAC / category visibility / input validation
  ├─ outbox worker and cron jobs
  └─ PocketBase realtime (SSE)
  ▼
SQLite + uploaded files (one authoritative pb_data volume)
```

The custom Go code is deliberately isolated behind domain interfaces. It must
not depend on browser-supplied counters, PocketBase hooks for correctness, or a
second cache database. This permits a later migration to a standalone Go API
and PostgreSQL if write volume outgrows SQLite.

### Non-negotiable invariants

1. A command either commits every domain change or commits none.
2. Only the server changes counters, roles, moderation state, reputation,
   unread state, and audit records.
3. Every externally observable side effect is idempotent.
4. Email, webhooks and realtime delivery happen after commit and can fail
   without losing a post, vote, message, or registration.
5. RTDB is not migrated as a live dependency. Its durable source data is
   migrated from Firestore; cache-only RTDB nodes are discarded.
6. Every browser mutation carries an idempotency key; retrying a timeout must
   return the original result instead of applying the action twice.

## 2. Current-state audit

### 2.1 Architecture and concurrency

| Finding | Consequence | Target correction |
|---|---|---|
| Firestore writes trigger asynchronous updates to topic/category/global counters and then RTDB mirrors. | A request can complete while the screen still reads an old projection. | Update base rows and required projections in one transaction; do not wait for a cache. |
| Post creation reads a topic before writing. Triggers independently derive `last_post_*`. | Concurrent replies can pass stale lock/limit checks; an older trigger may overwrite the newest post metadata. | `CreatePost` locks/updates the topic in one short transaction and assigns a monotonic per-topic sequence. |
| Firebase event delivery is at-least-once, but most triggers lack an event ledger. | Duplicated counters, notifications or emails after retry. | Commands write an idempotency record and an outbox event with a unique key. |
| RTDB contains presence, notifications, unread counters and forum projections. | Two sources of truth and permission leaks from cache paths. | Persistent tables plus PocketBase realtime; presence is explicitly ephemeral. |
| Several workflows are `read → decide → write`. | Duplicate subscriptions/nicknames and partial direct-message updates. | Unique indexes and server transactions. |
| Offset pagination is used in multiple callables. | Cost/latency grow with page depth; records can shift between pages. | Cursor pagination by stable `(sequence, id)` or `(created_at, id)`. |

### 2.2 Security findings

| Severity | Finding | Current remediation | Follow-up target |
|---|---|---|---|
| Critical | Provider email API key was hard-coded as a source fallback. | Removed from source; delivery is disabled safely unless secrets are configured. The exposed key must be rotated in the provider dashboard. | VPS secret manager/environment only; no secrets in code or logs. |
| High | Public Firestore `users` documents contained email, which field-level Firestore rules cannot hide. | New profiles no longer write email; owner cannot change it; root-only `stripProfileEmails` callable removes existing copies. | Auth collection stores private email; public-profile DTO never contains it. |
| High | Any signed-in user could read/write RTDB `admin_notifications`. | Browser writes are denied; admin actions use a server callable; reads require admin/root claim. | Replace with protected persistent notifications and SSE. |
| High | RTDB `post_voters` was readable and writable by clients. | Made server-only; `getPostVoters` now checks visibility of the post category. | Store/query votes through the command/read layer only. |
| High | Clients could forge audit rows and admins could delete them. | Direct client audit writes and all audit deletion are denied; a constrained privileged callable is temporary bridge. | Audit is appended inside each server command; never expose generic audit writer. |
| Medium | Email HTML interpolated user-controlled names/snippets. | Dynamic email content is HTML-escaped. | Use typed templates and sanitised plain-text snippets. |
| Medium | Callable endpoints have broad CORS and App Check disabled. | Not changed here because it needs a deployment/config decision. | Strict origin allowlist, rate limit, CAPTCHA on registration, server-side auth on every custom route. |

### 2.3 Specification drift to preserve during migration

`PROJECT_SPEC.md` describes several historical names that do not match active
code: global `characters` vs `/users/{uid}/characters`, `conversations` vs
`dms`, older notification field names, and older audit/global-stat names. The
active implementation and exported data must be treated as the migration
source; the new schema below is the target contract.

## 3. Target architecture decisions

### 3.1 Auth and identity

Use one PocketBase auth collection `users` with:

- email + password enabled;
- OAuth2 providers enabled selectively (initially Google; add others only with
  verified provider credentials and privacy review);
- `role`, `status`, profile fields and `legacy_firebase_uid`;
- email verification and password-reset flows;
- a unique normalised nickname field/index.

Do not reuse Firebase UIDs as PocketBase record IDs. Store the explicit legacy
mapping and use it for every import relation.

Password hashes from Firebase Auth are not a migration assumption. The cutover
plan is: import users with a random unusable password, preserve verified email
where supported, and require password reset for password users. OAuth users
must be tested with their provider subject/email linking flow before launch.

### 3.2 Email delivery

VPS ownership permits custom sender identity and templates, but a VPS IP alone
does not guarantee mail delivery. Before sending production email, configure a
domain, SPF, DKIM, DMARC, reverse DNS where applicable, and preferably use a
reputable SMTP relay rather than self-host a mail transfer agent.

Email types:

- auth verification, password reset and email change;
- direct-message notifications;
- subscribed-topic replies;
- optional staff alerts.

All non-auth notifications use an `outbox_events` row created in the same
transaction as the forum action. A worker marks it `sent`, retries transient
errors with backoff, then marks it `failed`/alerts staff. The forum action
returns success after database commit regardless of SMTP availability.

For verification/reset delivery failures, the account remains in its safe
unverified/reset-required state and the UI shows a retryable, neutral message.
It must not claim that email was sent when it was not.

### 3.3 Realtime and presence

Use PocketBase SSE for changes to records the subscriber is authorised to see.
The UI receives a small event and refetches the affected cursor/page; it does
not receive an all-forum cache.

Presence is not a durable business record. Implement a heartbeat endpoint
every 45–60 seconds that upserts `presence_sessions(expires_at)`. A user is
online only while `expires_at > now`. Expiry is acceptable after a browser or
server crash and is cleaned lazily or by cron. Do not attempt an RTDB-style
`onDisconnect` clone.

### 3.4 Data model

| Collection/table | Essential fields and constraints |
|---|---|
| `users` (auth) | `email`, `verified`, provider identities, `nickname_normalized UNIQUE`, `role`, `status`, `legacy_firebase_uid UNIQUE`, profile preferences. |
| `roles` | immutable system-role flag, rank, permissions; role changes are command-only. |
| `category_groups`, `categories` | category permissions, ordering, optional cached counts; no browser writes. |
| `topics` | `category`, `author`, title/state, `posts_count`, `next_post_sequence`, `last_post_id`; all maintained transactionally. |
| `posts` | `topic`, `author`, `sequence`, `posted_at`, content, frozen display identity and dice. `UNIQUE(topic, sequence)`. |
| `topic_subscriptions` | `UNIQUE(topic, user)`. |
| `reputation_votes` | `UNIQUE(voter, post)` for post vote and `UNIQUE(voter, target_user)` for profile vote; immutable value except controlled replacement. |
| `notifications` | recipient, type, payload, read/archive state. User may only alter their own presentation state. |
| `dm_conversations`, `dm_members`, `dm_messages` | `dm_members` holds per-user `last_read_sequence`, `cleared_at`; messages use per-conversation sequence. |
| `audit_logs` | append-only server record: actor, command, target, safe details, correlation ID. |
| `idempotency_keys` | `(actor, key) UNIQUE`, request hash, completed response/status. |
| `outbox_events` | unique dedupe key, event payload, attempts, next attempt, sent/failed timestamps. |

Use PocketBase API rules as a second boundary, but do not encode complex forum
business logic entirely in rules. Direct browser mutation for the critical
collections is locked; custom Go routes make all decisions and transactions.

## 4. Delivery plan

Every sprint is independently reviewable. Do not begin a later data-changing
sprint until the preceding sprint's Definition of Done is met.

### Sprint 0 — Stabilise the Firebase baseline

**Goal:** deploy the current security patch and stop expanding the legacy
surface.

Tasks:

1. Rotate the already exposed Brevo API key; set `BREVO_API_KEY` and
   `BREVO_SENDER_EMAIL` only in the Functions secret/configuration store.
2. Deploy the updated Firestore/RTDB rules and Functions.
3. As the root account, invoke `stripProfileEmails` repeatedly with the
   returned `nextAfterUid` until `done=true`; verify that no `users` document
   contains `email`.
4. Confirm normal members cannot read/write RTDB admin alerts, cannot read
   `post_voters`, and cannot write `audit_logs`.
5. Record an export/snapshot of Firestore, RTDB, Storage and Auth before any
   later schema work.

**Definition of Done:** key rotation complete, rules deployed, profile email
copies removed, and the manual permission test sheet passes.

### Sprint 1 — Local Go/PocketBase foundation

**Goal:** an isolated local backend that is reproducible from an empty folder.

Tasks:

1. Add `backend/` with PocketBase custom Go app, pinned version, `pb_migrations`,
   local `.env.example`, and README run instructions.
2. Add configuration validation: fail startup clearly if mandatory production
   secrets are absent; permit local no-email mode.
3. Add structured logs with request/correlation IDs and a health endpoint.
4. Establish Go package boundaries: `auth`, `forum`, `messaging`,
   `notifications`, `audit`, `storage`.
5. Add test database setup and migration test in CI.

**Definition of Done:** fresh local startup applies all migrations, exposes a
health check, and no local secret is required for tests.

### Sprint 2 — Identity, RBAC and secure reads

**Goal:** usable accounts without exposing private data.

Tasks:

1. Create the `users` auth collection, roles, public profile view/DTO and
   settings schema.
2. Implement email/password registration, verification, password reset and
   OAuth provider configuration abstraction.
3. Implement Google end-to-end locally; define test cases for each future
   provider before enabling it.
4. Implement RBAC/category visibility middleware and explicit deny-by-default
   API rules.
5. Implement owner-only settings/character/draft access and staff-only admin
   read models.

**Definition of Done:** a guest, player, pending user, moderator and root
receive exactly the intended records; email never appears in a public response.

### Sprint 3 — Forum transactional command layer

**Goal:** make concurrent topic/post operations correct before building pages.

Tasks:

1. Implement `CreateTopic`, `CreatePost`, `EditPost`, `DeletePost`,
   `MoveTopic`, `MovePosts`, lock/pin and moderation commands.
2. Assign `posts.sequence` inside the topic transaction; enforce max-post
   limit/lock there.
3. Update topic/category counters and latest-post fields in the same
   transaction, or calculate them from indexed queries where preferred.
4. Implement cursor pagination and deep-link lookup by sequence.
5. Add idempotency middleware and error contract (`retryable`, `conflict`,
   `forbidden`, `validation`).

**Definition of Done:** 100 concurrent post attempts produce a contiguous,
unique sequence, correct count/latest metadata, and no duplicate post after
replaying an idempotency key.

### Sprint 4 — Reputation, subscriptions and audit

**Goal:** eliminate all read-decide-write races in secondary forum actions.

Tasks:

1. Implement transactional vote creation/removal with unique constraints and
   target/post score updates.
2. Implement idempotent subscribe/unsubscribe commands; never toggle from a
   stale browser read.
3. Implement append-only audit inside each administrative command.
4. Add protected voter/history read models respecting category and privacy
   settings.

**Definition of Done:** duplicate requests cannot duplicate votes,
subscriptions or audit rows; a hidden-category post never leaks through voter
or profile endpoints.

### Sprint 5 — Direct messages, notifications and mail outbox

**Goal:** reliable private communication without RTDB.

Tasks:

1. Implement conversation membership and message sequencing in one
   transaction per send.
2. Update recipient unread state and create persistent in-app notification in
   the same transaction.
3. Add outbox rows for email with a dedupe key such as
   `dm:first-unread:{conversation}:{recipient}`.
4. Implement worker retry/backoff, admin visibility of failed events and
   explicit no-SMTP local mode.
5. Subscribe UI to authorised PocketBase SSE events and refetch only affected
   data.

**Definition of Done:** disabling SMTP still permits all forum and DM actions;
restarting the worker does not resend an already successful event.

### Sprint 6 — Frontend adapter and feature parity

**Goal:** keep the React UI while replacing Firebase dependency by domain API.

Tasks:

1. Add a PocketBase client and replace `firebase.js` behind `src/api/*`.
2. Migrate AuthProvider, registration/login/linking, password reset and
   verification UI.
3. Replace RTDB presence, unread badges, notifications and connection banner.
4. Replace direct Firestore listeners/writes progressively page by page.
5. Retain error cards, retry affordances and diagnostic IDs for all network
   failures.

**Definition of Done:** the local frontend has no runtime Firebase imports and
passes core manual flows against local PocketBase.

### Sprint 7 — Migration tooling and rehearsals

**Goal:** prove import correctness without touching production users.

Tasks:

1. Build exporters for Firestore, Firebase Auth metadata and Storage; preserve
   checksums and immutable raw export manifests.
2. Implement an idempotent importer with `legacy_firebase_uid` and per-record
   mapping tables/checkpoints.
3. Import Firestore durable data first; recompute rather than import RTDB cache
   nodes (`main_page_cache`, `topic_posts_cache`, `post_voters`, `dm_unread`,
   presence, session permissions).
4. Preserve historical post/message dates in application fields; validate all
   foreign keys, counts, latest-post pointers and file references.
5. Rehearse a full import repeatedly on local copies and document elapsed time.

**Definition of Done:** two imports of the same export yield the same target
state and the reconciliation report has no unexplained mismatch.

### Sprint 8 — VPS production readiness

**Goal:** make deployment and recovery routine before public cutover.

Tasks:

1. Purchase domain and configure DNS, TLS reverse proxy, SPF/DKIM/DMARC and
   SMTP relay credentials.
2. Run PocketBase as a non-root systemd service behind Caddy or Nginx;
   expose only 80/443 and SSH-key access.
3. Put `pb_data` on local encrypted SSD storage; run one active PocketBase
   process only.
4. Configure encrypted offsite backups, retention, disk/RAM/error monitoring
   and an alert for outbox failures.
5. Test restore into an isolated VPS/local environment from a real backup.

**Definition of Done:** documented restore drill completes within the agreed
RTO/RPO, and no database/files/secrets are only present on the VPS.

### Sprint 9 — Cutover

**Goal:** one controlled switch with a reversible rollback window.

Tasks:

1. Announce maintenance; put Firebase mutations into read-only mode.
2. Take final exports and import the delta into the rehearsed target.
3. Run automated reconciliation and privileged/guest smoke tests.
4. Switch frontend configuration/DNS; monitor error rate, disk, auth, outbox
   and realtime connections.
5. Keep Firebase read-only and retained for the agreed rollback period, then
   revoke credentials and archive exports securely.

**Definition of Done:** critical workflows succeed in production, monitoring is
green, reconciliation is signed off, and rollback conditions have expired.

## 5. Mandatory tests for every backend change

- Unit tests for authorisation and role/category matrix.
- Transaction tests with concurrent requests.
- Idempotency replay tests.
- Permission tests using a raw HTTP client, not only the UI.
- Migration reconciliation tests and file checksum sampling.
- SMTP unavailable, timeout and retry tests.
- Browser reconnect/SSE resubscription tests.
- Backup restore test before each major release.

## 6. Explicitly deferred items

- Scaling beyond one SQLite writer or one VPS. Reassess with measured queue
  time/CPU/disk metrics; do not introduce replicas casually.
- New OAuth providers beyond the tested initial provider.
- Self-hosted mail transfer agent. Use a relay until DNS reputation and
  operational capacity justify otherwise.
- Feature additions during the data migration window.

## 7. Agent hand-off rules

1. Read this file and the current schema migration before changing backend
   code.
2. One task must name its collection(s), command(s), rules, migration and test
   updates explicitly.
3. Never add client writes to a counter/cache/security field as a shortcut.
4. Never send email inside a database transaction or make a successful forum
   command depend on email delivery.
5. Update this plan and the canonical schema documentation whenever a target
   contract changes.

## 8. Progress log

> Maintained by the implementation agent after every work session: what is
> done, current stage, difficulties found, and plan changes. Latest entry last.

### 2026-09-17 — Sprint 1 foundation started (branch `feature/pocketbase-migration`)

**Done**

- Created and switched to branch `feature/pocketbase-migration` from clean `main`
  (base commit `3dbe15a`).
- Added `backend/` Go module (`github.com/SiJunma/aerun/backend`) targeting
  PocketBase **v0.40.4** (verified released; its `go.mod` requires Go 1.27):
  - `cmd/aerun/main.go` — entry point; deliberately rejects command-line
    arguments so environment variables are the single configuration path;
  - `internal/config` — env-only configuration with production guardrails
    (loopback-only bind, explicit origins, 32-byte `AERUN_ENCRYPTION_KEY`
    required in production, wildcard origins forbidden, mail hard-disabled);
    framework-free and unit-testable;
  - `internal/platform/pocketbase` — the only package importing PocketBase
    (adapter); registers `GET /api/aerun/health`, CORS origin allowlist
    middleware, application meta settings, and a post-startup health probe
    with structured JSON logs;
  - `internal/migrations` — first append-only migration creating
    `idempotency_keys` with `UNIQUE(actor, key)` (plan invariant 6) and all
    API rules nil (browser writes locked);
  - tests: `internal/config/config_test.go` (defaults, six rejection cases,
    valid production config), `internal/platform/pocketbase/run_test.go`
    (production without key must be rejected before serve),
    `internal/migrations/migrations_test.go` (fresh app + `RunAllMigrations`
    + collection assertions);
  - `.env.example`, `.gitignore` (`pb_data/`, `.env`, binaries), `README.md`
    with local run steps and current limitations.

**Difficulties / deviations found**

1. **No Go toolchain on this machine** (`go`/`gofmt` absent from `PATH`), and
   project rules forbid running builds. Therefore the module is **not yet
   compiled or run**; `go.sum` is not generated. Manual verification commands
   are listed below and must be run once a Go ≥1.27 toolchain is installed.
2. **PocketBase v0.40.4 serve API conflict with the plan's loopback guardrail**:
   `pocketbase.New()` has no config-level HTTP address; the address comes from
   the `serve --http` flag. Since our entry point rejects arguments, the first
   runnable build will serve on the library default `127.0.0.1:8090`. Making
   `AERUN_LISTEN` effective requires either a custom serve command or an
   `apis.Serve` call — deferred to the next session's Sprint 2 review; until
   then `AERUN_LISTEN` is validated but informational.
3. **CORS allowlist header format**: PocketBase's serve flag joins multiple
   origins into a single comma-joined `Access-Control-Allow-Origin` value, so
   the adapter middleware mirrors that format instead of per-request echoes.
   Per-origin echo should be revisited during Sprint 2 auth work.
4. **AGENTS.md rule 4 (RTDB-first)** conflicts with this plan's invariant 5
   ("RTDB is not migrated as a live dependency"). For `backend/` work the
   migration plan governs; the RTDB-first rule remains valid only for the
   still-active Firebase application.
5. `tests.NewTestApp` + `RunAllMigrations` is taken from PocketBase's own test
   helpers; exact helper signatures against v0.40.4 must be confirmed on first
   `go test` run (no toolchain available here).

**Manual verification (requires Go ≥ 1.27, from `backend/`)**

```powershell
go mod tidy          # generates go.sum from go.mod
go build ./...
go test ./...
$env:AERUN_ENV='local'; go run ./cmd/aerun
# then: GET http://127.0.0.1:8090/api/aerun/health  -> {"status":"ok",...}
```

**Sprint 1 DoD status**: partial — code and tests exist; "fresh local startup
applies all migrations and exposes health" is pending the first successful
`go build`/`go run` (blocked by missing toolchain, see Difficulties #1/#2).

**Sprint 0 note (blocking, requires human action)**: provider key rotation,
final Firestore rules deployment, `stripProfileEmails` run and export snapshots
are prerequisites for later data sprints and remain unchecked.

**Next session**: wire `AERUN_LISTEN` into a custom serve command, confirm
`RunAllMigrations` test helpers, generate `go.sum`, run the test suite, then
start Sprint 2 (users/RBAC collections and rules).

**Same-session fixes after static review** (no toolchain available, fixes were
found by re-reading the code against the plan):

- `idempotency_keys` was created with a public-access bug: explicit empty API
  rules (`types.Pointer("")`) mean "allow all authenticated clients", not
  "locked". Replaced with nil rules (superuser-only) and added the missing
  `key` column; the unique index now covers `(actor, key)` per section 3.4.
- `cmd/aerun/main.go` did not import the migrations package, so embedded
  migrations would never register; added the blank import.
- `Run` returned `nil` after a successful health probe, which would let `main`
  exit and kill the server process immediately; now it blocks on the serve
  result for the process lifetime.
- Removed an unused `path/filepath` import (would fail `go build`).
- README no longer suggests `go run ./cmd/aerun migrate up`, which the
  argument-rejecting entry point would refuse; PocketBase applies new
  migrations automatically on startup.
### 2026-09-17 — Offline preparation; runtime validation deferred

**Stage:** Sprint 1 incomplete; independent preparatory parts of Sprints 6/7
implemented. User requests NO Go/PocketBase installation or execution here.
Code preparation continues; integration validation is deferred to the home PC.

**Implemented**

- Opt-in HTTP command transport with configurable origin/token/fetch, stable
  caller-provided idempotency keys and diagnostic errors; no automatic retries.
  Live Firebase UI unchanged; server command routes are NOT implemented.
- Firebase source adapter reuses functions/firebase-admin: paged Firestore
  traversal plus Auth metadata without password hashes/salts/tokens.
- Checksummed snapshots, copy-on-write intermediate JSON staging, deterministic
  replay and snapshot diff. Changed source rows replace staged rows; missing
  rows are retained for review. Corruption, stale imports, duplicate identities
  and project mismatch fail. This is NOT a PocketBase domain importer.
- CLI export/diff/stage uses exclusive creation; never overwrites artifacts.
- Seven persistent offline Node tests passed, including JSON round-trip of
  optional Auth fields (normalized before hashing) and deterministic ordering.
  Syntax checks and inline mock checks passed. A separate CLI subprocess test
  had unobservable terminal completion;
  it is NOT counted as passed. No Firebase connection was made.
- Fixed backend/.gitignore paths (incorrect backend/ prefix) and ignored local
  migration-data. README documents actual coverage and proposed API envelope.

**Corrections to earlier log / unresolved foundation blockers**

- Pinned version compatibility must be independently confirmed at home; prior
  verification claims must not be relied on. Go tests/signatures/dependencies
  remain unverified; go.sum absent.
- pb.Start without serve does NOT establish a working listener. The earlier
  claim about serving on a default address was wrong; AERUN_LISTEN is unwired.
- Comma-separated Access-Control-Allow-Origin is invalid; attributing that
  behavior to PocketBase was unsupported. Replace the custom middleware.
- Encryption key presence validation does not configure encryption. Absolute
  production data paths and no-mail behavior are not enforced. Request IDs and
  CI remain pending. These are Sprint 1 blockers, not Sprint 2 polish.
- Empty PB rules permit everyone, not only authenticated users; nil locks them.
  Schema migrations import PocketBase in addition to the platform adapter.

**Reimport strategy / limitations**

Firebase remains authoritative until final read-only cutover. Rehearsal exports
are live/non-atomic, buffered in memory, omit Storage bytes and may miss nested
collections under nonexistent parents. They are NOT complete backups. Take
separate official backups; do not dual-write production.

Keep clean import-rehearsal and interactive local-test databases separate.
Staging is source-owned, not an editable forum database. Domain import still
needs legacy UID/path mappings, relations, transactional checkpoints, sequence/
counter reconstruction, historical dates, file checksums, password reset/linking,
local-edit conflicts and reviewed deletions. Final cutover requires frozen
Firebase writes, complete fresh exports and successful reconciliation.

**Next:** correct runtime wiring against verified PB APIs; implement Sprint 2
schema/auth/RBAC then Sprint 3 transactional commands. Extend exporter coverage
and build domain import against those schemas. Finish other commands/frontend
integration before home-machine rehearsal and VPS readiness. No sprint DoD is
claimed complete; no production changes or deployment performed.
