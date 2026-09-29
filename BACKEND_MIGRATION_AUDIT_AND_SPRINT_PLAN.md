# Backend audit and Go/PocketBase migration plan

**Status:** approved planning baseline — cleaned 2026-09-29
**Scope:** current Firebase application, a local-first replacement backend, and later single-VPS deployment
**Primary audience:** implementation agents and maintainers
**Last reviewed:** 2026-09-29

> **Reading protocol for agents.** This file is the single source of truth for
> what is DONE, what is NEXT, and what the contracts are. The dated progress
> journal (2026-09-17 → 2026-09-29) lives in
> `markdowns/ARCHIVE_BACKEND_MIGRATION_PLAN_progress-log_2026-09-17__29.md` —
> read it only for background; do not append to it. New progress entries go to
> the task briefs in §5 (status line per task). When a contract here conflicts
> with anything else (`PROJECT_SPEC.md`, `PROJECT_CONTEXT.md`, older docs),
> **this file wins**; §5 resolves the known conflicts explicitly.

## 1. Executive decision and non-negotiable invariants

The migration does **not** reproduce the Firebase topology (Firestore as
source of truth, RTDB cache, trigger sync). Target: one custom Go app around
PocketBase, one authoritative SQLite + `pb_data` volume, one transactional Go
command layer.

```text
React SPA ── PocketBase SDK (safe reads, auth, SSE) + /api/aerun/* commands
             ▼
   Go command layer (short SQLite transactions, RBAC, validation, outbox)
             ▼
   SQLite + uploaded files (pb_data)
```

**Non-negotiable invariants**

1. A command either commits every domain change or commits none.
2. Only the server changes counters, roles, moderation state, reputation,
   unread state, and audit records.
3. Every externally observable side effect is idempotent.
4. Email, webhooks and realtime delivery happen after commit and can fail
   without losing a post, vote, message, or registration.
5. RTDB is not migrated as a live dependency; durable data comes from
   Firestore, cache nodes are recomputed or discarded.
6. Every browser mutation carries an `Idempotency-Key`; replaying a timeout
   returns the original result instead of applying the action twice.

**Documented, accepted deviations** (do not "fix" without a new decision):

- `PUT /api/aerun/me/avatar` (and the character-avatar command from §5.C) are
  NOT bound to `enforceIdempotency`: the middleware buffers bodies and caps
  them at 512 KB, which a multipart upload can never satisfy. The command is a
  replace, not an accumulate (PocketBase deletes the previous single-select
  file), so a retry converges. See `avatar_upload.go` header comment.
- Read endpoints never required idempotency keys; only mutations do.
- `POST /api/aerun/auth/register` is not idempotency-enveloped: it is a guest
  endpoint guarded by UNIQUE indexes; a duplicate submit answers `409`.

## 2. Where the project actually is (scoreboard, 2026-09-29)

| Sprint | Scope | Status |
|---|---|---|
| 0 — Firebase baseline | key rotation, rules deploy, profile-email strip, snapshots | **DONE** (verified 2026-09-21; RTDB excluded by decision 2026-09-18) |
| 1 — Go/PocketBase foundation | config guardrails, health, request IDs, CI | **DONE** (CI channel, §7) |
| 2 — Identity, RBAC, secure reads | register, settings, admin users, Google OAuth | **DONE** (OAuth closed 2026-09-28) |
| 3 — Forum transactional commands | topics/posts/move/lock/pin, cursors, 100-concurrency DoD | **DONE** |
| 4 — Reputation, subscriptions, audit | transactional votes/subscribe, append-only audit | **DONE** |
| 5 — DMs, notifications, outbox | conversations, unread, outbox rows + worker logic | **DONE** 2026-09-29 — worker is scheduled in the serve path (TASK-4) |
| 6 — Frontend adapter | `src/api/*` on `/api/aerun/*`, PB auth store, presence | **DONE** 2026-09-29 — categories + characters CRUD moved onto the command layer (TASK-2, TASK-3) |
| 7 — Migration tooling | exporter, staging, rehearsal, 4 domain writers | **~40% of writer half**: users/roles/avatars/characters done; categories/topics/posts/DMs/notifications/reputation/audit/settings + sequence reconstruction remain → TASK-6 |
| 8 — VPS production readiness | DNS/TLS/systemd/backups/restore drill | **NOT STARTED** |
| 9 — Cutover | final export, import delta, reconciliation, switch | **NOT STARTED** |

**Checkpoint 2026-09-29 — «runtime command layer closed».** TASK-1 … TASK-5 of §5
are landed and green: the P0 showstopper (category visibility), the dead admin
board (category + category-group commands), the characters domain API that
replaces the retracted `settings.characters` fold, the outbox worker that now
actually runs, and the role hardening. The next checkpoint is **TASK-6**, the
remaining import writers — the largest single block left before Sprint 8.

**Known gaps deliberately left for TASK-6** (recorded here so they are not
mistaken for oversights):

- `categories.topics_count` / `posts_count` are not in the target schema. The
  admin board and the main page read them with a `|| 0` fallback and therefore
  render `0` rather than crashing; the real numbers arrive with the post writer
  and `recompute-counters`.
