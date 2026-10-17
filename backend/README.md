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
file), and a real environment variable always wins. The ownership rule on
every startup `configureOAuth2`:

- with the pair present in the environment, the `google` provider is FORCED on
  with those credentials (endpoints, PKCE and scopes come from PocketBase's
  Google defaults; only the client id/secret are stored);
- with no (or an incomplete) pair, the reconcile touches nothing — the
  PocketBase admin UI (users collection → OAuth2) is the owner, so the
  operator enables Google there and no restart undoes it. This is the
  default-install path: no code, no env edits.

Password login is unaffected either way; `GET /api/collections/users/auth-methods`
reports the result.

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
  64 KiB get `413`. The handler also triggers the PocketBase verification mail
  (best-effort, Aerun-branded template + global wrapper) and reports the
  verdict as `mail_sent` / `mail_error` — `false` with the disabled reason when
  SMTP is off, so the UI never claims "a link was sent" for a letter that
  never left.
- `POST /api/aerun/auth/resend-verification` — honest resend for the caller
  (idempotency-enveloped). Unlike PocketBase's native `request-verification`
  (always `204`, even when the mail guard swallowed the send), this command
  answers `mail_sent=true` only after a real send, `503` + `mail_sent=false`
  when mail is disabled, and `{verified:true}` when there is nothing left to
  send.
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
- `GET /api/aerun/topics/:id` — get topic details. A topic in a category the caller may not see answers `404`, byte-identical to a missing topic.
- `GET /api/aerun/topics/:id/stats` — the topic page's metadata and freshness read: `topic_id`, `title`, `category_id`, `author_id`, `author_name`, `pinned`, `first_post_pinned`, `created`, `posts_count`, `last_post_id`, `last_post_at`, `locked`, `request_id` (plus `author_character_id` and `is_character` if masked). Sheds the heavy ~1.2 KB author and last-post list decoration of `GET /topics/:id`. Same category-visibility rule as the full read (hidden thread reads as missing); guest-safe. TopicPage loads this on open and polls it every 15s (with realtime nudge fallback), replacing the full topic read on open.
- `PATCH /api/aerun/topics/:id` — update topic title, lock, or pin state.
- `POST /api/aerun/topics/:id/move` — move topic to a different category (`move_topics` permission).
- `DELETE /api/aerun/topics/:id` — soft delete a topic (`moderate_content` or author).
- `POST /api/aerun/topics/:id/posts` — create a reply. Monotonically assigns sequence inside the topic transaction, verifies max post limit and locked state, and advances topic metadata atomically (`post_reply` permission).
- `GET /api/aerun/topics/:id/posts` — list posts ordered by `created ASC, id ASC` (page pagination: `page`, `limit`). `page=last|latest|unread` resolves the page holding the first unread post: for an authenticated caller the read cutoff comes from their server-side `topic_read_states` cursor (`last_read_created`/`last_read_post_id`, falling back to `last_read_at` for legacy rows; the `last_visit` query param is only a fallback), otherwise the last page is served. The response echoes the cutoff used as `read_cutoff` — this is what `?goLast=1` topic links rely on.
- `GET /api/aerun/topics/:id/posts/by-sequence/:sequence` — deep-link lookup by topic sequence number.
- `PATCH /api/aerun/posts/:id` — edit post content (`moderate_content` or author).
- `DELETE /api/aerun/posts/:id` — soft delete post, updates visible post count and topic `last_post_*` fallback.
- `POST /api/aerun/topics/:id/posts/move` — move posts between topics, resequencing in target topic and updating projections for both topics in one transaction.
 
### Board Structure (read model)

These are separated by what the CALLER may know, not by what the screen
renders. The public list deliberately omits `allowed_roles`: it answered "what
may this caller see", and shipping the access rule of every category on it told
every member (including a signed-out guest) the whole permission model of the
board — which roles exist, which are admitted, and by omission which are
restricted or root-only.

- `GET /api/aerun/forum-index` — the forum index in ONE response: `items` (the
  categories this caller may see, with counters and last-post projection) plus
  `groups` (the folder headings) and `available`. The index cannot paint from half
  of that pair, so it must not fetch half of it either — a category whose
  `group_id` named a group the other call had not returned yet rendered in the
  wrong section. `available` is `false` on a database older than migration
  1767500000, which is what renders the board ungrouped.
