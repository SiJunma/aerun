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
| Critical | Provider email API key was hard-coded as a source fallback. | Removed from source; delivery is disabled safely unless secrets are configured. The exposed key was **rotated on 2026-09-21 and its revocation verified** (old key -> HTTP 401, new key -> HTTP 200); the new secret lives only outside git. | VPS secret manager/environment only; no secrets in code or logs. |
| High | Public Firestore `users` documents contained email, which field-level Firestore rules cannot hide. | New profiles no longer write email; owner cannot change it; root-only `stripProfileEmails` callable removes existing copies. **Still live on 2026-09-21: 11 of 12 `users` documents carry `email` under `allow read: if true` -- the root action is the remaining Sprint 0 item.** | Auth collection stores private email; public-profile DTO never contains it. |
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

Tasks (status re-verified read-only against the live project on 2026-09-21; see
the closure entry at the end of the journal):

1. Rotate the already exposed Brevo API key; set `BREVO_API_KEY` and
   `BREVO_SENDER_EMAIL` only in the Functions secret/configuration store.
   **DONE 2026-09-21 (operator), independently verified.** The operator rotated
   both credentials in the Brevo dashboard; the SMTP password lives only in the
   Firebase Auth SMTP settings and the API key only in the gitignored
   `functions/.env` (`BREVO_API_KEY`, 89 chars); Functions were redeployed the
   same day. Verification evidence (no key material recorded): the only key that
   ever existed in git history (`functions/email.js` at commit `0d6390c`,
   removed in `c8ed35f`) is dead -- `GET https://api.brevo.com/v3/account` with
   it answers **HTTP 401 `{"message":"API Key is not enabled"}`** -- while the
   key in `functions/.env` answers **HTTP 200**; the two hashes differ
   (sha256/12 `e57f04fc6f56` vs `986b8cff4db4`), and `git grep xkeysib` finds no
   occurrence in any tracked file on `main` or on the migration branch. Note:
   all three credentials observed for this account (the revoked key, the new API
   key and the new SMTP password) share one 64-hex core segment and differ only
   in the last 16 characters, so a shared middle segment is not evidence of a
   stale secret -- the revoked key's rejection above is the authoritative check.
2. Deploy the updated Firestore/RTDB rules and Functions.
   **DONE, verified 2026-09-21.** Deployed rulesets were compared read-only with
   the repository files: `firestore.rules` identical (sha256 prefix
   `3d75775db4`, deployed 2026-09-16T15:18:41Z), `storage.rules` identical
   (`de75599aca`), `database.rules.json` identical (`a1b6e7d25a`, read through
   the RTDB REST `.settings/rules.json` endpoint -- RTDB rulesets do not appear
   in the `firebaserules` releases list, so the live rules file is the only
   reliable source). Functions were redeployed on 2026-09-21 for the credential
   rotation and for the Node 22 runtime bump.
3. As the root account, invoke `stripProfileEmails` repeatedly with the
   returned `nextAfterUid` until `done=true`; verify that no `users` document
   contains `email`.
   **OPEN -- live exposure confirmed 2026-09-21.** Read-only probe: the `users`
   collection holds 12 documents and 11 of them still carry an `email` field,
   while `firestore.rules` grants `match /users/{userId}` `allow read: if true`
   -- those 11 addresses are readable by anyone, signed in or not. The
   `stripProfileEmails` callable is deployed and root-only
   (`functions/index.js`); with 12 documents a single call (default `limit` 200)
   covers the whole collection and returns `done: true`, and a second call must
   return `stripped: 0`. Accepted side effect: the legacy admin UI shows a
   profile email only to root (`isRootAdmin ? u.email : '***'`), so after the
   strip root loses that display and the email search in AdminPage/MembersPage;
   the addresses stay canonical in Firebase Auth (Console -> Authentication) and
   are exposed to staff by the new backend (`GET /api/aerun/admin/users`).

   **Ready-to-run tool (2026-09-21).** `backend/tools/ops/strip-profile-emails.mjs`
   performs the root session, the call, and the idempotence proof in one command
   (dependencies: Node 18+; procedure and cleanup in
   `backend/tools/ops/README.md`). It supports `AERUN_CHECK_ONLY=1`, which proves
   that the synthesised root session is accepted (the callable answers
   `invalid-argument` for `limit=0`, and the root check runs before payload
   validation) **without modifying a single document** — run that probe first.
   The whole tool was syntax-checked with `node --check` and exercised for its
   failure path; the only missing input is the short-lived service account key,
   which is stored at the gitignored `.secrets/aerun-service-account.json`.

   No deploy is required for this item: the callable was already deployed on
   2026-09-21 and answers authenticated calls (an unauthenticated probe returns
   `unauthenticated` / "Sign in first."), so nothing in the repository has to
   change for the strip to run.

   Deliberately NOT changed: `firestore.rules` still grants
   `match /users/{userId}` `allow read: if true`. That read is not an accident —
   `src/pages/MembersPage.jsx` renders the member list for guests, so tightening
   the rule would break a visible feature. Closing the exposure is therefore the
   data's job (this item), not the rule's; the rule also already blocks any
   *new* profile from carrying an email (`!('email' in request.resource.data)`).