- The category modal still shows separate EN/RU inputs. The command contract
  stores one string, and `pickTitle` submits the RU value (falling back to EN), so
  an EN-only label survives and a bilingual one is stored in Russian only. That is
  the contract the brief specifies, not an accident of the adapter.
- `src/constants/permissions.js` still exports `DEFAULT_ROLES` and
  `MAX_ROLE_PERMISSIONS`; the runtime authority is now the `roles` collection
  (§3.2), so those constants are a fallback for the role-construction UI only.

Live verification state: `go test ./...` all packages ok, `npm run build` ok,
`eslint` clean on the touched files (2026-09-29). The CI channel
(`origin/ci-report`, §7) is the authoritative external check.

### 2.1 Legacy facts that must survive the migration window

- Firebase Auth holds canonical emails (14 accounts); Firestore `users`
  docs are email-free (strip verified 2026-09-21). Password hashes cannot be
  migrated: import creates unusable passwords + forced reset; Google OAuth
  links by verified email.
- Legacy system-role documents in the snapshot are **not authoritative**;
  the compiled matrix in `internal/auth` is. The moderator/player/spectator
  drift is a recorded product-decision TODO before cutover, not tooling work.
- Importer drops 1 orphan user + 1 reputation row and 1 orphan auth record
  with findings; `readmap`, `guest_activity`, `forum_stats` are not imported
  (rebuilt or obsolete).
- Drafts import as `posts` rows with `is_draft=true` (doc id = topic id;
  `UNIQUE(author_id, topic_id) where is_draft` enforces one-per-topic).

## 3. Target architecture decisions (stable)

### 3.1 Auth and identity

One PocketBase auth collection `users`: email+password, OAuth2 (Google live;
add providers only with verified credentials), `role` (TextField, validated
against `roles.role_id` by the command layer), `status`
(`active/pending/banned` — the legacy pseudo-roles), `legacy_firebase_uid`
(partial UNIQUE index, the import upsert key), `nickname_normalized` UNIQUE,
`custom_role_id` (base system role of a custom role), profile columns
(1766900000), `avatar` FileField plus host-agnostic `avatar_url`
(`/api/files/<collectionId>/<recordId>/<file>`; resolved client-side by
`src/api/avatars.js#resolveAvatarUrl` — idempotent, apply it at every render
site that shows an avatar; a truncated grep is not an inventory).

### 3.2 Roles and permissions

- The **runtime authority** for a role's permission set is the `roles`
  collection row (`role_id` UNIQUE business key, `name`, `rank`, `color`,
  `is_system`, `base_role_id`, `max_characters_limit`, `permissions`).
- The **compiled matrix** (`internal/auth` roleSpecs) is: (a) the seed for
  system roles, (b) the deny-by-default fallback when a roles lookup fails,
  (c) the reconciliation reference for `import-roles`.
- The **permission vocabulary** (`auth.AllPermissionValues()`) is compiled —
  it is the wire/migration contract with `src/constants/permissions.js`.
  Role→permission *mappings* are data in the DB. Adding a permission key means
  code + a NEW migration extending the `roles.permissions` select values;
  never edit an applied migration.
- System roles (`is_system=true`) are reconciled against the compiled matrix
  by `import-roles` and are therefore **not editable through the API** (§5.E;
  this closes the update-vs-reconcile conflict found in the audit).
- Custom roles are first-class rows: imported verbatim (`role_id` = legacy doc
  id), referenced by `categories.allowed_roles` and `users.role`.

### 3.3 Email delivery

`outbox_events` rows are created in the same transaction as the forum action;
a worker marks `sent`, retries transient errors with backoff, then
`failed`+alert. The forum command returns success after commit regardless of
SMTP. Mail is hard-disabled today (`MailHardDisableGuard` + SMTP settings
reset on every bootstrap); a failed verification/reset delivery leaves the
account in its safe state and the UI must never claim an email was sent.
Worker wiring rules: §5.D.

### 3.4 Realtime and presence

PocketBase SSE for authorised record changes; the UI refetches the affected
cursor, it never receives an all-forum cache. Presence:
`POST /presence/heartbeat` every 30 s (members) / 60 s (guests);
`guest_presence` rows for anonymous visitors (server-only rules, 30 req/min
per-IP budget, `*/10` retention prune cron — copy that pattern for the outbox
cron). No `onDisconnect` clone; `sendBeacon` on `pagehide` is the leave signal.

**Two separate clocks, and both are required.** The legacy backend kept
`last_seen` (online now) and `last_activity` (last visit) apart on purpose, and
collapsing them is what broke the members table:

- **Online now** — an in-process map, `presenceTTL` 75 s, disposable by design
  (a restart legitimately forgets it; every open tab rebuilds it within one
  beat). `GET /api/aerun/status` and the heartbeat response publish it.
- **Last visit** — `users.last_seen`, migration 1767300000. Server-owned, written
  by the heartbeat with a 5-minute throttle and by account creation, backfilled
  from `created` and seeded from the legacy document by `import-users`
  (monotonically). Read through `GET /api/aerun/admin/users`, which substitutes
  `created` if the column is somehow empty, so the members table can never
  render a blank Last Seen.