- `GET /api/aerun/categories` — the same category rows on their own, for callers
  that need categories without the grouping (moderation pickers). No
  `allowed_roles`.
- `GET /api/aerun/admin/categories` — the editor's view: every row, including
  ones the editor cannot preview (hiding a category from its own editor makes it
  unfixable), and the ONLY response carrying `allowed_roles`. Requires
  `manage_categories`.
- `GET /api/aerun/category-groups` — group headings alone. Kept for the admin
  board's group CRUD, which edits groups independently of categories.

#### Roles: the same split, for the same reason

`GET /api/aerun/roles` is ungated on purpose — `account_isolation_test.go` pins
that a signed-OUT visitor must still render role badges, and the theme must load
before a session exists — so the fields were gated instead of the route. It used to
serve `permissions`, `is_system`, `base_role_id` and `max_characters_limit` for
every role, which made the route a complete map of the board's security model
readable by anyone: which roles exist, exactly what each may do, and which are
privileged.

- `GET /api/aerun/roles` — `role_id`, `name`, `rank`, `color`. What a badge paints,
  and all four already public through role badges on posts.
- `GET /api/aerun/admin/roles` — the same rows plus `permissions`, `is_system`,
  `base_role_id`, `max_characters_limit` and the record `id` the editor form
  submits back. Requires `manage_roles`, and returns EVERY row: hiding a role from
  the editor that manages roles would make it unfixable.

What made this safe to do is that the client no longer needs the matrix to decide
anything. `hasPermission` reads the caller's effective permission set from
`GET /api/aerun/me` (`profilePayload`, narrowed by role AND by account status),
which the guest branch answers too — so a signed-out visitor is not left reaching
into the registry for an answer it is no longer given.

The permission NAMES remain public in `src/constants/permissions.js`, compiled into
the bundle. That is a vocabulary, not an assignment; what the split protects is
which account may do what, and it removes the second authority that could disagree
with the server.

#### Realtime: signals transport (DONE)

Realtime is implemented as a hybrid transport: it is primary, polling is the
permanent fallback. The design and its history are in
`markdowns/DONE_REALTIME_TRANSPORT_DESIGN.md` (the corrected replacement) and
`markdowns/DONE_REALTIME_HYBRID_PLAN.md` (the original plan, kept for its
reasoning).

How it works: PocketBase authorizes realtime through the same ListRule/ViewRule
as REST, so enabling realtime on forum content would re-open REST reads on it.
Instead the browser subscribes to `realtime_signals` (migration
`1768400000`) — a table holding only `{topic, entity_id, audience_id, at}`, no
forum content — and re-reads through `/api/aerun`, where authorization lives.
`src/api/shared-poll.js` implements the hybrid contract: connected ⇒ no
interval; not connected within the 10 s grace window ⇒ polling starts; dropped
after being healthy ⇒ polling resumes. `RealtimeStatusBanner` surfaces the
degraded transport per resource. Publishing is `publishSignal` /
`publishTopicSignal` (post create, DM send, notification create); write
failures are logged and swallowed, so a missed nudge degrades to one poll
interval.

`lockBrowserRules` stays intact for REST — the signal collection's wide
audience rule is safe only because its rows carry no content.

Note for tests: assert on DELIVERY, not on connection — a connection-only test
passes against a stream that is open and permanently silent.

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
- `GET /api/aerun/me/subscriptions` — list topics the caller is subscribed to with keyset pagination. Each item embeds the subscribed `topic` payload, so the browser renders the page from ONE request instead of one `GET /topics/:id` per subscription. The `topic` key is OMITTED when the topic is deleted or its category is no longer readable by the caller — the subscription row is still the caller's, but there is nothing there to read.
- `GET /api/aerun/topics/:id/stats` — lightweight freshness read for the topic page's 15 s loop.
  Returns only `{ topic_id, posts_count, last_post_id, last_post_at, locked, request_id }`.
  Same `canViewTopic` guard as the full topic read; guest-safe. A member pays ~80 bytes per
  tick instead of ~1.2 KB — the full topic payload is polled once on open, not on every tick.