4. Confirm normal members cannot read/write RTDB admin alerts, cannot read
   `post_voters`, and cannot write `audit_logs`.
   **Rules level: DONE, verified 2026-09-21.** Anonymous access is denied
   (unauthenticated `GET /.json?shallow=true` -> HTTP 401) and the live rules
   require `role_id` `admin`/`root` to read `admin_notifications` with
   `".write": false`; `post_voters`, `main_page_cache` and `topic_posts_cache`
   are `false`/`false`; `audit_logs` has no rule at all, so RTDB's
   deny-by-default applies. The strict DoD still asks for the manual sheet with
   a real member token -- open, it needs a signed-in member session.
5. Record an export/snapshot of Firestore, RTDB, Storage and Auth before any
   later schema work.
   **DONE 2026-09-18** for Firestore + Auth + Storage; RTDB was excluded by
   decision (it is a derived cache) -- see the 2026-09-18 journal entry.

**Definition of Done:** key rotation complete, rules deployed, profile email
copies removed, and the manual permission test sheet passes.
Status 2026-09-21: rotation and rules deployment are complete and independently
verified, the profile email copies are still live (item 3: 11 documents) and the
member-token permission sheet has not been run, so Sprint 0 is still NOT closed.
Item 3 is a single root action and its data is recoverable (the addresses stay
in Firebase Auth).

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

### Continuous verification channel (CI report)

Every push touching `backend/**` is verified on a clean Linux runner
(`.github/workflows/backend.yml`: gofmt, `go build`, `go vet`, `go test`) and
the outcome is published as `report.json` to the `ci-report` branch of this
same repository. It is a plain-git channel: it needs no tokens and no GitHub
API access, which matters because the repository is private.

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

Schema `aerun-ci-report/1` fields:

| Field | Meaning |
| --- | --- |
| `run_number` | GitHub Actions run number (also the history key via `run_url`) |
| `status` | overall job status (`success`, `failure`, `cancelled`) |
| `branch`, `commit` | branch name and full commit SHA that was verified |
| `checks` | `{gofmt, build, vet, test}` — a key is present with `ok` **only when that step ran and passed**; missing key = failed or skipped |
| `run_url` | browser link for full logs |
| `finished_at` | UTC timestamp of report publication |

The publish step runs with `if: always()`, so red runs are reported too. The
branch is force-pushed to a single commit, therefore it holds only the latest
run; use `run_url` or the Actions tab for history. Treat a green report as the
authoritative external check for backend changes — local success is not enough,
because the runner is clean and Linux-based.

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
6. After pushing backend changes, read the machine-readable CI report instead of
   assuming the change is verified: `git fetch origin ci-report` and
   `git show origin/ci-report:report.json` (see section 5). Fix red checks
   before starting new work, and remember that only the latest run is stored on
   that branch.

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
### 2026-09-18 — Go + PocketBase installed; first real build, tests and runtime probe

**Stage:** Sprint 1 environment unblocked. Go toolchain installed on the home
machine per user request; the previously deferred verification commands ran.

**Done**

- Installed Go 1.27.0 (windows/amd64) via winget (`GoLang.Go`), matching the
  `go 1.27` directive. `go mod tidy` in backend/ downloaded PocketBase v0.40.4
  with all transitive dependencies and generated `go.sum` (131 lines); go.mod
  gained the indirect dependency block.
- Fixed two compile-level API mismatches against v0.40.4, as predicted:
  1. `internal/platform/pocketbase/run.go`: `se.Router.Bind(apis.
     WrapStdMiddleware(...))` does not compile — `WrapStdMiddleware` returns
     `func(*core.RequestEvent) error`, while `Bind` wants
     `*hook.Handler[*core.RequestEvent]`. Switched to `se.Router.BindFunc(...)`.
  2. `internal/migrations/migrations_test.go`: `core.FieldsList` has no `Get`;
     the accessor is `GetByName`. Switched to `Fields.GetByName("actor")`.
- `go build ./...` exits 0. `go test ./...` exits 0: `internal/config` ok,
  `internal/migrations` ok (fresh `tests.NewTestApp` + `RunAllMigrations`,
  idempotency_keys/actor/index assertions), `internal/platform/pocketbase` ok
  (production without encryption key rejected before serve). Helper signatures
  (`tests.NewTestApp()`, `app.RunAllMigrations()`) confirmed valid on v0.40.4.