The `presence_sessions(expires_at)` table sketched here earlier is **not**
implemented and is not required: the durable column answers the historical
question without a second store to prune. Do not add it without a decision —
a session table would have to be reconciled against `users.last_seen` on every
restart, and the two can disagree.

### 3.5 Data model essentials

| Collection | Key constraints |
|---|---|
| `users` (auth) | §3.1; `avatar` FileField ≤5 MB; `settings` JSON ≤256 KB, depth ≤8, wholesale replace via `PUT /me/settings`; `last_seen` date, server-owned, never empty (§3.4) |
| `roles` | §3.2; `role_id` UNIQUE business key |
| `category_groups`, `categories` | categories: `slug` UNIQUE, `group_id`, `sort_order`, `allowed_roles` JSON (contract §5.A); no browser writes |
| `topics` | `category_id`, `author_id`, state, `posts_count`, `next_post_sequence`, `last_post_*` — maintained transactionally |
| `posts` | `UNIQUE(topic_id, sequence)` where `sequence > 0`; `is_draft` + `UNIQUE(author_id, topic_id) where is_draft`; soft delete tombstones |
| `topic_subscriptions` | `UNIQUE(topic, user)` |
| `reputation_votes` | `UNIQUE(voter, post)` / `UNIQUE(voter, target_user)`; immutable value |
| `dm_conversations` / `dm_messages` | per-conversation sequence; per-member `last_read_sequence`, `cleared_at` |
| `notifications`, `audit_logs` (append-only), `idempotency_keys` (`(actor,key)` UNIQUE), `outbox_events` (dedupe key) | as implemented in sprints 4–5 |
| `characters` | `owner_id`, `name`, `status_line`, `signature`, `avatar` FileField (1767200000), historical dates; server-only rules; **the authoritative characters store**, never `users.settings` |
| `designs` | css/js/theme/welcome_message; one active design per user; server-only |
| `guest_presence` | `guest_id` UNIQUE, `first_seen`, `last_seen` indexed |

## 4. Decision register (audit 2026-09-29)

Every agent-visible decision that was ambiguous before this audit is recorded
here. `ADR-n` items are binding.

- **ADR-1 (category visibility semantics).** `categories.allowed_roles` is
  the ONLY visibility input. Empty/absent list = visible to **root only**.
  A public category carries an explicit list of ALL role ids (including
  `guest`). Bypass exists for `root` only; `admin` no longer bypasses
  (pre-audit code granted both). The legacy `categories.permissions` JSON
  field is deprecated and must be removed after backfill (§5.A).
- **ADR-2 (allowed_roles membership test).** Membership is checked against
  `users.role` only. `users.custom_role_id` is NOT consulted: a category
  granted to `player` is not automatically visible to users on a custom role
  derived from `player` — the admin lists the custom role explicitly (this is
  also how the legacy export behaves; "Скрытые игры" names a custom role id
  directly). Deny-by-default for anything else.
- **ADR-3 (system role immutability).** `PATCH /roles/{id}` on an
  `is_system=true` row → `403 forbidden`. Rationale: `import-roles`
  reconciles system roles against the compiled matrix and would silently
  revert an API edit on the next run. If product wants editable system roles,
  that requires removing the reconciliation step first — a separate decision.
- **ADR-4 (avatar endpoints stay split).** User avatar:
  `PUT /api/aerun/me/avatar` → `users.avatar` FileField + `users.avatar_url`
  rewrite. Character avatar: `PUT /api/aerun/characters/{id}/avatar` →
  `characters.avatar` FileField + `characters.avatar_url` rewrite (§5.C).
  They never write each other's fields; both share the byte-sniffing, size
  and multipart handling pattern of `avatar_upload.go`.
- **ADR-5 (characters are rows).** `characters` collection is authoritative.
  The pre-migration fold (characters inside `users.settings.characters`) is
  retracted; the frontend must stop reading/writing `settings.characters`
  (§5.C). `users.last_selected_character_id` keeps referencing the row.
- **ADR-6 (outbox dispatch while mail is disabled).** When
  `settings.SMTP.Enabled == false`, the worker must NOT mark events `failed`
  and must NOT attempt a send: it leaves them `pending` (untouched), logs a
  debug line, and returns. Enabling SMTP later drains the backlog (§5.D).
- **ADR-7 (category delete).** Deleting a category with topics is refused
  with `409 conflict` (§5.B). Moving topics first is the operator's job
  (`POST /topics/{id}/move` already exists).

## 5. Normative specifications and task briefs (agent-ready)

Each brief below is executable as-is: files, contracts, expected behaviour
and required tests are named. Work through them in order TASK-1 → TASK-6.
Follow the hand-off rules in §8.

### 5.A TASK-1 — Unify category visibility on `allowed_roles` (P0, showstopper prevention)

**Problem.** `canViewCategory` (`category_access.go`) still reads the legacy
`categories.permissions` JSON map (`{"view_forum":[roleId…]}`) and treats an
empty list as PUBLIC. Migration 1766500000 created `categories.allowed_roles`
with the OPPOSITE empty-list meaning, and the category importer (TASK-6) will
write `allowed_roles`. If the import landed today, every restricted category
would silently become public. ADR-1/ADR-2 define the target behaviour.

