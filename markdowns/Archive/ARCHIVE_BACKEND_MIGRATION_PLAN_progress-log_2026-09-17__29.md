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
   **DONE 2026-09-21 (executed and independently verified).** Read-only probe
   before the run: the `users` collection held 12 documents and 11 of them still
   carried an `email` field, while `firestore.rules` grants
   `match /users/{userId}` `allow read: if true` -- those 11 addresses were
   world readable. The root-only `stripProfileEmails` callable
   (`functions/index.js`) was invoked through
   `backend/tools/ops/strip-profile-emails.mjs`:
   `batch 1: processed=12 stripped=11 done=true`, then an automatic second pass
   `processed=12 stripped=0 done=true` proving idempotence. Independent
   verification (not the tool's own report): a separate ADC-authenticated
   read-only scan showed `users` with `withEmailField=0`, and a sweep of all 15
   root collections (`audit_logs`, `categories`, `category_groups`, `designs`,
   `dms`, `forum_stats`, `guest_activity`, `notifications`, `posts`,
   `reputation_logs`, `roles`, `settings`, `topic_subscriptions`, `topics`,
   `users`) found `withEmailField=0` everywhere -- so no collection anywhere in
   Firestore exposes an email field through its public read rules. Firebase Auth
   still holds the canonical data: 14 accounts, all 14 with an email, 0 disabled,
   providers `google.com` + `password`. Accepted side effect: the legacy admin UI
   shows a profile email only to root (`isRootAdmin ? u.email : '***'`), so root
   no longer sees it in AdminPage/MembersPage and the email search there finds
   nothing; addresses remain in Console -> Authentication and are served to staff
   by the new backend's `GET /api/aerun/admin/users`. The chief-admin badge is
   unaffected because `isChiefAdmin` accepts `role_id === 'root'` as well, and the
   live document still has that role.

   **App Check obstacle, resolved (2026-09-21).** The first attempt failed at the
   custom-token exchange: the project enforces App Check on Identity Toolkit, so
   the client-SDK form (`accounts:signInWithCustomToken?key=<web api key>`)
   answers `HTTP 401 UNAUTHENTICATED "Firebase App Check token is invalid"`. A
   read-only diagnostic showed the same request authenticated with a service
   account access token is accepted (`HTTP 200`, valid ID token), and that
   `accounts:lookup` works the same way. The tool therefore authenticates both
   Identity Toolkit calls with the service account token and needs no web API
   key at all; no production setting (App Check enforcement, rules, function
   config) was weakened or changed.

   **Tool (2026-09-21).** `backend/tools/ops/strip-profile-emails.mjs` performs
   the root session, the call, and the idempotence proof in one command
   (dependencies: Node 18+; procedure and cleanup in
   `backend/tools/ops/README.md`). It supports `AERUN_CHECK_ONLY=1`, which proves
   that the synthesised root session is accepted (the callable answers
   `invalid-argument` for `limit=0`, and the root check runs before payload
   validation) **without modifying a single document**; that probe
   (`auth probe: HTTP 400 status=INVALID_ARGUMENT message="limit must be an
   integer from 1 to 400."`) passed before the real run. The run needs a
   short-lived service account key at the gitignored
   `.secrets/aerun-service-account.json`; **delete that key and the file after
   the run.**

   No deploy is required for this item: the callable was already deployed on
   2026-09-21 and answers authenticated calls (an unauthenticated probe returns
   `unauthenticated` / "Sign in first."), so nothing in the repository had to
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
Status 2026-09-21 (after the strip run): rotation, rules deployment and the
profile email removal are all complete and independently verified, so the only
Sprint 0 item still open is the manual permission test sheet with a real member
token (item 4). Item 3 no longer exposes anything: a read-only sweep of all 15
root collections reports zero email fields, and Firebase Auth (14 accounts, all
with email) remains the canonical source. The strip removed only the public
copies, and the addresses are recoverable from Auth at any time.
Outstanding operator action: delete the short-lived service account key created
for the strip (Google Cloud -> Keys -> Delete) and the local
`.secrets/aerun-service-account.json` file.

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

### 2026-09-24 — Sprint 3 completed: forum transactional command layer and 100-concurrency DoD verified

**Stage:** Sprint 3 fully implemented and tested. All tasks completed, including the 100-concurrency Definition of Done benchmark test.

**Done**

- Schema migration `internal/migrations/1766100000_forum_command_layer.go`:
  - `categories` with bootstrap row "General", slug index `idx_categories_slug`;
  - `topics` with keyset indexes `idx_topics_list` (`pinned, last_post_created, id`), `idx_topics_category_list`, and `idx_topics_author`;
  - `posts` with unique composite index `idx_posts_topic_sequence` (`UNIQUE(topic_id, sequence)`) and `idx_posts_author`;
  - Browser rules locked (superuser-only) pending Sprint 4 visibility rules.
- Framework-free domain package `internal/forum`:
  - Input validation for topic title (1..256 runes) and post content (1..65536 runes);
  - Domain constraints (`MaxPostsPerTopic = 5000`, `DefaultPageLimit = 20`, `MaxPageLimit = 100`);
  - Keyset pagination limit clamping and unit tests (`validation_test.go`).
- Error contract middleware (`internal/platform/pocketbase/errors.go`):
  - Wraps `/api/aerun/*` group, normalising errors into:
    `{ "data": { "retryable": bool, "conflict": bool, "forbidden": bool, "validation": bool, "kind": string, "request_id": string }, "message": string, "status": int }`.
- Idempotency middleware and transactional runner (`internal/platform/pocketbase/idempotency.go`):
  - Requires `Idempotency-Key` header (`[A-Za-z0-9_.:-]{1,255}`);
  - `runCommand`: single SQLite transaction committing domain records and idempotency envelope;
  - Replays successful responses byte-for-byte with header `Idempotency-Replayed: true`;
  - Detects key reuse with payload mismatches as `409 Conflict`.
- Transactional forum command endpoints:
  - `POST /api/aerun/topics`: atomic creation of topic + opening post (`sequence=1`), initializes `last_post_*` projection;
  - `GET /api/aerun/topics`: keyset pagination over `(pinned, last_post_created, id)`;
  - `GET /api/aerun/topics/:id`: topic details;
  - `PATCH /api/aerun/topics/:id`: title editing (author/mod), lock/unlock (`close_topics`), pin/unpin (`pin_topics`);
  - `POST /api/aerun/topics/:id/move`: category move (`move_topics`);
  - `DELETE /api/aerun/topics/:id`: soft deletion (`moderate_content` or author);
  - `POST /api/aerun/topics/:id/posts`: monotonic sequence assignment within topic transaction, enforce max post cap and lock state, updates `posts_count` & `last_post_*` atomically;
  - `GET /api/aerun/topics/:id/posts`: ordered post list with cursor pagination;
  - `GET /api/aerun/topics/:id/posts/by-sequence/:sequence`: sequence deep link lookup;
  - `PATCH /api/aerun/posts/:id`: edit content, records `edited` timestamp and `editor_id` when edited by staff;
  - `DELETE /api/aerun/posts/:id`: soft deletion tombstone, updates visible post counts and recalculates `last_post_*` projection fallback;
  - `POST /api/aerun/topics/:id/posts/move`: moves posts across topics, resequences target slots, and updates both topic projections atomically.
- Comprehensive test suite (`forum_commands_test.go`):
  - `TestCreateTopicAndFirstPost` & `TestCreateTopicValidationAndPermissions`;
  - `TestCreatePostSequenceAndLockedTopic`;
  - `Test100ConcurrentPostsAndIdempotency`: verifies DoD with 100 parallel goroutines issuing simultaneous post creation requests; confirms contiguous unique sequences 2..101, topic `posts_count=101`, byte-identical replay (`Idempotency-Replayed: true`), zero post count inflation on replay, and `409 Conflict` on payload mismatch;
  - `TestEditAndDeletePost`: covers post editing with moderator attribution, soft delete projection fallback, and deep-link sequence lookup;
  - `TestUpdateTopicAndMoveTopic` & `TestMovePostsBetweenTopics`;
  - `TestErrorContractEnvelope`: validates contract fields and flags.
- Formatting and compilation verification:
  - `gofmt -l .` reports zero unformatted files;
  - `go vet ./...` clean;
  - `go test ./...` 100% passing across all packages (`auth`, `config`, `forum`, `migrations`, `platform/pocketbase`).

**Sprint 3 DoD status:** Complete.

### 2026-09-24 — Live branch (`main`) merged into the migration branch (`7bd8f04`)

**Stage:** housekeeping sync requested by the operator. The six commits that
existed only on `main` are now part of `feature/pocketbase-migration`. No Go
code, migration or workflow file changed, so the CI-verified backend tree is
untouched.

**Done**

- `git merge origin/main` — clean 3-way merge, no conflicts, commit `7bd8f04`.
  Merged in:
  - `7e9d6cc` chore: ignore backend local data (migration snapshots, dev databases);
  - `33a252f` functions: bump runtime from Node.js 20 to 22 (Node 20 decommissioned 2026-10-30);
  - `5668a5f` chore: ignore one-off operational credentials on the live branch;
  - `129b0cb` fix(dm): drop local message cache on build change and revive serialized timestamps;
  - `340eac0` Added themable concept for developing;
  - `eb2816d` Added sandbox feature developing sprint-plan.
- The `.gitignore` guard from `5668a5f` (`.secrets/`, `*serviceAccount*.json`,
  `firebase-adminsdk*.json`) already existed on this branch, so the merge kept a
  single copy of those lines; the backend-local-data block from `7e9d6cc`
  (`backend/migration-data/`, `backend/pb_data/`) was added on top.
- `functions/package.json` is now on Node.js 22 on both branches and
  `src/api/dm-cache.js` carries the live DM cache fix, so the live-branch fixes
  are no longer trapped on `main` alone.
- Local `main` was three commits behind the remote; it was fast-forwarded to
  `eb2816d`, so the local copy of the live branch is no longer stale.

**Verification**

- `git diff fe86085 7bd8f04 -- backend .github` is empty: the tree CI exercises
  is byte-identical to the commit of CI run 8, so no new CI run is required.
  The `backend` workflow is path-filtered on `backend/**`, which this merge does
  not touch.
- Re-run locally after the merge: `gofmt -l .` (empty), `go build ./...` (ok),
  `go vet ./...` (ok), `go test ./... -count=1` (every package `ok`, including
  the 100-concurrency Sprint 3 DoD test).
- Nothing from `main` was lost: no file is deleted relative to `origin/main`,
  and the nine files `main` touched are byte-identical to `origin/main`.

**Impact:** `origin/main` (`eb2816d`) is now an ancestor of
`feature/pocketbase-migration`, so merging this branch into `main` later is a
fast-forward. A local rollback ref `backup-feature-before-main-sync` still points
at `fe86085`; it can be deleted once the sync is accepted.


### 2026-09-24 — Guest role granted the global `view_forum` baseline (`1b8752b`)

**Stage:** defect fix reported during local acceptance testing of Sprint 3.
`GET /api/aerun/me` answered an unauthenticated caller with
`"permissions":[]`, i.e. anonymous visitors could not read the forum.

**Root cause:** `1766000000_identity_rbac.go` seeded the `guest` role from the
compiled matrix with an empty permission set, on the assumption that guests
would only reach the forum through category-level `view_forum` overrides. The
legacy constants never encoded that assumption: `MAX_ROLE_PERMISSIONS.guest` in
`src/constants/permissions.js` lists `view_forum` (plus `post_reply` and
`use_dice`) as the guest ceiling, and `DEFAULT_ROLES` only left the *global*
guest row empty because the legacy rules fell back to reading the role document
per category (`SESSION_HANDOVER.md`, the 2026-07-25 guest `permission-denied`
fix). A guest with no global permission is therefore locked out of every read
path that has no explicit override — a regression against the product contract.

**Done**

- `internal/auth/role.go`: `RoleGuest.Permissions` is now `[view_forum]`; the
  spec comment records why. The full legacy guest ceiling (`post_reply`,
  `use_dice`) is deliberately **not** granted: those are writes and the target
  contract keeps guests read-only until a category-level grant exists.
- `internal/platform/pocketbase/access.go`:
  - `guestAccess()` returns the compiled guest baseline instead of a hard-coded
    empty slice, so `/api/aerun/me`, `AccessFrom` and the route guards agree;
  - `rolePermissions()` no longer folds guests into the "unknown role" branch:
    an empty `role` value still denies everything, while `guest` resolves to the
    compiled baseline (guests are never stored identities, so there is no row);
  - `AccessContext` doc comment updated (guest baseline now, category-level
    narrowing with the Sprint 4 read models).
- New migration `1766200000_guest_view_forum.go`: replaces the permissions of
  the already-seeded `guest` `roles` row with `[view_forum]`, creating the row
  from the compiled spec if a database predating the roles seed is migrated.
  The pre-existing migration was **not** edited (applied migrations are
  immutable); fresh installs get the new value straight from the seed and this
  migration is then a no-op. The down path restores the previous empty set.
- Tests:
  - `internal/auth/auth_test.go`: guest must hold exactly `view_forum`; an
    active guest keeps it while a banned guest loses it;
  - `internal/migrations/guest_view_forum_test.go` (new): seed contract, repair
    of a pre-fix row (`[]` → `[view_forum]`), recreation of a missing row from
    the spec, and the down path;
  - `internal/platform/pocketbase/http_test.go`: `TestMeMatrix` guest case now
    expects `"permissions":["view_forum"]`.
- `backend/README.md`: the permission-resolution paragraph documents the guest
  baseline and the pending/banned narrowing.

**Verification**

- `gofmt -l .` empty; `go build ./...` ok; `go vet ./...` ok;
  `go test ./... -count=1` — every package `ok` (including the 100-concurrency
  Sprint 3 DoD test).
- Live check against the local data directory (`backend/pb_data`, restarted so
  the new migration ran):
  - `GET /api/aerun/me` → `{"role":"guest","permissions":["view_forum"],…}`;
  - `GET /api/aerun/topics` → `200` `{"items":[],…}`.
- Unchanged by design: `pending` still narrows to `view_forum` + self-edit
  rights, `banned` still denies everything, and `RequirePermission` still
  answers `401` for guests on write routes (`create_topic`, `post_reply`).
- Machine-verified by CI run 9 (`.github/workflows/backend.yml`, report on the
  `ci-report` branch for commit `321c6ac`): `gofmt`/`build`/`vet`/`test` all
  `ok`.
- The frontend is deliberately **not** touched: the legacy Firebase app keeps
  running its own `DEFAULT_ROLES`, where the guest row stays empty by design
  and category reads fall back to the role document. `src/constants/permissions.js`
  already lists `view_forum` in `MAX_ROLE_PERMISSIONS.guest`, so the value only
  has to move into `DEFAULT_ROLES.guest` at cutover, together with the route
  switch — changing it now would widen access on the live branch without an
  operator decision.

**Impact:** guests (and any unauthenticated read path) now pass the global
`view_forum` gate, which is the precondition for the Sprint 4 category read
models. No frontend or Cloud Functions change: the legacy Firebase app keeps
its own `DEFAULT_ROLES`, and `src/constants/permissions.js` only needs the same
value when it is switched onto this backend.


### 2026-09-25 — Sprint 4: Reputation, subscriptions and audit completed

**Stage:** Sprint 4 of the backend migration plan.

**Done**

- Schema migration `internal/migrations/1766300000_sprint4_reputation_subscriptions_audit.go`:
  - `reputation_votes` table: tracks post and profile votes; partial unique indexes `idx_rep_voter_post` (`UNIQUE(voter_id, post_id)` where `post_id != ''`) and `idx_rep_voter_profile` (`UNIQUE(voter_id, target_id)` where `post_id = ''`); keyset indexes `idx_rep_target_created` and `idx_rep_post_created`; browser rules locked;
  - `topic_subscriptions` table: tracks topic follows with unique index `idx_sub_topic_user` (`UNIQUE(topic_id, user_id)`); keyset index `idx_sub_user_created`; browser rules locked;
  - `audit_logs` table: append-only ledger for staff moderation actions (`action_type`, `performer_id`, `details`, `created`); keyset index `idx_audit_created_id` (`created DESC, id DESC`); browser writes and deletions locked;
  - Added `reputation` integer counter field to `users` and `posts` collections;
  - Added `permissions` JSON field to `categories` collection for per-category role ACLs.
- Domain rules and validation (`internal/forum`):
  - `ValidateReputationVote`: verifies voter != target (prohibits self-voting), value in `{-1, 1}`, comment length <= 1024 runes;
  - Unit tests in `internal/forum/validation_test.go`.
- Idempotency middleware resilience (`internal/platform/pocketbase/idempotency.go`):
  - Broadened duplicate detection in `runCommand` to handle PocketBase's wrapped `validation_not_unique` error format as well as SQLite's raw `UNIQUE constraint failed`.
- Reputation voting and queries (`internal/platform/pocketbase/reputation.go`):
  - `POST /api/aerun/posts/:id/vote`: transactional vote creation or controlled replacement, updates post score and target author reputation atomically;
  - `DELETE /api/aerun/posts/:id/vote`: voter vote withdrawal, reverting scores;
  - `POST /api/aerun/users/:id/vote`: profile reputation vote;
  - `DELETE /api/aerun/users/:id/vote`: profile vote withdrawal;
  - `DELETE /api/aerun/reputation/:id`: administrative vote deletion by staff, appends audit log (`reputation_deleted`);
  - `GET /api/aerun/posts/:id/voters`: lists voters on a post; enforces category visibility (`403 Forbidden` if category access is denied);
  - `GET /api/aerun/users/:id/reputation`: keyset-paginated reputation history; enforces user privacy settings (`rep_show_history`, `rep_show_comments`) for non-staff, and strips `post_id`/`topic_title` for votes originating from categories the caller cannot view.
- Subscriptions (`internal/platform/pocketbase/subscriptions.go`):
  - `POST /api/aerun/topics/:id/subscribe`: idempotent subscription command, verifies category access;
  - `POST /api/aerun/topics/:id/unsubscribe` & `DELETE /api/aerun/topics/:id/subscription`: idempotent unsubscription command;
  - `GET /api/aerun/topics/:id/subscription`: subscription status inquiry;
  - `GET /api/aerun/me/subscriptions`: keyset-paginated subscriptions for the caller.
- Audit logging (`internal/platform/pocketbase/audit.go`):
  - Server-side `recordAuditLog` integrated inside administrative forum actions (`topic_pin`, `topic_lock`, `topic_title_edit`, `topic_move`, `topic_delete`, `post_edit`, `post_delete`, `posts_move`, `reputation_deleted`);
  - `GET /api/aerun/admin/audit-logs`: keyset-paginated audit inquiry gated by `view_audit_log` permission (root/admin only), with filtering by `action_type` and `performer_id`.
- Category access control helper (`internal/platform/pocketbase/category_access.go`):
  - `canViewCategory` and `canViewTopic` evaluate role access against category `permissions` JSON (`view_forum` role list) and caller status.
- Verification and DoD compliance (`internal/platform/pocketbase/sprint4_test.go` and `internal/migrations/sprint4_test.go`):
  - Schema migration assertions;
  - Voting, score updates, replacements, and vote deletions;
  - Idempotent subscriptions without toggle races;
  - Administrative audit logging across moderation commands;
  - DoD test: 20 concurrent identical vote requests and 20 concurrent subscribe requests produce strictly 1 database record each, correct scores without inflation, and byte-identical replays;
  - DoD test: secret category post never leaks through post voters endpoint (`403`) or user reputation history (masked data).
- Formatting and clean verification:
  - `gofmt -l .` empty;
  - `go vet ./...` clean;
  - `go test ./...` 100% passing across all packages.

**Sprint 4 DoD status:** Complete.


### 2026-09-25 — Sprint 5: Direct messages, notifications and mail outbox completed

**Stage:** Sprint 5 of the backend migration plan.

**Done**

- Schema migration `internal/migrations/1766400000_sprint5_dms_notifications_outbox.go`:
  - `dm_conversations` table: stores conversation thread metadata (`title`, `last_message`, `last_message_at`, `messages_count`); locked browser rules;
  - `dm_members` table: stores per-user thread membership, read progress (`last_read_sequence`) and `cleared_at` horizon; unique constraint `UNIQUE(conversation_id, user_id)`; locked browser rules;
  - `dm_messages` table: stores sequential messages with monotonic per-conversation sequence; unique constraint `UNIQUE(conversation_id, sequence)`; locked browser rules;
  - `notifications` table: stores persistent in-app notifications (`recipient_id`, `sender_id`, `type`, `title`, `payload`, `read`, `archived`); locked browser rules;
  - `outbox_events` table: append-only transactional outbox for reliable asynchronous email delivery (`dedupe_key`, `event_type`, `payload`, `status`, `attempts`, `max_attempts`, `last_error`, `next_attempt_at`, `sent_at`); unique constraint `UNIQUE(dedupe_key)`; locked browser rules.
- Framework-free domain package `internal/messaging`:
  - Input validation: `ValidateMessageText` (1..65536 runes), `ValidateConversationTitle` (max 256 runes), `ValidateParticipants` (1..50 unique active recipients);
  - Deterministic dedupe key generation: `MakeDMUnreadDedupeKey(convID, recipientID)` -> `dm:first-unread:{conv}:{recipient}`;
  - Unit tests in `internal/messaging/validation_test.go`.
- Configuration and explicit no-SMTP mode (`internal/config`):
  - Added `MailMode` configuration field, validating `AERUN_MAIL_MODE` to allow `disabled` (local/test default) and `smtp` (production relay);
  - Unit tests in `internal/config/config_test.go`.
- Direct messages and membership commands (`internal/platform/pocketbase/dms.go`):
  - `POST /api/aerun/dms`: atomic creation of conversation, members, opening message (`sequence=1`), recipient in-app notifications, and deduplicated email outbox events;
  - `POST /api/aerun/dms/:id/messages`: monotonic sequence assignment within the conversation transaction; updates conversation `last_message` and `last_message_at`, advances sender `last_read_sequence`, creates recipient notifications and enqueues deduplicated outbox event;
  - `GET /api/aerun/dms`: keyset-paginated conversations for caller with unread message counts, excluding cleared conversations without new activity;
  - `GET /api/aerun/dms/:id/messages`: lists ordered messages, respecting caller's `cleared_at` horizon;
  - `POST /api/aerun/dms/:id/read`: marks conversation as read, advancing member's read sequence to current maximum and clearing related DM in-app notifications;
  - `POST /api/aerun/dms/:id/clear`: marks conversation cleared for caller (`cleared_at = now`).
- In-app notifications and unread counters (`internal/platform/pocketbase/notifications.go`):
  - `GET /api/aerun/me/notifications`: keyset-paginated notification feed with optional `unread` filter;
  - `PATCH /api/aerun/me/notifications/:id/read`: mark notification read with ownership validation;
  - `POST /api/aerun/me/notifications/read-all`: mark all caller's notifications read;
  - `PATCH /api/aerun/me/notifications/:id/archive`: archive notification;
  - `GET /api/aerun/me/unread-counts`: aggregated unread counts (`unread_notifications`, `unread_conversations`, `total_unread_messages`), replacing RTDB unread badges.
- Outbox worker and admin controls (`internal/platform/pocketbase/outbox.go`):
  - Background worker processing pending events with exponential backoff on delivery failure;
  - Admin inspection endpoint: `GET /api/aerun/admin/outbox-events` (root/admin only, `view_audit_log`);
  - Admin retry endpoint: `POST /api/aerun/admin/outbox-events/:id/retry`.
- Verification and DoD compliance (`internal/platform/pocketbase/sprint5_test.go` and `internal/migrations/sprint5_test.go`):
  - Schema migration assertions covering all five collections, rules, and unique indexes;
  - DM conversation creation, monotonic sequencing, read markers, unread counts, and cleared horizon;
  - Concurrency DoD: 20 simultaneous messages sent to the same conversation produce strictly contiguous unique sequences (2..21) and exact `messages_count=21`;
  - Worker DoD: restarting the worker never reprocesses or re-sends an already successful (`status='sent'`) event;
  - Email resilience DoD: when SMTP is disabled or unavailable (`AERUN_MAIL_MODE=disabled`), all forum and DM actions succeed 100% without failure or dependency on email dispatch.
- Formatting and clean verification:
  - `gofmt -l .` reports zero unformatted files;
  - `go vet ./...` clean;
  - `go test ./...` 100% passing across all packages.

**Sprint 5 DoD status:** Complete.


### 2026-09-25 — Sprint 6: Frontend adapter, PocketBase client and runtime Firebase elimination completed

**Stage:** Sprint 6 of the backend migration plan.

**Done**

- PocketBase Client and Error Abstraction (`src/api/pocketbase.js`):
  - Initialized official `pocketbase` SDK client (`pb`) using `VITE_POCKETBASE_URL` (defaulting to `http://127.0.0.1:8090`);
  - Implemented `sendApi(path, options)` wrapper: automatically forwards PocketBase auth token (`pb.authStore.token`), injects `Idempotency-Key` headers on mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`), handles structured `ApiError` mapping with request IDs and retryability flags;
  - Added `generateIdempotencyKey()` for request deduplication.
- Presence System (`backend/internal/platform/pocketbase/presence.go` & `src/api/rtdb-presence.js`):
  - Backend endpoints: `POST /api/aerun/presence/heartbeat` and `GET /api/aerun/presence/online-users`;
  - Replaced Firebase RTDB presence listeners (`status/{uid}`, `.info/connected`) with a periodic lightweight heartbeat and online users polling.
- Domain API Migration across `src/api/*`:
  - `src/api/categories.js`: replaced Firestore listeners/queries with `GET /api/aerun/categories`;
  - `src/api/forum.js`: migrated topic creation, post replies, edits, moves, deletions, and keyset-paginated queries to `/api/aerun/topics` and `/api/aerun/topics/:id/posts` domain endpoints;
  - `src/api/reputation.js`: migrated post votes, profile votes, voter lists, and reputation logs to `/api/aerun/posts/:id/vote`, `/api/aerun/users/:id/vote`, `/voters`, and `/reputation` domain endpoints;
  - `src/api/subscriptions.js`: replaced Firestore queries with `/api/aerun/topics/:id/subscription`, `/subscribe`, `/unsubscribe`, and `/me/subscriptions`;
  - `src/api/dms.js`: migrated DM creation, messaging, read tracking, and clear operations to `/api/aerun/dms` domain endpoints;
  - `src/api/dm-cache.js`: removed Firebase `Timestamp` import, replaced with self-contained timestamp revival;
  - `src/api/notifications.js` & `src/api/rtdb-notifications.js`: migrated notifications and unread badges to `/api/aerun/me/notifications`, `/read`, `/read-all`, `/archive`, and `/me/unread-counts`;
  - `src/api/admin.js` & `src/api/audit.js`: migrated user management and audit log inspection to `/api/aerun/admin/users` and `/api/aerun/admin/audit-logs`;
  - `src/api/auth-resources.js`: migrated read map, latest topics, and user presence helpers;
  - `src/api/character.js` & `src/api/designs.js`: adapted to PocketBase user settings and local collections.
- Authentication & Profile Provider (`src/contexts/AuthProvider.jsx`):
  - Wired into `pb.authStore` reactive listener (`pb.authStore.onChange`);
  - Replaced Firebase Auth calls (`signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signInWithPopup`, `signOut`, `sendPasswordResetEmail`) with PocketBase collection auth and `/api/aerun/auth/register`;
  - Profile and settings synchronization through `pb.authStore.record`, `/api/aerun/me`, and `/api/aerun/me/settings`.
- UI Components Cleanup:
  - `src/components/auth/RegisterForm.jsx`: registration via `useAuth().registerWithEmail` and domain validation;
  - `src/components/common/ConnectionStatusBanner.jsx`: network detection via browser online/offline and backend `/api/aerun/health` probes;
  - `src/components/common/AvatarUploader.jsx`: replaced Firebase Storage with in-browser image optimization;
  - `src/components/common/RichEditor.jsx`: prefix user mentions query via PocketBase users collection;
  - `src/components/profile/SecurityTab.jsx`: password change and OAuth2 linking via PocketBase;
  - `src/pages/TopicPage.jsx`: removed unused Firestore/RTDB imports and adapted author/mask hydration;
  - `firebase.js`: neutered into no-op facade without initializing Firebase runtime SDK.
- Verification and Definition of Done:
  - `git grep -i "from 'firebase"` and `from '../../firebase'` return 0 across all `src/` modules;
  - Backend test suite (`go test -count=1 ./...`) 100% passing;
  - `gofmt -l .` reports zero unformatted files;
  - `go vet ./...` clean.

**Sprint 6 DoD status:** Complete.


### 2026-09-25 — Sprint 7: idempotent importer core and two identical rehearsals completed

**Stage:** Sprint 7 of the backend migration plan (migration tooling and
rehearsals), building on the offline exporter/staging pipeline from
2026-09-17.

**Implemented** (`backend/tools/migration/importer/`)

- Per-record legacy → PocketBase mapping (`map.go`, Sprint 7 task 2):
  - Target ids are **derived** — SHA-256 of (collection space, legacy id)
    mapped onto PocketBase's 15-char `a-z0-9` record id alphabet (v0.40 rejects
    uppercase ids) — so a re-run of the
    same export addresses the same row instead of duplicating it, and two runs
    yield byte-identical `mapping.json` without any database. Only `users` has
    a `legacy_firebase_uid` column; every other relation is a bare `Max: 15`
    text column, which is why the id itself must be stable.
  - `Mappings.Add` refuses derived-id collisions (imports stop before writing
    rather than silently losing a record), the table is canonicalised
    (sorted by space, legacy id), written with `O_EXCL` like the Node staging
    pipeline, and reloadable as a checkpoint — `LoadMappingTable` re-derives
    every row and rejects a stale file.
  - Character subcollection rows and derived `dm_members` rows are mapped
    under their own spaces; composite `uid/characters/cid` keys never get
    record ids.
- Legacy identity compatibility (`compat.go`):
  - `MapUserRole` translates the legacy convention of encoding account state
    inside `role_id` (`pending`/`banned` pseudo-roles with the real role parked
    in `previous_role_id`) into the target's separate role/status model, folds
    custom role documents (`is_system=false`, e.g. `Demon`, `NorthbayCitizen+`)
    to their `base_role_id`, maps `guest` to `player` (a stored account is
    never a guest) and falls back to `player` for dangling role references —
    every non-trivial decision is reported, never silent.
  - `AuditPlan` aggregates role transitions, target statuses and
    representability findings (missing post sequences, category groups with no
    target table, folded custom roles, character docs folded into user
    settings). Examples are the 10 lexicographically smallest ids, not
    "first seen", because Go map order would otherwise make two reports of the
    same export differ and destroy the report diff the DoD relies on.
- Rehearsal driver + CLI (`rehearse.go`, `cmd/import-rehearse`):
  `Rehearse(ledger, auth)` runs load → plan → mapping → FK validation →
  `AuditPlan` → counter recomputation → reconciliation and reports elapsed
  time; `report.json` deliberately omits durations so two reports of one
  export diff clean, `mapping.json`/`report.json` are exclusively created, and
  non-zero exit is reserved for input errors or dangling foreign keys.
- Classification fixes found by running against the real export: per-user
  `readmap` and `drafts` subcollections are now named skips
  (`user_readmap`, `user_drafts`) instead of `unclassified` warnings;
  `AuditPlan` no longer audits `uid/characters/*` rows as accounts (they were
  producing fake `role_id missing` findings).

**Verification**

- Tests: new `map_test.go` (derivation format, stability across processes,
  collision refusal, checkpoint round-trip/staleness, full-bucket coverage)
  and `compat_test.go` (role/status translation table incl. the real export's
  `root`/custom-role cases, finding determinism across two plan builds).
  `gofmt -l .` empty, `go build ./...`, `go vet ./...`,
  `go test ./... -count=1` all green (importer package: ok; platform
  pocketbase suite: ok); Node staging tests 7/7 pass.
- Six full rehearsals of the real 11.3 MB `stage-1.json` + official Auth
  export: **5140 records, 5149 mapped ids (incl. derived dm_members), 0
  foreign-key errors, 9 findings, 3 counter mismatches, ~230 ms each run;
  `mapping.json` (SHA-256 `168468d0…50f`) and `report.json`
  (SHA-256 `50AB9784…3439CA`) byte-identical across all six runs** —
  Sprint 7 DoD's
  "two imports of the same export yield the same target state" holds for the
  analysis stage.
- The 3 counter mismatches are all stale cached values vs recomputed actuals
  (`user/…/post_count cached=335 actual=333`, two `reputation` deltas) —
  exactly the explainable class task 3 says to recompute rather than import.

**Not yet done in Sprint 7 / limits**

- This is still analysis + mapping + rehearsal output, **not a PocketBase
  writer**: no records are inserted into a database, sequence reconstruction,
  password import/linking, file reference validation and the Storage export
  remain. The mapping table is the checkpoint the writer will consume.
- Known input caveat: the ledger's top-level checksum is written in the Node
  canonical form, so Go logs a warning and skips strict checksum validation
  (the Node staging CLI validates it at creation).
- `readmap` is treated as a rebuildable cache; `drafts` (1 doc in the export)
  have no target collection and are reported as a gap for product decision.

**Sprint 7 DoD status:** analysis-stage DoD demonstrated (identical target
state from two rehearsals, all mismatches explained above); full sprint DoD
pending the writer and Storage/Auth finalization.

---

## Roles migration (first real write path)

The **system** roles are migrated from the snapshot by **reconciling the target
registry against the compiled matrix**, not by copying the source documents. This
is a deliberate decision, and the source data is what forces it:

- The target `roles` collection is the runtime authority and is already seeded
  from `auth.SystemRoles()` by migration `1766000000`. A compiled role id is the
  only id the runtime matrix knows, so a row with any other value could never be
  authorised.
- The snapshot's 5 system role documents *do* carry a `permissions` array, and
  they have drifted from the compiled specs. Importing them verbatim would let a
  stale export redefine what a role may do.

Reconciliation of the real `stage-1.json` (exit 0, nothing written in dry run):

| role | snapshot | compiled | verdict |
|---|---|---|---|
| `admin` | `Admin`, 37 perms | `Administrator`, 37 perms | permissions match, name differs |
| `guest` | 1 perm | 1 perm | match |
| `moderator` | 22 perms incl. `delete_reputation`, `edit_others_*`, `use_direct_messages` | 22 perms incl. `view_audit_log` | drift both ways |
| `player` | 13 perms | 14 perms incl. `view_master_dice` | compiled superset |
| `spectator` | 3 perms incl. `edit_self_avatar`, `edit_self_nickname`, `use_direct_messages` | 1 perm | legacy is broader |
| `root` | **no document** | 37 perms | target-only, seeded |

Imported verbatim since migration `1766500000`: the 4 legacy **custom** roles
(`Demon`, `Anaptix`, `NorthbayСitizen`, `NorthbayCitizen+`) holding 7 users. The
first pass of this plan folded them into `base_role_id` (`player` for all four)
and reported it; that was wrong, and the source data is what proved it:
`categories.permissions.view_forum` is a list of **role ids** that names custom
roles directly — category "Скрытые игры" is granted to
`PYaDjGY5XvWHNEjTswuz` and to nobody else. Folding the role away would both
erase the granted permission set and open that category to every player.

The schema now carries custom roles instead of excluding them:

- `users.role` is a `TextField` (was a closed `SelectField` over the six
  compiled ids, so a custom role could not even be assigned);
  `users.custom_role_id` remembers the system role a custom role derives from,
  which keeps "am I staff?" answerable from the compiled matrix and keeps rank
  ordering defined;
- `roles.base_role_id` and `roles.max_characters_limit` mirror the legacy role
  document; `categories.allowed_roles` replaces the inline permission map (an
  empty list = public, i.e. every role holding `view_forum`);
- the command layer (`admin_users.go`) validates a role against the **roles
  collection** rather than the compiled list, so an imported custom role is
  assignable and an unknown id is still rejected (it would otherwise resolve to
  deny-by-default).

Verified against a real throwaway database (`import-roles`):

- first run over a migrated db: `created=0 updated=0 unchanged=6 changed=false`
  (the migration seed already produced the correct registry);
- after deliberately corrupting `guest` (rank 999, wrong permission) and
  deleting `root`: `created=1 updated=1 unchanged=4 changed=true`, and both were
  restored to the compiled values;
- third run: `created=0 updated=0 unchanged=6 changed=false` — idempotent;
- with the 4 custom roles present: `created=4 unchanged=6` on the first run,
  `unchanged=10 changed=false` on the second — the custom rows are written
  idempotently too.

The permission enum still guards the **system** roles: an attempt to save `guest`
with a permission outside the enum is rejected by PocketBase
(`permissions: Invalid value delete_topic`), which is why a bad export cannot
widen a system role. A custom role's permission list is checked by the importer
against `auth.PermissionValues()`; an unknown entry is reported as a finding
(`custom_role_permission_unknown`) rather than written.

Code: `internal/platform/pocketbase/role_import.go` (writer, in the adapter
package because it is the only one allowed to import PocketBase),
`importer/roles.go` (reconciliation/audit), `cmd/import-roles` (CLI with
`-dry-run`).

Still not done: `users`, `categories`, `topics`, `posts` and the rest of the
domain writes, sequence reconstruction, password import/linking, file reference
validation, Storage export. The per-collection target schema, the id policy and
the level-ordered import map live in `POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md` —
that document is the contract for the next sprint.

---

### 2026-09-26 — Target schema map, custom roles as data, drafts as posts

**Stage:** Sprint 7 continued. The analysis artefacts of the previous session
(mapping table, rehearsal report) were turned into a written contract, and the
three schema decisions the rehearsal exposed were implemented.

**New: `POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md`** — the per-collection target
schema, the PocketBase id policy (derived 15-char ids from SHA-256 of
(space, legacy id); `legacy_firebase_uid` for `users`; `role_id` as the roles
business key), the 10-level import order with its foreign-key preconditions, and
the frontend contract for the drafts page. It replaces nothing and is the
document the next sprint (domain writer) implements against.

**Decisions taken from the snapshot**

- *Custom roles are data, not a fold.* `1766500000` makes `users.role` free
  text, adds `users.custom_role_id`, `roles.base_role_id`,
  `roles.max_characters_limit` and `categories.allowed_roles`; `importer/roles.go`
  now plans `CustomRows` (verbatim `role_id`, validated permissions, finding
  `custom_role_permission_unknown`) and `import-roles` writes them
  (`created=4 unchanged=6`, then `unchanged=10` — idempotent). The previous
  "custom role cannot be represented, fold to base" plan is retracted above.
- *Characters are rows, not a settings blob.* `1766600000` adds `characters`
  (owner_id, name, status_line, signature, avatar_url + historical dates) and
  `designs` (css/js/theme/welcome_message, one active per user), both
  server-only. The rehearsal used to fold 9 character documents into
  `users.settings`; `posts.author_character_id` needs them addressable.
- *Drafts are posts.* `1766700000` adds `posts.is_draft`, makes `sequence`
  optional, restricts the `topic_id+sequence` unique index to `sequence > 0`
  and adds `unique(author_id, topic_id) where is_draft` — the Firestore rule
  "one draft per author per topic" (the doc id *was* the topic id) is now a
  database constraint. `internal/platform/pocketbase/drafts.go` adds
  `GET /me/drafts` (orphans first), `GET|PUT /topics/{id}/draft`,
  `DELETE /drafts/{id}`, `POST /drafts/{id}/publish` (sequence + topic
  projections in one transaction, `409` for an orphan), and the public post
  reads filter drafts out. Integration test `drafts_test.go` covers the whole
  loop including idempotent re-save.
- *A user document without `role_id` is a dead record, not a role-less user.*
  The importer drops it (`orphan_user_dropped`) together with the reputation
  entries that point at it (`orphan_reputation_dropped`); auth rows with no
  profile at all are reported as `orphan_auth_record_dropped`. On the real
  export: 1 user + 1 reputation row dropped, mapping 5148 records,
  `foreignKeyErrors: null`. Rationale: every live account has a role, so a
  missing one can only be a half-written row.

**Two Sprint 6 build breaks found while verifying the commit** (neither was
visible from the Go side, both stopped `npm run dev` from booting):

1. `src/components/common/RichEditor.jsx` shipped in `2591610` with a dangling
   `} catch` — the `try {` of `handleUserSearch` was lost. Babel could not parse
   the module, which fails the whole app, not just the editor. Restored.
2. `src/components/layout/ForumStats.jsx` still imported
   `subscribeToActiveGuestsRtdb` from `src/api/rtdb-presence.js`, which Sprint 6
   dropped together with the RTDB status rows. A named import that no longer
   exists is a hard rollup error, so the production build failed too. Re-added as
   an honest stub: **guest presence is not tracked on the new backend** (a guest
   has no auth record to heartbeat with, and `GET /presence/online-users` returns
   accounts only), so the stats panel reports 0 guests until the product decides
   between reintroducing anonymous visitor tracking (a `guest_presence`
   collection keyed by a client-generated id) and dropping the counter.
   `initRtdbGuestPresence` / `removeRtdbGuestPresence` are no-ops for the same
   reason and were already left in place by Sprint 6. **Closed the same day:**
   the `guest_presence` collection is real — see the entry below.

Lesson recorded: a parse sweep of `src/` is not a build gate. `npm run build`
is — it is the only check that resolves every named import against its module,
and it is now part of the verification below.

**Verification:** `go build ./...`, `go vet ./...`, `gofmt -l` clean,
`go test ./... -count=1` all packages ok, `node --test snapshot.test.mjs` 4/4,
`npm run build` (3379 modules, built in 8.67s) and the dev server serving `/`,
`src/api/rtdb-presence.js` and `src/components/layout/ForumStats.jsx` with
`200`; two `import-rehearse` runs over the real export produce byte-identical
`mapping.json`/`report.json`.

### 2026-09-26 — Guest presence restored as a first-class collection (1766800000)

**Stage:** the guest counter in the stats panel is real again, and the product
decision left open by the Sprint 6 break above is settled: anonymous visitors are
tracked, in PocketBase, holding no PII.

The legacy contract was recovered from the repository instead of invented.
`database.rules.json` already carried `guest_presence/{guest_id} =
{ guest_id, last_seen }` with public read; `PROJECT_CONTEXT.md` marks the older
Firestore `guest_activity` collection DEPRECATED ("replaced by RTDB
guest_presence to eliminate document write costs"); and the pre-Sprint-6
`src/api/rtdb-presence.js` shows the exact client behaviour — a one-shot write on
connect, `onDisconnect().remove()`, a 15-minute window, and
`Math.random().toString(36).substring(2) + Date.now().toString(36)` as the
visitor id generator. All four survive in the new shape, which is why this is a
restoration rather than a new feature.

**What was built**

- `guest_presence` collection (migration 1766800000): `guest_id` (unique index),
  `first_seen`, `last_seen` (indexed). Server-only rules — the legacy node was
  world-writable (`.write: true`), the rewrite is not.
- Writes: `POST /presence/heartbeat` (the anonymous branch upserts a row; an
  authenticated beat stays on the in-process member map and can never create a
  guest row) and `POST /presence/guest/leave`.
- Reads: `GET /presence/guests` (`count`, `guests[]`, `window_seconds`) and
  `guests_count` on `GET /presence/online-users`, both served from one helper so
  the two endpoints cannot disagree. The list is public, like the legacy node and
  like the sibling endpoint that already publishes member nicknames.
- Retention prune on the PocketBase cron (`*/10 * * * *`), which replaces the old
  "the map only shrinks when somebody reads it" behaviour.
- Frontend: `initRtdbGuestPresence` beats once a minute and on tab refocus, sends
  a `sendBeacon` leave on `pagehide` (the HTTP stand-in for
  `onDisconnect().remove()`), `subscribeToActiveGuestsRtdb` polls the list into
  the `{ id, last_seen }` shape ForumStats already filters on, and AuthProvider
  generates the visitor id and clears it on login.

**Why a collection and not the in-memory map that already held guests:** the
anonymous heartbeat is the only unauthenticated write in the API, and its map key
was client-chosen, so the map could grow without bound as long as nobody listed
it. A row is bounded by a schema, collected on a schedule, survives a restart, and
`first_seen` keeps a unique-visitor question answerable later.

**Anti-abuse, because PocketBase ships `Settings().RateLimits.Enabled = false`**
and this deployment never enables it: the visitor id is validated (lowercase
alphanumeric, 8–64 characters) before any write, and the heartbeat carries its own
30-requests-per-minute per-IP budget. Both are covered by tests.

**Verification:** `go build`, `go vet`, `gofmt -l` clean; `go test ./...` all
packages ok (10 new tests in `presence_guest_test.go` and
`guest_presence_test.go`, including a live HTTP round trip through the real
router); `npm run build` clean; `npx eslint` on the two touched frontend files
adds no findings; and a backend started on a throwaway data dir answers
`count=1` after one heartbeat, `guests_count=1` on the sibling endpoint, and
`count=0` after the leave beacon.

---

### 2026-09-28 — CI run 12 red at `gofmt`: the LF/CRLF trap (`d778b0a`)

**Stage:** commit `5e5e8ce` (feat(api): consolidate presence status and expose
catalog routes) pushed a red backend run. Run 12 failed after 35s with
`"checks": {}` — not one key, which by the channel contract of section 5 means
the first step (`gofmt`) failed and build, vet and test never ran at all.

**Root cause:** three of the new files were not gofmt-clean. `catalog_designs.go`
and `catalog_roles.go` lacked the blank line before their mutation-form type
declaration, and `catalog_test.go` ended with a trailing blank line. Locally the
same files were reported by `gofmt -l` too, but the Windows worktree held them as
CRLF, and `gofmt` answers a CRLF file with a whole-file rewrite — so the real
hunks were buried inside a diff that read as a pure line-ending artifact and was
dismissed as one. The committed blobs are LF (`.gitattributes`:
`backend/**/*.go text eol=lf`) and the runner checks out LF, where the three hunks
are all that remain: exactly why "clean locally" and "clean on the runner"
disagreed. The `i/lf w/crlf` state is invisible to `git status` (git normalizes
both sides), which is how it survived review.

**Fix (`d778b0a`):** the three hunks formatted, and the touched Go files
normalized to LF in the worktree, so a local `gofmt -l .` now agrees with the
runner instead of contradicting it.

**Lesson recorded** in `.agent/rules/commands.md` ("Local gofmt must see LF"): a
`gofmt -l` finding is never dismissed as an encoding artifact — check
`git ls-files --eol <path>` for `w/crlf`, then gofmt the committed blob
(`cmd /c "git cat-file blob HEAD:<path> > %TEMP%\blob.go"`) to see what the Linux
runner sees, before deciding.

**Verification:** CI run 13 on `d778b0a` — `gofmt`, `build`, `vet`, `test` all
`ok` (report on the `ci-report` branch). Locally: `gofmt -l .` empty,
`go build ./...` ok, `go vet ./...` ok, `go test ./... -count=1` every package ok
(`platform/pocketbase` alone 36.9s — itself the proof that a 35s failure could
only be the gofmt step).


---

### 2026-09-28 — Sprint 2 task 3 closed: Google OAuth enabled end-to-end (credentials in place)

**Stage:** the human prerequisite landed — `.env.local` at the repository root
(gitignored) now carries `AERUN_GOOGLE_CLIENT_ID` / `AERUN_GOOGLE_CLIENT_SECRET`
for the `aerun-test` Google Cloud project, so the last open Sprint 2 item could
be closed. The one step that needs a human is the browser click itself (consent
as `sijunma116@gmail.com`).

**Diagnosis:** `Missing or invalid provider "google"` is thrown by the
PocketBase JS SDK *before* any network round trip — it reads
`GET /api/collections/users/auth-methods` and refuses a provider that is not
listed. The server answered `{"oauth2":{"providers":[],"enabled":false}}`
because `1766000000_identity_rbac.go:115` deliberately sets
`users.OAuth2.Enabled = false` while the provider was unconfigured.

**Decision — reconcile at serve time, not a new migration.** Credentials are
environment state, not schema, and a migration runs exactly once: a first
credential-less boot would enable nothing and never look again, and a rotated
secret would strand a stale `clientSecret` in `pb_data` until the next schema
change. The new `configureOAuth2` (`internal/platform/pocketbase/oauth2.go`)
therefore runs from the existing `OnServe` hook in `Run` — after `apis.Serve`
applied `RunAllMigrations` (`apis/serve.go:67` vs the `OnServe` trigger at
`:217`) — and rewrites `users.OAuth2` from the configuration on every startup:
a complete pair enables exactly the `google` provider (client id/secret only;
endpoints, PKCE and scopes stay on PocketBase's Google defaults), anything
else restores the migration baseline of disabled. Password auth is untouched,
and `identity_test.go` still pins the disabled migration baseline — its message
now says who enables it and why.

**Second find — the Go process never saw `.env.local`.** A repository-root
`.env.local` is a Vite/Node convention; the backend reads the process
environment only (`config.Load(os.Getenv)`, as documented in
`backend/.env.example`), so the credentials would never have reached it.
`config.SeedDotEnv` (`internal/config/envfile.go`) closes that gap: no new
dependency, probes `.env.local` in the working directory and then its parent
(so a server started from `backend/` finds the root file), and seeds only keys
that are not already set — a real environment variable always wins, and
production ships no such file. `cmd/aerun` calls it before `config.Load` and
logs the path, never values. A malformed line fails startup loudly instead of
silently dropping a credential, and `Load` rejects a half pair
(`AERUN_GOOGLE_CLIENT_ID` xor `AERUN_GOOGLE_CLIENT_SECRET`).

**Verification:** `gofmt -l .` empty (new files are LF in the worktree — the CI
run 12 lesson), `go vet ./...` and `go test ./... -count=1` green, including
`TestConfigureOAuth2ReconcilesGoogleLogin` (enable / idempotent / half pair /
withdraw, with password auth and the unmapped fields proven to survive),
`TestParseDotEnv*`, `TestSeedDotEnv*` and `TestLoadGoogleCredentialsPair`.
Live probe on the restarted process: `local env file seeded path=../.env.local`,
`auth-methods` returns `{"providers":[{"name":"google","displayName":"Google",
"codeChallengeMethod":"S256",…}],"enabled":true}` with the client id from
`.env.local`, and the assembled authorization URL answered **302 to
accounts.google.com** — a wrong client id or an unregistered redirect URI
would have produced a 400 `redirect_uri_mismatch`, so the console entry
`http://127.0.0.1:8090/api/oauth2-redirect` is confirmed correct. A read-only
dump of `pb_data` shows `sijunma116@gmail.com` as the active, verified `Arin`
record with zero `_external_auths` rows, so the first Google login links by
email and never touches the password.

**Limits recorded:** the client secret now lives in the collection JSON inside
`pb_data` (gitignored — keep it out of repositories and shared backups), and a
Google account whose email is not in `users` yet still cannot self-register
through Google (the required Aerun profile fields are not derivable from the
provider; registration stays the explicit `POST /api/aerun/auth/register`
path).


---

### 2026-09-29 — Legacy avatars moved into PocketBase (Sprint 7 storage half)

**Stage:** the operator asked for the remaining Firebase avatar links to be
re-hosted. The legacy bucket is scheduled for deletion in Sprint 9, so every
`firebasestorage` hotlink was a 404 waiting for the teardown.

**Shape of the data, measured before writing anything:** `topics`, `posts`,
`characters` and the DM tables are still empty — the forum content has not been
imported — so the only live avatar references are the 11 `users.avatar_url`
values. Seven of them are legacy Firebase objects; three are DiceBear URLs
(generated from a seed, nothing to copy) and one is an Instagram CDN link on
somebody else's host. The bytes were already local: the Sprint 0 export holds
all eight `users/<uid>/avatar` objects, md5-verified in
`storage-manifest.json`. A spot check against the live bucket confirmed the
exported bytes still match what the URLs serve (114943 and 23046, byte for
byte), so the offline export is the source of truth and re-downloading would
only add a way to get a different answer.

**Decision — a native FileField, and a host-agnostic URL.** Migration
`1767000000` re-adds the `avatar` file field that `1766000000` had removed as a
scaffold leftover: at that point no file lived on the record, so a text URL was
the only option. `avatar_url` stays, because the denormalized copies
(`author_avatar`, `last_post_author_avatar`, the presence DTO) carry a plain
string and never hold a record — but it now stores
`/api/files/<collectionId>/<recordId>/<file>` instead of an absolute URL, so
the same rows survive a domain change. That is exactly the path
`pb.files.getURL` builds, which is why the frontend resolves it with one
helper (`src/api/avatars.js`) instead of guessing per render site.

**Deliberately not touched:** the DiceBear and Instagram avatars. Copying a
third party's hosted image is not a migration, and a seeded generator has
nothing to store; both are reported with a reason instead of being silently
skipped. The importer also refuses to fetch anything that is not on the legacy
storage host, so `-download` has no request-forgery surface — the same concern
PB itself guards in `record_auth_with_oauth2.go` when it downloads an OAuth2
avatar.

**Found and fixed on the way:** two bugs the tests caught, both of which would
have shipped silently. (1) The "already imported" check ran *after* the
legacy-host classification, so on a second pass every migrated row — whose URL
is now a local path — was reported as a third-party URL left alone
(`re-run: unchanged=0`, the import would have looked like it had reverted
everything). (2) `-dry-run` printed "planned" while still writing; the option
now genuinely skips the two `Save` calls, and a test asserts the row is
untouched.

**Verification:** `gofmt -l .` empty, `go vet ./...` 0, `go test ./... -count=1`
green, including the new `TestImportUserAvatars_*` cases (moves the bucket,
proves the bytes, skips everything else with a reason, idempotent re-run,
dry-run writes nothing, missing export file is a skip, host-spoofing URLs are
refused). Dry run first: `planned=7 unchanged=0 skipped=4 md5_verified=7
md5_mismatch=0`. Real run: the same seven imported, and a second run reported
`imported=0 unchanged=7 changed=false`. Every one of the seven then served
`200` over HTTP with the right magic bytes and a size identical to the manifest
(Akira 8410, Arin 114943, Kieran 10654, Nice 16506, Roui 13988, Shimadzu
23046, Siero 14714). `pb_data` was backed up before the first write.

**Scope note, not a fix:** `AvatarUploader` still turns an upload into an
inline data URL and hands it to `avatar_url` — a 512-character text column that
a resized image can never fit, and a write the deny-by-default `users`
`UpdateRule` would refuse anyway. Making avatar upload work is a server
command like the rest of the domain writes, not a migration; it is untouched
here on purpose.


---

### 2026-09-29 — Two frontend lessons from the avatar cutover (same class of bug, twice)

**Context:** the avatar import made `avatar_url` host-agnostic
(`/api/files/...`) instead of an absolute URL. Two frontend bugs followed, and
they are worth writing down because the second one is the *same* mistake as the
first, one layer up.

**Lesson 1 — a relative path needs a resolver, and every render site needs it.**
The navbar rendered the stored path verbatim, so the browser resolved it against
the frontend origin (`localhost:5173/api/files/...`) and 404'd; the members
table, the profile header and the admin list worked. Not a subtle degradation —
a broken image in the most visible element on the page.

The first pass patched the sites a truncated grep had surfaced, and stopped
there. A later sweep of every `src=` that carries an avatar value found **12
sites through the resolver, 0 unresolved** — the five that had been missed
(navbar, post-voters modal, the RichEditor mention list, three DirectMessages
spots whose avatar arrives as `targetProfile.avatar_url` / `participantAvatars`)
all had the same one-word gap. The lesson is the method, not the count: a
truncated search result is not an inventory, and a fix that touches "the places
grep found" is not the same as a fix that covers the feature. Worth noting that
every missed site was in a component the first pass never opened, so the gap was
invisible from inside the files that *had* been checked.

`resolveAvatarUrl` is idempotent by construction (absolute, data-URL and
DiceBear values pass through untouched), which is what makes it safe to apply
defensively at render time — including on values that were already resolved.

**Lesson 2 — do not verify a hand-written stand-in for real code.** The staff
branch of `subscribeToAllUsers` was broken for exactly the users who can reach
`/api/aerun/admin/users` (a five-field literal, no `created`), while the public
fallback worked — so the symptom was "dates render when logged out". The first
verification modelled that branch in Node *with* `created: u.created` inside, and
reported 11/11 parseable dates. It had verified a shape the code never
produces. The fix was to extract the real function from the module the dev
server actually serves, run it against the exact payload `admin_users.go`
builds, and assert the result — which failed immediately and honestly.

Two things fall out of that: a test double must be derived from the code rather
than from memory of it, and "it works in one branch" is not "it works" — the
branch difference was the entire bug. A logged-in staff session is the only
state in which it reproduces, which is exactly why the report was needed.