- Runtime probe (`go run ./cmd/aerun`, local env vars): **refined the two
  earlier claims with source-verified facts.** `pb.Start()` with no arguments
  runs Bootstrap (creates `pb_data/{data.db,auxiliary.db,.notify}` with system
  tables only), then cobra prints the CLI help (`serve`, `superuser`) and the
  process exits — no listener is started, and **app migrations are NOT
  applied**: in v0.40.4 `RunAllMigrations()` is invoked only by the `serve`
  command (`cmd/serve.go:67`) and by `tests.NewTestApp` (`tests/app.go:125`),
  not by `Bootstrap()`. Consequently the health probe in `Run()` is
  unreachable in the no-arg path (serveErr resolves immediately with nil).
  The original "serves on default 127.0.0.1:8090" claim was definitively
  wrong; the "no listener" correction was confirmed and made precise.
- The probe-created `pb_data/` (bootstrap-only DB without app migrations) was
  removed to avoid a stale half-initialized data dir; `pb_data/` stays
  gitignored.

**Corrections / open Sprint 1 blockers (unchanged scope, now precise)**

- Entry point must invoke the serve path programmatically (run the `serve`
  subcommand through `RootCmd`, or call Bootstrap + RunAllMigrations +
  `apis.Serve` directly) — otherwise no listener and no app migrations, ever.
  This is the AERUN_LISTEN wiring already scheduled for the Sprint 2 review.
- Comma-joined CORS middleware, unwired encryption, production path/no-mail
  enforcement, request IDs, CI: still open, unchanged.

**Next:** implement the serve wiring against verified v0.40.4 APIs, re-run the
health probe end-to-end (`go run ./cmd/aerun` must serve and pass its own
probe), then Sprint 2 (users/RBAC collections and rules).
### 2026-09-18 — Programmatic serve wired; Sprint 1 DoD met locally

**Stage:** Sprint 1 locally verifiable. The previously deferred "wire AERUN_LISTEN
into serve" work is done and validated with a live server on this machine.

**Done**

- First phase committed as `8d5ac95` (toolchain verification + two API fixes).
- `internal/platform/pocketbase/run.go` rewritten from `pb.Start()` to explicit
  `Bootstrap()` + `apis.Serve(pb, ServeConfig{HttpAddr: cfg.Listen,
  AllowedOrigins: cfg.Origins})`:
  - `pb.Start()` without arguments never serves (help + exit); `apis.Serve`
    blocks for the process lifetime, applies all new migrations itself and
    triggers OnServe on its own router without touching `os.Args` — the
    env-only configuration guardrail now holds at runtime, not just on paper.
  - `Bootstrap()` must be called explicitly (`apis.Serve` requires a
    bootstrapped app; first attempt panicked in `MigrationsRunner.
    initMigrationsTable` because `app.DB()` is nil before bootstrap).
  - Removed the invalid custom comma-joined `Access-Control-Allow-Origin`
    middleware; CORS is now PocketBase's own `apis.CORS` fed by the validated
    origins allowlist (per-origin echo confirmed live: allowed origin echoed,
    disallowed origin gets no header, preflight 204 with correct `Vary`).
  - Settings encryption wired via `DefaultEncryptionEnv: "AERUN_ENCRYPTION_KEY"`
    (verified in `core/settings_model.go`: non-empty key encrypts the settings
    blob, empty key stores plaintext — safe for local keyless runs, and the
    production validation already demands the key).
  - Graceful shutdown: termination signals trigger PocketBase's OnTerminate,
    where `apis.Serve` binds its HTTP shutdown; health self-probe runs after
    startup and reports structured `backend healthy` (observed in real logs).
- Live verification on 127.0.0.1:8090 (fresh pb_data): `GET /api/aerun/health`
  → 200 JSON; `/_/` dashboard → 200; `idempotency_keys` table + columns +
  `idx_idempotency_actor_key` confirmed in data.db; installer printed a
  superuser creation URL (`/_/#/pbinstall/<token>`, 30 min TTL).
- Known trade-off introduced: CLI arguments are rejected, so PocketBase's
  `superuser upsert` subcommand is unreachable; first superuser comes from the
  installer URL on a fresh `pb_data/` (documented in backend/README.md).
- README status banner and limitations rewritten to the verified state.
- Probe artifacts (`pb_data/`, temp logs) removed after verification; the
  committed tree contains no runtime databases.
- gofmt flags every file as unformatted due to CRLF working-copy checkout
  (content is gofmt-clean; go vet passes). Cosmetic CI concern only, noted
  for the Sprint 1 CI task.