**Do exactly this:**

1. New migration `backend/internal/migrations/1767300000_category_allowed_roles_backfill.go`:
   - For every `categories` row: if `permissions` JSON parses to a non-empty
     `view_forum` array of strings AND `allowed_roles` is empty/absent → copy
     that array verbatim into `allowed_roles`.
   - Else (missing/empty map) → write the full public list: every `role_id`
     from the `roles` collection, **sorted ascending by role_id** and
     including `guest` (deterministic: the migration test asserts exact
     equality across two runs on a fresh DB).
   - Then remove the `permissions` JSON field from `categories` (down path
     re-adds it and clears `allowed_roles`). Field added by 1766300000, no
     writer exists — removal is safe.
2. Rewrite `canViewCategory(app, acc, categoryID)`:
   - `categoryID == ""` → false. `acc.Status == banned` → false.
   - `acc.Role == root` → true (the only bypass, ADR-1).
   - Parse `allowed_roles` (JSON array of strings; tolerate string-encoded
     JSON like the current code does). Empty/absent → false.
   - Return `slices.Contains(allowedRoles, string(acc.Role))`. Do NOT consult
     `acc.Permissions`, `custom_role_id`, or `permissions` (ADR-2).
3. `listCategoriesHandler` keeps using the helper (no other change).
4. Grep for any remaining `Get("permissions")` on categories — remove it.

**Tests (new `category_access_test.go` cases):** root sees an empty-list
category; `admin` NOT in the list is denied; `guest` denied on a restricted
category and allowed on a public one; a custom-role user is denied unless
their role_id is listed; banned root is denied (banned beats bypass);
backfill migration copies a legacy map, writes the full sorted list for an
empty map, and removes the field. Run `go test ./...` and `npm run build`.

**Status:** ☑ DONE 2026-09-29 (checkpoint «runtime command layer»).

**Delivered**

- `backend/internal/migrations/1767400000_category_allowed_roles_backfill.go`
  — copies a non-empty legacy `permissions.view_forum` verbatim, writes the full
  role list (ascending, guest included) otherwise, then drops
  `categories.permissions`. Down path restores the field and clears
  `allowed_roles`.
- `canViewCategory` rewritten on `allowed_roles` alone: empty/absent = root-only,
  `root` is the only bypass, banned is refused before the bypass,
  `custom_role_id` is not consulted.
- `listCategoriesHandler` now also serves `group_id` and `allowed_roles` — without
  them the admin board cannot re-submit a category without silently wiping its
  role list.
- Tests: `category_access_test.go` (visibility matrix + the HTTP read model) and
  `internal/migrations/category_allowed_roles_test.go` (both backfill branches,
  idempotency, field removal). `sprint4_test.go` was **inverted**: it asserted
  the legacy `permissions` field exists, which is exactly what ADR-1 retires.

**Deviation from the brief:** the brief named migration `1767300000_…`, but that
timestamp is taken by `1767300000_user_last_seen.go`; the new migration is
`1767400000_…`.

### 5.B TASK-2 — Category and category-group management commands (P0 — admin UI is dead today)

**Problem.** `src/api/categories.js` still calls
`pb.collection('categories').create/update/delete` and
`pb.collection('category_groups')...` — direct browser writes that the locked
rules refuse, so the admin Categories tab silently fails. The backend has
only `GET /categories` and `GET /category-groups`. Permission
`manage_categories` exists but no command implements it.

**Backend** (new file `category_commands.go` + routes in `registerRoutes`):

- `POST /api/aerun/category-groups` — body `{ title: string(1..128) }`.
  Existing `category_groups` fields per schema; sort_order auto = max+1 unless
  provided. Guard: `RequirePermission(auth.PermManageCategories)` +
  `enforceIdempotency`.
- `PATCH /api/aerun/category-groups/{id}` — partial: `title`, `sort_order`.
- `DELETE /api/aerun/category-groups/{id}` — `409 conflict` when categories
  reference it, else delete.
- `POST /api/aerun/categories` — body
  `{ name: string(1..128), description: string(0..1024), group_id: string,
  sort_order: int, allowed_roles: string[] }`. Server derives `slug`
  (lowercase `a-z0-9-`, from name, UNIQUE — reuse the existing index; `409` on
  collision), ignores any client slug. **`allowed_roles` validation:** every
  element must exist in `roles.role_id` (else `400 validation` listing the
  bad ids); duplicates removed; empty array allowed and means root-only
  (ADR-1) — the client builds a "public" list from `GET /api/aerun/roles`.
  The legacy `{ru,en}` maps are NOT part of this contract: the adapted UI and
  the importer collapse them to single strings (importer records the
  decision in its report).
- `PATCH /api/aerun/categories/{id}` — partial; same `allowed_roles`
  validation; `group_id` must exist; `slug` is immutable.
- `DELETE /api/aerun/categories/{id}` — `409 conflict` when topics reference
  it (ADR-7), else delete.
- Every mutation writes an audit row (`category_created`, `category_updated`,
  `category_deleted`, `category_group_*`) inside the same transaction via
  `recordAuditLog`, exactly like the roles commands.