- `GET /api/aerun/topics/:id/context` — ONE caller-scoped read that replaces three separate
  mount requests (`GET /topics/:id/draft`, `GET /topics/:id/subscription`,
  `GET /me/votes?topic_id=`). All three are caller-scoped, read once on mount, and keyed by
  (caller, topic) — the same shape as `/me/unread-counts` which §README justifies as *"one
  question — all four belong on one endpoint"*. Guest contract: `200` with
  `{ draft: null, subscribed: false, votes: [] }` — a `403` from a collapsed endpoint would
  break the entire topic page. Banned caller: `403` before the visibility check.
- `GET /api/aerun/admin/audit-logs` — keyset-paginated audit trail for administrative actions (`view_audit_log` permission: root/admin). Supports filtering by `action_type` and `performer_id`.

### Direct Messages, Notifications and Outbox (Sprint 5)

- `POST /api/aerun/dms` — create a new DM conversation with recipient(s) and opening message in one transaction. Requires `use_direct_messages` permission. Creates in-app notifications and queues deduplicated outbox email (`dm:first-unread:{conv}:{recipient}`).
- `GET /api/aerun/dms` — list conversations for caller with keyset pagination, unread counters, and last message metadata. Cleared conversations without new messages are excluded.
- `POST /api/aerun/dms/:id/messages` — send a reply message. Sequenced monotonically within the conversation transaction. Updates conversation unread state, notifies other members, and queues deduplicated outbox event.
- `GET /api/aerun/dms/:id/messages` — list ordered messages in conversation. Filters out messages prior to member's `cleared_at`.
- `POST /api/aerun/dms/:id/read` — mark conversation as read, advancing member's read sequence to latest message and clearing unread state.
- `POST /api/aerun/dms/:id/clear` — clear conversation history for caller (`cleared_at`).
- `GET /api/aerun/me/notifications` — list in-app notifications with keyset pagination and `unread` filter.
  Optional `type=quote` matches the whole quote/mention family (`post_quoted`, `post_mentioned`,
  `POST_MENTIONED`, and future `@All` rows). Optional `topic_id=` filters on `payload.topic_id`.
  The topic page subscribes to a SEPARATE named resource
  (`notifications:${uid}:topic:${topicId}`) with `?unread=true&type=quote&topic_id=X` so it
  never contaminates the NotificationsPage's unfiltered `notifications:${uid}` loop.
- `PATCH /api/aerun/me/notifications/:id/read` — mark single notification as read.
- `POST /api/aerun/me/notifications/read-all` — mark all caller's notifications as read.
- `PATCH /api/aerun/me/notifications/:id/archive` — archive notification.
- `GET /api/aerun/me/unread-counts` — aggregated unread counters (`unread_notifications`,
  `unread_conversations`, `total_unread_messages`, `unread_topics`), replacing the
  RTDB unread badges. All four belong on one endpoint because they are one
  question — "what does this member not know about yet" — and the client already
  polls it on a single shared loop, so the topic count costs no request it was not
  already making.
- `unread_topics` is the one number that cannot be derived on the client. It was
  previously computed in the browser from a `topics?limit=50` list, which made it
  capped (a member with 60 unread was told 50) and per-device (the read map lived
  in localStorage, so the desktop and the phone disagreed about the same account).
  The predicate compares the topic's last post against the reader's cursor
  (`last_read_created`/`last_read_post_id`, falling back to `last_read_at` and
  then `users.created`), filtered
  by `canViewCategory` so the count never exceeds the list it summarises, and
  excluding topics whose last post is the caller's own.
- `POST /api/aerun/topics/:id/read` — move the caller's read position for one
  topic. The body carries `{ "last_visible_post_id": "<post id>" }`; the server
  validates the post belongs to the topic and pins the cursor to that post's
  `(created, id)`, so a reply that landed after the page load stays unread. A
  legacy body (no post id) falls back to an "now" timestamp bound. Upsert, so
  revisiting advances the position. A GET is deliberately not a
  read: the topic is fetched constantly, and marking on every fetch would clear the
  badge as soon as the member looked at their own inbox.