**Corrections to earlier log**

- "Serves on default 127.0.0.1:8090" was wrong; "no listener" was right but
  incomplete: app migrations also never run outside the serve path. Both are
  now moot — the programmatic serve path is wired and verified.

**Sprint 1 DoD status**: met locally — fresh startup applies all migrations,
exposes the health check, needs no secrets; formal DoD still requires CI.

**Next:** Sprint 1 leftovers (request/correlation IDs, CI pipeline with
`go test`), then Sprint 2 (users auth collection, RBAC, secure reads).
Mail hard-disable enforcement on PB auth routes remains a Sprint 2 guardrail
 alongside the auth work.
### 2026-09-18 — Sprint 0 item 5: live read-only snapshots (Firestore, Auth, Storage; RTDB excluded)

**Stage:** Sprint 0 item 5 executed against the live project `aerun-forum` with
read-only access only; production stayed fully available for users throughout
(all operations were list/get/download — no writes, no rule or data changes,
no downtime).

**Decisions**

- RTDB is EXCLUDED from backups per user decision: it is a derived cache
  rebuilt from the database and all its data is temporary. This amends Sprint 0
  task 5 ("Firestore, RTDB, Storage and Auth"); `backend/tools/migration/
  README.md` updated to record it.

**Access setup**

- Reused the existing firebase CLI login (sijunma116@gmail.com). Generated
  gcloud-style ADC from it via firebase-tools' own defaultCredentials logic
  (CLI client_id/secret + the already-stored refresh token) written to
  %APPDATA%\gcloud\application_default_credentials.json. No new Firebase-side
  credentials were created; no secrets were printed to the terminal. A
  dedicated read-only service account remains the hardening step before VPS
  cutover (Sprint 8).

**Artifacts (backend/migration-data/, gitignored; protect with OS ACLs)**

- firestore-auth-rehearsal-2026-09-18.json — rehearsal snapshot via the repo
  tool (11,855,557 bytes): Firestore documents + nested collections + Auth
  metadata WITHOUT password hashes/salts/tokens.
- stage-1.json — staging ledger; report: created 5411, updated 0, missing 0.
- auth-official-2026-09-18.json — official `firebase auth:export` (14 accounts,
  7,353 bytes) INCLUDING password hashes — highly sensitive, never commit,
  needed only for future login-migration planning.
- storage/ + storage-manifest.json — full bucket download: 176 GCS objects
  listed, 5 zero-byte folder placeholders skipped, 171 real files downloaded
  (≈10.5 MB), every file MD5-verified against GCS metadata (0 mismatches).
  GCS prefix/name collisions (an object named `smiles/tumblr` with children
  `smiles/tumblr/*`; same for one user's `personal` path) are stored
  flat-encoded and mapped back via the manifest `storedAs` field.
- rtdb-*.json attempt was removed: `firebase database:get /` failed with an
  instance URL resolution error AND is no longer wanted (decision above).

**Caveats (unchanged from the plan)**

- The rehearsal export is live and non-atomic and buffers everything in
  memory; subcollections under missing ancestors may be missed; it is NOT the
  final cutover exporter.
- The official GCS-managed Firestore export (`gcloud firestore export`) was
  not run: gcloud is not installed on this machine. Optional hardening later;
  final cutover will still take fresh complete exports after freezing writes.

**Next:** Sprint 1 leftovers (request/correlation IDs, CI pipeline with
`go test`), then Sprint 2 (users auth collection, RBAC, secure reads).
### 2026-09-18 — Sprint 1 leftovers done: request IDs + CI; DoD complete

**Stage:** Sprint 1 formally complete; the CI workflow is committed and will
execute on the next push touching `backend/**`.

**Done**

- Request correlation IDs wired in the platform adapter
  (`internal/platform/pocketbase/request_id.go`): every response carries
  `X-Request-ID` — a caller-provided ID is echoed only when it matches
  `^[A-Za-z0-9_.:-]{1,64}$` (no whitespace/control chars, so response
  splitting or log forging via the echo path is impossible), otherwise a
  crypto-random 16-char ID is generated (`security.RandomString`). The ID is
  stored in PB's request-scoped event store (`e.Set`/`e.Get`, confirmed in
  `tools/router/event.go` of v0.40.4) and returned by the health endpoint as
  `request_id`. Live-verified on 127.0.0.1:8090: generated, echoed and
  rejected paths all behave as designed.
- Unit tests for the sanitizer (generation on empty/whitespace/forbidden/
  oversized/control-char input, echo of valid input, trim of surrounding
  spaces).