**Frontend** — rewrite the CRUD half of `src/api/categories.js` onto
`sendApi` (reads already migrated); keep the localStorage group cache
invalidation. Delete `logAdminAction` calls from the write paths (server
audits now) — `logAdminAction` in `audit.js` is already a no-op stub.

**Tests:** permission matrix (player → 403, admin → allowed); duplicate slug
409; unknown role_id in `allowed_roles` → 400; delete with references → 409;
idempotent replay returns the same body; audit row exists; the adapted
`AdminPage.jsx` flows still compile (`npm run build`).

**Status:** ☑ DONE 2026-09-29 (checkpoint «runtime command layer»).

**Delivered**

- `backend/internal/migrations/1767500000_category_groups_and_group_id.go` —
  creates `category_groups` (title, sort_order, historical dates) and adds
  `categories.group_id`. Both were assumed to exist by the brief; neither did.
  `GET /category-groups` degraded honestly (`available: false`) instead of
  failing, which is why the gap stayed invisible.
- `backend/internal/platform/pocketbase/category_commands.go` — six commands with
  `RequirePermission(manage_categories)` + `enforceIdempotency`, every mutation
  writing its audit row inside the same transaction. Server-derived slug with
  Cyrillic transliteration and 409 on collision; `allowed_roles` validated
  against the roles registry (custom ids allowed, ADR-2); `group_id` validated,
  with the UI's `unassigned` sentinel mapped to "no group"; delete refusals for a
  non-empty group (409) and a category with live topics (409, ADR-7).
- Frontend `src/api/categories.js` rewritten onto `sendApi`; `logAdminAction`
  removed from the write paths (the server audits now). The read model is
  normalised in one place (`toCategory`), so the {en,ru} collapse to single
  strings and `sort_order` → `order` never reach a page component.
- Tests: `category_commands_test.go` — permission matrix, missing name, unknown
  role id naming the offender, custom role accepted, transliterated server slug,
  duplicate slug 409, byte-identical replay + single audit row, group lifecycle
  with the 409-while-referenced rule.

**Bug found while writing the tests:** the first implementation assigned record
ids with `security.RandomString(15)`, whose default alphabet is mixed-case.
`categories.id` is `^[a-z0-9]{15}$`, so every create answered **500
`id: Invalid value format`** — a server fault on the happy path. Fixed with an
explicit `recordIDAlphabet` constant.

### 5.C TASK-3 — Characters domain API (P0 — feature parity + import alignment)

**Problem.** `src/api/character.js` reads/writes `users.settings.characters`
(the retracted pre-migration fold) and `pb.collection('users').getOne`. The
`characters` collection (1766600000/1767200000) is what the importer fills
and what `posts.author_character_id` references, but it has NO runtime API.
After import, user-created characters would be invisible and imported ones
unedittable.

**Backend** (new file `characters.go` + routes):

- `GET /api/aerun/users/{id}/characters` — public read of an ACTIVE account's
  characters, ordered by `created`; payload: `id`, `name`, `status_line`,
  `signature`, `avatar_url`, `created`. Denied (`404`) for pending/banned
  owners (same visibility the profile ViewRule gives).
- `GET /api/aerun/characters/{id}` — same rules.
- `POST /api/aerun/me/characters` — body
  `{ name: string(1..64), status_line: string(0..256), signature: string(0..1024) }`.
  Owner-only; banned denied, pending allowed (legacy self-service). Enforce
  the per-user character cap inside the transaction: count rows in
  `characters` for the owner; limit = owner's `roles.max_characters_limit`
  where >0 (resolve via `users.role` → roles row), else the compiled default
  — **first verify the legacy default in `src/constants/permissions.js` /
  legacy character UI; if none is found, use 3 and record it here**.
- `PATCH /api/aerun/characters/{id}` — owner-only, partial name/status_line/
  signature.
- `DELETE /api/aerun/characters/{id}` — owner-only. Refuse with `409` when
  the character is referenced by `users.last_selected_character_id` of its
  owner or by any non-deleted `posts.author_character_id` — the legacy UI
  deletes only unused characters.
- `PUT /api/aerun/characters/{id}/avatar` — owner-only multipart, pattern-
  identical to `uploadMyAvatarHandler` (2 MB cap, byte sniffing, same
  deviation from idempotency — ADR-4). Writes `characters.avatar` +
  `characters.avatar_url = AvatarFilePath(...)`.
- All mutations: `enforceIdempotency` except the avatar upload; audit rows
  `character_created/updated/deleted/avatar_changed` with `owner_id`.