- `POST /api/aerun/me/topics/read-all` — the same for a list of ids, behind the
  "mark all read" button. An id in a category the caller may not read is REFUSED
  (403) rather than skipped: skipping would return 200 while leaving that
  category's read state alone, and the button would claim to have read everything
  having not looked at all. Neither read route takes an idempotency key — they
  write exactly one row keyed (user, topic) and repeat to the same value, so a key
  would only add a way for "I opened a topic" to fail.
- `GET /api/aerun/admin/outbox-events` — keyset-paginated outbox events for staff visibility (`view_audit_log` permission: root/admin).
- `POST /api/aerun/admin/outbox-events/:id/retry` — reset failed outbox event to pending (`view_audit_log` permission).

`AERUN_MAIL_MODE`: `disabled` (default; local development and tests) queues
mail without sending it, and `smtp` enables real delivery. In `smtp` mode a
complete relay is **mandatory** — the process refuses to start on a missing
host/port/sender, because a mode that claims email is configured while every
send fails would surface only as a permanently bounced verification link:

| Variable | Required in `smtp` | Notes |
|---|---|---|
| `AERUN_SMTP_HOST` | yes | Relay hostname. |
| `AERUN_SMTP_PORT` | yes | 1–65535; must parse as a number. |
| `AERUN_SMTP_USERNAME` / `AERUN_SMTP_PASSWORD` | together | Both or neither — a half pair is a truncated secret, not a no-auth relay. |
| `AERUN_SMTP_AUTH_METHOD` | no | `PLAIN` (default) or `LOGIN`; Gmail's relay requires `LOGIN`. |
| `AERUN_SMTP_TLS` | no | `true` enables TLS. |
| `AERUN_MAIL_SENDER_ADDRESS` | yes | The From address. Must be one the relay may send from or SPF/DKIM alignment fails. |
| `AERUN_MAIL_SENDER_NAME` | no | Defaults to `Aerun`. |

All the relay variables above are **first-boot seeds only**. Once the matching
fields in PocketBase's Mail settings are filled (the dashboard's own placeholder
defaults count as unfilled), the environment stops being consulted for them, so
credential rotation happens in the dashboard and survives every restart — see
the paragraph below.

The relay, its credentials and the From identity are seeded into PocketBase's
settings from the environment **only while the corresponding settings fields
hold nothing usable** — a first boot, PocketBase's own placeholder defaults, or
the wipe a "disabled" stretch performed (`configureSMTP` in
`internal/platform/pocketbase/smtp.go`). After that **the PocketBase settings
row (admin dashboard) is the source of truth**: credentials are rotated in the
relay provider's dashboard plus PocketBase's Mail settings form, and every
restart keeps them. Stale values in the environment are harmless — they are
never re-applied over dashboard-configured fields. The mode itself
(`AERUN_MAIL_MODE`) remains environmental on purpose: "disabled" is a hard
switch that always wipes the stored relay on boot, and "smtp" always enables
sending. In
`disabled` mode the same reconcile clears the stored host, username and password,
so rolling a deployment back does not leave a live relay secret in `pb_data`
(and the next "smtp" boot re-seeds the relay from the environment, because the
wipe leaves the fields empty again).

This one switch covers every outgoing path, because all of them go through
PocketBase's own mailer: verification and password-reset mails
(`/api/collections/users/request-verification`, `.../request-password-reset`),
the auth alerts, and the outbox worker that drains notification, DM and topic
subscription mail once a minute with exponential backoff, never re-dispatching an
already successful event.

### Email templates

The three auth mails PocketBase owns — **email verification**, **password
reset** and **email-change confirmation** — are Aerun-branded, not PocketBase's
English defaults. They are installed on the users collection by
`configureAuthTemplates` (`internal/platform/pocketbase/mail_templates.go`) on
every startup, alongside the SMTP reconcile and for the same reason: content is
deployment state, not schema, so a wording fix must not require a migration and
a moved domain is recovered by changing `AERUN_PUBLIC_URL` alone.

The design is the one already shipped in `functions/email.js` (the Firebase
era): the same slate palette, the same `.btn` and `.highlight-box` classes, so
the mail a member receives does not change design when the backend moves. The
bodies are HTML fragments rather than whole documents, because PocketBase wraps
them in its own layout and sends `multipart/alternative` — a full
`<html>` document here would nest inside that layout.