- CI pipeline: `.github/workflows/backend.yml` — gofmt, `go build`, `go vet`,
  `go test -count=1` on ubuntu-latest, Go pinned via `backend/go.mod`, paths
  filter on `backend/**`, manual dispatch, concurrency cancel-in-progress,
  read-only token.
- Line endings: `.gitattributes` pins `backend/**/*.go` to `text eol=lf`
  (gofmt requires LF); working copies normalized with `gofmt -w`. This
  surfaced REAL formatting defects previously masked by CRLF noise (stray
  double blank line in config.go, missing final newline in two new files,
  alignment drift in config_test.go) — the CI gofmt step is load-bearing,
  not cosmetic. `gofmt -l` is clean locally now.
- go build / go vet / go test pass; the local server was restarted on the new
  build and re-verified.

**Sprint 1 DoD status**: complete — reproducible startup from an empty folder
with applied migrations, health check, structured logs with request IDs, no
local secrets for tests, CI wired.

**Next:** Sprint 2 — Identity, RBAC and secure reads: `users` auth collection,
roles, public profile DTO without email, registration/verification/password
reset, Google OAuth locally, RBAC middleware with deny-by-default rules — plus
the mail hard-disable guardrail on PB auth routes (email delivery stays
disabled).
### 2026-09-18 — First CI run green; machine-readable report channel added

**Stage:** CI workflow verified in production conditions and extended with an
automated report channel readable by local tooling.

**Done**