**Frontend** — rewrite `src/api/character.js` onto these endpoints (keep the
`subscribeTo*` signatures so page components don't change); profile character
editor switches to the new API; remove every `settings.characters` read/write
(`settings_update.go` stays permissive — do not add rejection).

**Post read models:** where post payloads already denormalise
`author_nickname`/`author_avatar`, add `author_character_id`,
`author_character_name`, `author_character_avatar` when
`author_character_id` is set (single JOIN/lookup per page, not per post).

**Tests:** cap enforcement (create up to limit, next → 409 with stable
message), owner-only 403 for other users, public read of active owner,
404 for pending owner, delete-with-reference 409, avatar upload round trip
(magic bytes + size), idempotent replay of create/update/delete.

**Status:** ☑ DONE 2026-09-29 (checkpoint «runtime command layer»).

**Delivered**

- `backend/internal/platform/pocketbase/characters.go` — six routes:
  `GET /users/{id}/characters`, `GET /characters/{id}`, `POST /me/characters`,
  `PATCH|DELETE /characters/{id}`, `PUT /characters/{id}/avatar`. Reads follow the
  users profile ViewRule (active = public; pending/banned = 404, and the owner
  still reads their own). Mutations are owner-only and idempotency-enveloped,
  except the avatar upload (ADR-4). Delete refuses with 409 while the character
  is the owner's `last_selected_character_id`, or referenced by a live post.
- Frontend `src/api/character.js` rewritten onto the new endpoints; the
  `subscribeTo*` signatures are unchanged so no page component moved. Every
  `settings.characters` read/write is gone (ADR-5) and `avatar_url` is never sent
  from the client.
- Tests: `characters_test.go` — visibility through the read model, the cap at the
  boundary (fill to the limit, then 409 with no row written), ownership refusals
  that leave the row untouched, the delete refusals being actionable, byte-identical
  replay, and a PATCH that must not blank omitted fields.

**Decisions recorded**

- **Character cap default = 3.** The brief required checking the legacy default
  first; there is none. `src/constants/permissions.js` has no character cap and
  the legacy profile UI only gated the "add" button on `create_self_mask`, while
  PROJECT_SPEC.md §278 defers the number entirely to `roles.max_characters_limit`.
  3 is therefore a documented placeholder, defined once as
  `defaultCharacterLimit` in characters.go. Change it there when product decides.
- **Post read models are deferred.** `postPayload` does not denormalise
  `author_nickname`/`author_avatar` at all, so there is nothing to extend yet;
  `author_character_id`, `author_character_name` and `author_character_avatar`
  arrive with the TASK-6 post writer that freezes display identity. The delete
  guard asks the schema (`postsHaveAuthorCharacter`) instead of assuming, so it
  does not 500 in the meantime.
- Character avatar uploads are audited best-effort rather than in a transaction:
  the body read would hold the SQLite write lock, and the file is already stored
  by the time the audit row is written, so failing the request would report a
  broken upload that succeeded.

### 5.D TASK-4 — Wire the outbox worker into the serve path (P1)

**Problem.** `OutboxWorker.ProcessBatch` (`outbox.go`) is implemented and
tested (retry/backoff, no-resend DoD) but nothing schedules it: `run.go`
registers only `registerGuestPresenceCron`. Today no DM/notification email
would ever leave the queue even after SMTP is configured on the VPS.

**Do exactly this:**

1. In the OnServe hook (same place `registerGuestPresenceCron` is called),
   add `registerOutboxWorkerCron(se.App)`: a PocketBase cron `* * * * *`
   (every minute; the presence prune is the pattern) calling
   `NewOutboxWorker().ProcessBatch(ctx, app, sender, 20)`.
2. `sender` = a `MailSender` implementation with the ADR-6 behaviour: when
   `app.Settings().SMTP.Enabled == false` → return `(0, nil)` immediately
   without touching rows (never mark `failed`, no attempt counters, debug
   log). When enabled → PocketBase's mailer, and `MailHardDisableGuard`
   stays as the second boundary until Sprint 8 deliberately removes it.
3. Guard against overlap: if a batch is still running (slow SMTP), skip the
   tick (atomic flag or capacity-1 channel); never run two batches
   concurrently against SQLite.
4. Keep `GET /admin/outbox-events` and the retry route as the operator view.

**Tests:** ADR-6 unit test (SMTP disabled → rows untouched, exit 0); overlap
skip test; reuse `TestSprint5OutboxWorkerRetryAndDoD` unchanged.

**Status:** ☑ DONE 2026-09-29 (checkpoint «runtime command layer»).

**Delivered**

- `backend/internal/platform/pocketbase/outbox_dispatch.go` —
  `registerOutboxWorkerCron(app)` schedules `* * * * *` next to
  `registerGuestPresenceCron` in the OnServe hook (same reason: PocketBase starts
  its scheduler at priority 999). `dispatchOutboxOnce` runs the batch through
  `app.NewMailClient()`, so `MailHardDisableGuard` remains the second boundary.
- ADR-6 is checked **before** the query and before the overlap flag: with SMTP
  disabled the worker logs at debug and returns 0, touching no row. The brief's
  wording ("leave them pending, untouched") only holds if nothing is attempted —
  a batch that tried and failed would burn every pending event's retry budget and
  end as `failed`, and enabling SMTP later would find an empty queue.
- Overlap: `outboxDispatchInFlight atomic.Bool`, compare-and-swap. A tick that
  finds a batch running skips rather than queues — the next tick is a minute away.
  The batch also carries a 30 s context timeout so a hung relay cannot hold the
  flag forever and silently stop the queue.
- Tests: `outbox_dispatch_test.go` — ADR-6 (status/attempts/last_error all
  unchanged), the skipped overlapping tick, idempotent cron registration, and a
  blank recipient being an error rather than a silent "sent".
  `TestSprint5OutboxWorkerRetryAndDoD` is reused unchanged.

### 5.E TASK-5 — Role command hardening (P1)

**Problem.** `updateRoleHandler` allows editing `is_system` roles (name,
rank, permissions), which `import-roles` would silently revert on the next
run; `deleteRoleHandler` checks only `is_system`, so deleting a custom role
that users or categories reference would dangle `users.role` /
`allowed_roles` values.

**Changes in `catalog_roles.go`:**

1. `updateRoleHandler`: if `rec.GetBool("is_system")` → `403 forbidden`,
   message `"system roles are reconciled from the compiled matrix and are
   not editable"` (ADR-3). Applies to every field, including `color`.
2. `deleteRoleHandler`: after the `is_system` check, inside the transaction —
   if any `users` row has `role = role_id` → `409 conflict` naming the count;
   if any `categories` row's `allowed_roles` contains `role_id` → `409
   conflict` naming the category ids (the collection is small: scan and parse
   the JSON; do not attempt SQL LIKE on JSON).
3. `createRoleHandler`: after `sanitizeRoleID`, reject ids matching a system
   role id (`root`, `admin`, `moderator`, `player`, `spectator`, `guest`) —
   the UNIQUE check only covers existing rows, not reserved vocabulary.
4. `rank` validation: reject `rank < 0` and `rank > 10000` in create/update
   (rank orders authority; keep the compiled bands 200/300/400/600/800/1000
   documented in a comment).

**Tests:** system PATCH → 403; delete-in-use by user → 409; delete-in-use by
category → 409; delete unused custom role → 200 + audit row; reserved role_id
→ 400; rank bounds.

**Status:** ☑ DONE 2026-09-29 (checkpoint «runtime command layer»).

**Delivered** in `catalog_roles.go`:

- `updateRoleHandler` refuses any PATCH on `is_system=true` with 403 and the ADR-3
  message, before touching a field. Every field is covered, `color` included.
- `deleteRoleHandler` refuses (409) while any `users` row carries the role,
  naming the count, and while any category's `allowed_roles` contains it, naming
  the category slugs. The category scan parses each row's JSON instead of using a
  SQL LIKE: a LIKE for `player` also matches `player_two`, which is precisely the
  "unreferenced" answer that is wrong.
- `createRoleHandler` rejects the six compiled ids. The UNIQUE index only covers
  rows that exist, so a reserved id that was never seeded would pass it and then
  shadow the matrix for every account holding that role.
- `rank` is bounded to 0..10000 on create and update.
- Tests: `role_commands_test.go` — four refused PATCH variants leaving the row
  unchanged, all six reserved ids, rank bounds at both edges, and the delete
  matrix (unused → 200 + audit row, held by an account → 409, granted to a
  category → 409 naming the slug, system → 403).

### 5.F TASK-6 — Finish the domain import writers (Sprint 7 completion, P1)

**Already done:** roles (L0), users (L1), user avatars, characters + character
avatars (L4). Deterministic derived ids (`importer/map.go`),
`legacy_firebase_uid` upsert key, byte-identical rehearsals, FK validation.

**Remaining writers, in the order of §5 of
`POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md`:**

1. **category_groups (L2) + categories (L3).** Category rows write
   `allowed_roles` per the ADR-1 translation: legacy `permissions.view_forum`
   non-empty → verbatim role-id list; empty/absent → the FULL public list
   (all `role_id` values from L0, sorted ascending — identical rule and sort
   as the 1767300000 backfill so both paths agree). Legacy `{ru,en}` maps
   collapse to the `ru` string; record `category_i18n_collapsed` findings
   with counts. Report the final list per category.
2. **topics (L5) + posts (L6) + drafts.** Sequence reconstruction: order a
   topic's non-draft posts by legacy `created` ascending (Firestore
   timestamps, nanosecond precision), assign `sequence = 1..n` contiguously,
   set `topics.next_post_sequence = n+1`, `posts_count = n`, and rebuild
   `last_post_*` projections from the real newest post — never from cached
   legacy projection fields (they are stale; the rehearsal already proves the
   mismatch class). Drafts: `is_draft=true`, no sequence, `topic_id` from the
   doc id. Deleted posts keep their tombstone (`deleted=true`) and STILL
   occupy their sequence (the legacy soft-delete model).
3. **L7–L9:** `reputation_logs` (recompute user reputation + post scores
   afterwards), `topic_subscriptions` (unique pair), `notifications`,
   `dm_conversations` + `dm_members` + `dm_messages` (per-conversation
   sequence from legacy message order), `audit_logs` last, `settings` (one
   row, constant id).
4. **Post-import pass:** counters for users/categories/topics, `forum_stats`
   recompute, file-reference validation (every `avatar_url` / character
   legacy reference must resolve to a local file or a recorded skip reason).
5. **Dress rehearsal on a real DB:** run the full chain twice into two fresh
   `pb_data` dirs from the same snapshot; the databases must be
   record-equivalent (per-table id/content dump-compare; PocketBase-managed
   autodate columns excluded) — that is the writer-half Sprint 7 DoD.

**Constraints (unchanged):** writers live in
`internal/platform/pocketbase/*_import.go`; planning stays in
`tools/migration/importer`; every batch is validated before its transaction
opens; a re-run over its own output is a no-op (`changed=false`); rows in the
target but absent from the batch are reported, never deleted; exit non-zero
only on input errors or dangling FKs.

**Status:** ☐ open (sub-items 1–5 tick separately).

## 6. Cutover exporter requirements (Sprint 9 gate)

The rehearsal exporter is explicitly NOT the cutover exporter
(`tools/migration/README.md` §Limits). Before Sprint 9:

- Fresh exports after the write freeze: prefer the GCS-managed Firestore
  export (`gcloud firestore export`) or a paged exported-documents reader
  with per-page continuation tokens; the current in-memory tool is
  acceptable only if the collection count stays this small and a checksum
  comparison against a second read confirms completeness.
- Auth export via `firebase auth:export`; Storage manifest with MD5s
  (already proven); no RTDB.
- Deletion reconciliation: the staging diff (`cli.mjs diff`) must report
  records present in the previous export but absent in the final one, and
  the importer's "report, never delete" rule must list each of them for
  human approval.
- Documented elapsed time for the full chain (rehearse timing exists;
  measure the writer chain once TASK-6 lands).

## 7. Mandatory tests for every backend change

- Unit tests for authorisation and the role/category matrix (raw HTTP client,
  not only UI-level).
- Transaction tests with concurrent requests; idempotency replay tests.
- Migration reconciliation tests and file checksum sampling.
- SMTP-unavailable / timeout / retry tests; SSE resubscription tests.
- Backup restore test before each major release.

## 8. CI verification channel

Every push touching `backend/**` runs `.github/workflows/backend.yml`
(gofmt, `go build`, `go vet`, `go test -count=1` on clean Linux) and
publishes `report.json` (schema `aerun-ci-report/1`) to the `ci-report`
branch — force-pushed, latest run only:

```
git fetch origin ci-report
git show origin/ci-report:report.json
```

`checks` contains a key with `ok` only when that step ran and passed; a
missing key means failed or skipped. A green report is the authoritative
external check — local success is not enough. Remember the CRLF lesson:
new Go files must be LF in the worktree or gofmt fails CI.

## 9. Sprint 8 and Sprint 9 checklists (unchanged scope, not started)

**Sprint 8 — VPS production readiness:** domain + DNS + TLS reverse proxy;
SPF/DKIM/DMARC and SMTP relay credentials; PocketBase as non-root systemd
service behind Caddy/Nginx (only 80/443 + SSH keys); `pb_data` on local
encrypted SSD, one active process; encrypted offsite backups, retention,
disk/RAM/error monitoring, outbox-failure alert; restore drill into an
isolated environment within the agreed RTO/RPO; dedicated read-only service
account for any remaining export access; delete the short-lived strip
service-account key if still present.

**Sprint 9 — Cutover:** announce maintenance; freeze Firebase writes;
final exports (§6); import the delta into the rehearsed target; automated
reconciliation + privileged/guest smoke tests; switch frontend config/DNS;
monitor errors, disk, auth, outbox, realtime; keep Firebase read-only for
the rollback window, then revoke credentials and archive exports.

## 10. Explicitly deferred items

- Scaling beyond one SQLite writer / one VPS (reassess with measured metrics).
- OAuth providers beyond Google.
- Self-hosted mail transfer agent (use a relay).
- Feature additions during the data-migration window.
- Product decision TODO: system-role permission drift (moderator /
  spectator / player) — must be resolved before cutover; until then the
  compiled matrix wins.

## 11. Agent hand-off rules

1. Read this file and the latest migrations before changing backend code.
   This file outranks other docs on conflicts (§ reading protocol).
2. One task must name its collection(s), command(s), rules, migration and
   test updates explicitly — the briefs in §5 are the template.
3. Never add client writes to a counter/cache/security field as a shortcut;
   never send email inside a database transaction.
4. Update this plan (task status lines, decision register) and
   `POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md` whenever a target contract
   changes. Do NOT resurrect the progress journal — it is archived.
5. After pushing backend changes, read the CI report (§8) instead of assuming
   success; fix red checks before new work.
6. Never edit an applied migration; add a new timestamped one.
7. Frontend rule of thumb from the 2026-09-29 lessons: `npm run build` is the
   only import-resolution gate; verify against the real served code, not a
   hand-written double; an avatar render site without `resolveAvatarUrl` is
   a bug.

## 12. Archive

- Full 2026-09-17 → 2026-09-29 progress journal (Sprint 0–7 entries, security
  pass evidence, rehearsal numbers, lessons):
  `markdowns/ARCHIVE_BACKEND_MIGRATION_PLAN_progress-log_2026-09-17__29.md`.
- Schema/import contract: `POCKETBASE_SCHEMA_AND_MIGRATION_MAP.md`.
- Migration tooling usage: `backend/tools/migration/README.md`; ops tooling:
  `backend/tools/ops/README.md`; backend runbook: `backend/README.md`.