The links point at PocketBase's own confirm routes (`{APP_URL}/_/#/auth/
confirm-verification/{TOKEN}` and friends), built from the validated
`AERUN_PUBLIC_URL` with any trailing slash stripped.

Disabling SMTP permits all forum and DM actions without interruption: the outbox
worker returns before it even looks at the queue, so events stay `pending` and
untouched rather than being marked `failed`.


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
| `settings` | — | deployment config → env, reported by `import-rehearse` |
| `designs` | — | skipped by design (theme, not forum data) |

### `settings`: global vs per-user

Two different things share the word, and they land in two different places.

- **Per-user settings** (UI preferences, notification toggles, the selected
  character) are stored in the `users.settings` JSON column and **are imported** —
  the user writer copies the legacy object verbatim.
- **Global forum settings** (25 keys in the 2026-09 export: branding, page size,
  upload limit, feature toggles) are **deployment configuration**. They are not
  written to any collection and no `settings` collection is created, because
  config that changes only at deploy time does not belong in a backup someone
  restores.

`import-rehearse` prints the handover list — every key, its value, and the
`PB_SETTINGS_*` name it belongs in. Four keys are marked `enforced_in_code` and
explain where the behaviour really lives: `whitelistMode`, `requireApproval`,
`registrationEnabled` and `enableReputation` are decided by the compiled role
matrix and `users.status`, not by a flag. A manifest that lists
`PB_SETTINGS_whitelist_Mode=false` is documenting the old value, **not** making
registration configurable.

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

### Identity placeholder upload

`forum_settings.deleted_avatar` / `guest_avatar` are `FileField`s on the settings
singleton (migration `1769400000`), each paired with a `*_avatar_url` reference
holding the host-agnostic `/api/files/...` path — the same two-column shape the
user avatar uses. They are the images shown for identities with no account of
their own: a removed member (`deleted`) and an anonymous visitor (`guest`).
`src/utils/identity.js` (`identityAvatar`) resolves them the same way it resolves
any avatar, so posts, last-post thumbnails and the DM inbox/chat draw one
consistent placeholder; an empty reference falls back to the neutral gray "U".

`PUT /api/aerun/admin/settings/placeholder/{kind}` (`kind` = `deleted` | `guest`)
writes both: multipart `file` part, ≤2 MB (the shared `readAvatarUpload` cap),
PNG/JPEG/WebP/GIF, admin-only. An unknown kind is refused (`400`) rather than
silently defaulted. The format is sniffed from the bytes, never the client.

Like the user-avatar route it is **not** bound to `enforceIdempotency` (a
multipart body cannot satisfy the 512 KB envelope), and is safe without it
because the write is a replace on a single-select `FileField`. The reference can
also be set or cleared through the ordinary `PATCH /api/aerun/admin/settings`
(the `deletedAvatar` / `guestAvatar` keys, empty string = reset to default),
exactly like `logoUrl`. Files are stored with the default `Protected=false`, so a
guest can load the placeholder the same way they load the logo.

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

- Outgoing email is off by default (`AERUN_MAIL_MODE=disabled`) and enabled by
  configuring a relay; see the `AERUN_MAIL_MODE` section above. One caveat before
  turning it on: the relay password is stored inside the settings JSON in
  `pb_data`, so keep `pb_data` out of repositories and shared backups (same
  caveat as the Google client secret). The auth templates are Aerun-branded, but
  the **outbox** mails (DM, topic replies) are still the plain-text bodies the Go
  command layer builds — porting the `functions/email.js` HTML wrappers to them
  is separate work.
- Command-line flags (`--http`, `--origins`, `--dir`) are intentionally
  rejected; all configuration comes from environment variables. The listener,
  migrations and CORS are wired programmatically through `apis.Serve` (verified
  against v0.40.4 source and live probes; `RunAllMigrations()` runs inside
  `apis.Serve` itself). Consequence: the built-in `superuser upsert`
  subcommand is unreachable — create the first superuser via the installer URL
  printed on first run with a fresh `pb_data/`.
- Production mode requires `AERUN_ENCRYPTION_KEY`, absolute `AERUN_DATA_DIR`
  and explicit `AERUN_ALLOWED_ORIGINS`; missing values abort startup.