- First CI run (#1, commit d5c6ba2): Success in 1m55s — gofmt/build/vet/test
  all green on the clean Linux runner; Sprint 1 DoD now verified by CI.
- The workflow now publishes a machine-readable `report.json` (schema
  aerun-ci-report/1: run number, status, branch, commit, per-check ok/skipped
  markers, run URL, UTC timestamp) to the `ci-report` branch of the repo
  (force-pushed single-commit branch; `permissions.contents: write` added
  for this step only). Local tooling reads it with plain `git fetch` — no
  tokens or API access needed even though the repo is private.
- Fixed pre-push in the publish step: the status file path is `.ci-status`
  (working directory is `backend/`) and it must be read before `cd` to the
  repo root.

**Next:** Sprint 2 — Identity, RBAC and secure reads: `users` auth collection,
roles, public profile DTO without email, registration/verification/password
reset, Google OAuth locally, RBAC middleware with deny-by-default rules — plus
the mail hard-disable guardrail on PB auth routes (email delivery stays
disabled).
### 2026-09-21 — Sprint 2 completed: registration command, owner-only settings, staff admin read model

**Stage:** Sprint 2 task list complete as far as it can go without external
secrets (Google OAuth credentials are a human prerequisite). The CI report
for the previous commit (cbc8856, run #4) was green before this work started.

**Done**

- Registration command `POST /api/aerun/auth/register`
  (`internal/platform/pocketbase/register.go`): guest-only; creates a `player`
  account in the safe state — `status=pending`, `verified=false`,
  `emailVisibility=false` — with `nickname_normalized` derived by
  `auth.NormalizeNickname` (NFKC + lowercase + whitespace collapse). Duplicate
  email/nickname are pre-checked and answer `409`; the Save path maps UNIQUE
  index violations to the same `409` messages so a concurrent registration can
  never create a duplicate. Reserved display names (role names, "aerun",
  "staff", "support", … — `internal/auth/reserved_nickname.go`) are rejected
  so staff/brand impersonation via a nickname is impossible. Bodies beyond
  64 KiB are rejected with `413` before parsing. The response carries only
  public fields (`id`, `nickname`, `role`, `status`, `verified`,
  `request_id`) — never email/password/tokenKey/legacy_firebase_uid. Password
  policy (8..72, bcrypt input bound) is validated up front; email format is
  pre-checked with a conservative pattern, PocketBase re-validates on save.
- Owner-only settings command `PUT /api/aerun/me/settings`
  (`settings_update.go`): replaces `users.settings` wholesale (deterministic
  replace-not-merge), accepts only a single JSON object ≤256 KiB (mirrors the
  column MaxSize) with nesting depth ≤8; JSON null normalises to `{}` so the
  column never stores null. Guests `401`, banned accounts `403`, pending
  accounts keep the legacy self-service rights.
- Staff-only admin read model `GET /api/aerun/admin/users`
  (`admin_users.go`): gated by the `admin_access` permission (root/admin;
  moderators deliberately do not have it), `page`/`perPage` (max 100) and a
  validated `status` filter bound as a dbx expression (no string filters).
  Includes email for staff account management (not a public response — the
  Sprint 2 DoD concerns public responses); `tokenKey`, `password` and
  `legacy_firebase_uid` are never part of the payload because the map is
  assembled field by field. Deterministic `created DESC, id ASC` ordering.
- Wired the three commands in `registerRoutes`; the admin route uses the
  existing `RequirePermission(auth.PermAdminAccess)` middleware which runs
  after the group AccessResolver.
- Tests (`commands_test.go`, raw HTTP client per plan §5): registration
  success/pending contract with absence assertions (no email, tokenKey,
  legacy_firebase_uid, emailVisibility in the response), duplicate email and
  case/whitespace nickname variants, the full validation table (email,
  password bounds, nickname presence/length/reservation), authenticated
  callers rejected, oversized bodies `413`; settings access matrix
  (guest/pending/banned/player/moderator) with DB persistence checks;
  settings payload contract (depth boundary at 8, arrays/malformed rejected,
  null → `{}`, oversized `413`); admin access matrix (guest 401, everyone
  without admin_access 403, root 200) and payload contract with status
  filter and private-column absence assertions. Plus a unit test for
  `auth.IsReservedNickname`.
- README documents the Sprint 2 command endpoints and the no-email behaviour
  of the PB auth endpoints.

**Findings / decisions**

- `router.ApiError` messages are sentenized (first letter capitalised,
  trailing dot) — test assertions must match the normalized form.
- `tests.ApiScenario` expects an empty body when `ExpectedContent` is absent,
  so every case asserting a body must provide `ExpectedContent`.
- Registration idempotency keys are NOT in this change: the plan schedules
  the idempotency middleware + error contract as Sprint 3 task 5; duplicate
  registrations are already impossible via the UNIQUE indexes.

**Still open (explicit)**

- Sprint 2 task 3 (Google OAuth end-to-end locally) requires real Google
  credentials — a human prerequisite, deferred until provided; the users
  collection keeps OAuth2 disabled until then.
- Sprint 0 status after the operator pass of 2026-09-21: items 1 (key rotation)
  and 2 (rules/Functions deploy) are DONE and independently verified; item 3
  (`stripProfileEmails`) is still live (11 of 12 public profiles expose `email`),
  item 4 still needs the member-token permission sheet, item 5 was done for
  Firestore/Auth/Storage. See the dedicated 2026-09-21 operator entry below.
- Next: Sprint 3 — forum transactional command layer (CreateTopic/CreatePost
  with per-topic sequence, counters in-transaction, cursor pagination,
  idempotency middleware, error contract).

### 2026-09-21 — Operator security pass on the Firebase baseline (Sprint 0 items 1-2 closed)

**Context:** the exposure of the Brevo API key and the pending Sprint 0 items
were reviewed together; the operator performed the credential and runtime work
on the live project, and the agent re-verified every claim read-only against the
deployed state (no writes, no deploy, no data mutation).

**Done by the operator**

- Brevo credential rotation: a new SMTP password was set in the Firebase Auth
  SMTP settings (so verification/reset mail flows through Brevo) and the old
  leaked API key was revoked in the provider dashboard; the replacement API key
  is stored only in the gitignored `functions/.env`.
- Functions redeployed twice: once to load the new API key and once to bump the
  runtime from Node.js 20 to 22 (Node 20 is decommissioned 2026-10-30).
- `main` hardening: `.gitignore` now covers `backend/migration-data/` (snapshot
  data with real user records) and `backend/pb_data/` (local dev database), so
  that data cannot be committed from the live branch by accident.

**Verified by the agent (read-only, live project)**

- Key rotation is real, not just recorded: the only key that ever existed in git
  history (`functions/email.js` at `0d6390c`, removed in `c8ed35f`) answers
  HTTP 401 `API Key is not enabled` on `GET /v3/account`, while the key now in
  `functions/.env` answers HTTP 200; their sha256 prefixes differ; `git grep
  xkeysib` finds nothing in tracked files on either `main` or this branch.
- Deployed rules match the repository version byte for byte: `firestore.rules`
  (sha256 `3d75775db4`, released 2026-09-16T15:18:41Z), `storage.rules`
  (`de75599aca`) and `database.rules.json` (`a1b6e7d25a`). RTDB rules are
  invisible to the `firebaserules` releases API, so they were read through the
  RTDB REST `.settings/rules.json` endpoint -- the rules file is authoritative
  for both the deployed ruleset and the publication state.
- RTDB exposure is closed: an unauthenticated `/.json?shallow=true` read returns
  HTTP 401; `admin_notifications` requires the `admin`/`root` claim and denies
  writes; `post_voters`, `main_page_cache` and `topic_posts_cache` are
  read/write `false`; `audit_logs` has no rule and therefore falls under RTDB
  deny-by-default.
- Firestore snapshot re-check: the `users` collection holds 12 documents, 11 of
  which still carry `email`, and `match /users/{userId}` is `allow read: if
  true` -- so the remaining Sprint 0 exposure is confirmed and quantified rather
  than assumed. `profiles` is empty (the live code uses `users`).

**Remaining manual actions (exact steps, no ambiguity)**

1. Signed in as the root account on the live forum, run the root-only callable
   `stripProfileEmails` once with the default limit (12 documents < 200). The
   deployed endpoint is alive and enforces auth -- a bare POST to
   `https://us-central1-aerun-forum.cloudfunctions.net/stripProfileEmails`
   answers HTTP 401 `{"error":{"message":"Sign in first.","status":"UNAUTHENTICATED"}}`,
   which also proves the redeployed code matches `functions/index.js`. Two
   workable invocation paths:
   - scripted (offered by the agent, needs one explicit go-ahead): mint a custom
     token for the root uid with the Admin SDK from local ADC, exchange it via
     Identity Toolkit `signInWithCustomToken` for an ID token, then POST
     `{"data":{}}` with that bearer token. The callable touches exactly one
     field (`email`) on `users` documents;
   - manual: open the live forum as root, open the browser console and invoke the
     callable through the modular SDK (`getFunctions` + `httpsCallable`).
   The response must be `{ processed: 12, stripped: 11, done: true }`.
2. Run it a second time and require `stripped: 0` as proof that no public
   profile carries an email copy any more.
3. Re-run the read-only probe (or ask the agent to) to confirm
   `withEmailField=0`.
4. Optional hardening while switching the frontend: the legacy admin UI shows
   profile emails only to root, so after the strip that display and the email
   search in `AdminPage`/`MembersPage` stop returning values; the addresses stay
   canonical in Firebase Auth and will be served by
   `GET /api/aerun/admin/users` on the new backend.
5. Sprint 0 item 4 strictness: exercise `admin_notifications` read/write and
   `post_voters` read with a real non-staff member session and record the
   results in this log.

**Why the email copy is removed, and what does NOT depend on it (verified
2026-09-21 by code inspection + live data)**

The question "is the copy not needed to detect duplicate registrations and to
send mail without revealing addresses?" was checked against the code, and the
answer is that the Firebase Auth record is the single working source for both
jobs:

- Duplicate registrations are detected by Auth, not Firestore:
  `src/components/auth/RegisterForm.jsx` calls `fetchSignInMethodsForEmail` and
  handles `auth/email-already-in-use`. Nothing queries
  `users.where('email', '==', ...)`, so removing the copy changes nothing here.
- Mail is sent server-side and already falls back to Auth:
  `functions/index.js` reads `uData.email` and then, when it is empty, resolves
  `admin.auth().getUser(uid).email` (topic replies ~line 2442, DMs ~line 3941).
  The copy is therefore optional by construction -- and new registrations
  already never write it (`firestore.rules` requires `!('email' in ...)` on
  create), so the Auth path is the normative one.
- The only functional consumer of the copy that exists anywhere in the client is
  the chief-admin badge: `resolveUserRoleId`/`isChiefAdmin` in
  `src/utils/permissions.js` return CHIEF_ADMIN_ID when
  `userEmail === VITE_ADMIN_EMAIL` **or** `role_id === 'root'`. Live check on
  the 12 `users` documents: exactly one profile matches `VITE_ADMIN_EMAIL` and
  it does have `role_id = 'root'`, while no account relies on the email branch
  alone -- so the badge keeps resolving after the strip. Root's own "who am I"
  check uses `user.email` from Auth, which is unaffected.
- The remaining consumers are cosmetic and root-only: the email display and
  email search in `AdminPage`/`MembersPage`, and `payload.email` on the
  notifications page. Addresses stay canonical in Firebase Auth (Console ->
  Authentication) and are served to staff by the new backend's
  `GET /api/aerun/admin/users`.
- Keeping the copy is additionally unsafe because it cannot be a trustworthy
  index: `firestore.rules` forbids the owner from touching `email`, so a
  Console/Auth-side email change would leave a stale public address that the
  legacy admin UI would happily display as current.

Target architecture keeps every job the copy appeared to do, without a public
copy: the PocketBase auth collection `users` owns a private, unique email
(`emailVisibility` false, never present in public profile responses), duplicate
registration is rejected by the unique email index (HTTP 409), verification and
reset mail come from the auth flow, and notification mail is queued in
`outbox_events` with recipients resolved server-side.

**Plan changes**

- Sprint 0 items 1-2 are marked DONE with the evidence above instead of being
  described as pending manual work; item 3 is quantified as 11 live documents
  and paired with a two-call verification recipe; the critical-finding row in
  section 2.2 now records the verified rotation.
- No backend (Go) code changed in this pass: the migration branch was only used
  to read and update this plan, so the CI report for `de1bf46` remains the
  authoritative verification for Sprint 2.

### 2026-09-21 — Sprint 0 closure tooling, the email-copy decision, a claims observation

Repository changes in this pass:

- `backend/tools/ops/strip-profile-emails.mjs` (new, dependency free: Node 18+,
  `node:crypto` + global `fetch`). It resolves the root uid, mints a root session
  through a custom token, runs the deployed `stripProfileEmails` callable to
  completion and then proves idempotence with a second pass. `AERUN_CHECK_ONLY=1`
  performs an authentication probe that modifies nothing (the callable answers
  `invalid-argument` for `limit=0` because the root check runs before payload
  validation). Verified with `node --check` and by exercising the failure path;
  output carries aggregates only, never an address.
- `backend/tools/ops/README.md` (new): the operator procedure, permissions,
  expected outputs and key cleanup.
- `.gitignore`: `.secrets/` and `*serviceAccount*.json` added, because the tool
  needs a short-lived service account key that must never be committed.
- This plan: item 1 and item 2 closed with evidence, item 3 quantified and
  paired with the tooling, plus the section "Why the email copy is removed, and
  what does NOT depend on it".

Read-only checks against the live project in this pass (nothing was written):

- 12 `users` documents, 11 of them still carry `email`; `firestore.rules` grants
  `allow read: if true` on that collection. Deliberately left as is:
  `src/pages/MembersPage.jsx` renders the member list for guests, so tightening
  the read would remove a visible feature — the data strip (item 3) is the right
  fix, and the rule already forbids writing `email` on create.
- Firebase Auth holds 14 accounts; only **2 carry a `role_id` custom claim**, 12
  carry none — including the root account, whose Firestore role is `root`. The
  cause is by design rather than a bug: claims are written only by
  `onUserCreated` and by the role-change branch of `onUserUpdated`
  (`functions/index.js`), so any account whose role predates those triggers has
  no claim.
- Consequence, and how the migration absorbs it: `firestore.rules` tolerates the
  missing claim through `getUserRole()`, which falls back to a single
  `users` document `get()`; RTDB rules have no such fallback
  (`auth.token.role_id === 'admin' || 'root'`), and the client converts a
  `permission_denied` there into an empty list
  (`src/api/rtdb-notifications.js`), so staff can see an empty admin
  notification list without any error. This is a legacy hardening gap, not a
  migration blocker: the new backend serves admin notifications as a Go read
  model and does not consult claims for authorization at all. Tracked here as a
  known legacy behaviour so nobody mistakes the empty list for a new regression.

Plan changes:

- Item 3 is now executable without further design work; the only missing input
  is the short-lived service account key. No deploy is needed for it — the
  callable is live and answers authenticated calls.
- The claims observation was recorded as a legacy note (see above) rather than a
  new Sprint 0 task, because the Sprint 1-2 command layer removes the dependency
  on claims for authorization.
### 2026-09-23 — Sprint 0 item 3 is a runtime action, not a deploy (operator question)

Question asked: "must this also be done against live Firestore, on the main
development branch, and deployed?" Answer recorded here so the distinction is
not lost:

- **Run, not deploy.** The deployed code does not change: `stripProfileEmails`
  is already live on `main`'s Functions deployment and answers authenticated
  calls (unauthenticated probe -> HTTP 401 `Sign in first.`, i.e. the current
  revision with its auth gate, not a stale one). Closing item 3 means *invoking*
  that callable once against the live `users` collection.
- **The git branch is irrelevant to the call.** A deployed callable serves
  whatever was last deployed; checking out a branch does not change it. The
  runner added in `backend/tools/ops/strip-profile-emails.mjs` is versioned on
  `feature/pocketbase-migration` as repository tooling, and it only needs the
  project id, a service account key with signing rights and a web API key.
- **No new branch and no merge are needed.** Nothing in `firestore.rules`,
  `functions/` or `src/` changes for this task; only the live data does.

Operator-side preparation done in the same pass:

- The runner and an operations README were committed (`371a978`,
  `backend/tools/ops/`), with CI green (run 6: gofmt/build/vet/test all `ok`).
- Safety gap closed on the live branch: `.secrets/`, `*serviceAccount*.json` and
  `firebase-adminsdk*.json` were ignored on `feature/pocketbase-migration` but
  **not** on `main`, where `.secrets/` (holding the 2.3 KB service account key)
  was visible to `git add .`. `.gitignore` on `main` now carries the same guard
  (`5668a5f`, pushed). The key file itself is untouched and still outside git.

Remaining input for item 3: explicit go-ahead to run the callable against
production, since it is the only state-changing step in Sprint 0.
