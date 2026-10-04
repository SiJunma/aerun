# Endpoint payload audit

Written 2026-10-03, after the `allowed_roles` cut on the category list prompted
the question "what else is being sent that nobody asked for?".

**Scope.** Every `/api/aerun` endpoint that answers a RENDER, checked against what
the consuming component actually reads. The test applied throughout is not "is this
field sensitive" but "does a consumer read it, and would the screen be wrong
without it". A field nobody reads is cost on every page load and a liability in
every future screenshot; a field a screen needs is not waste even if it feels like
one.

Status: **audited, three changes landed, one decision left for the owner.** The
endpoints that turned out NOT to be problems are recorded too — an audit that only
lists what it changed teaches nothing about the rest.

## Landed

### `allowed_roles` off the public category list — `GET /categories`

Already fixed in `cfa3c38`. Recorded as the template for this audit: the field
answered "what may this caller see", and shipping it on the render payload told
every caller — guest included — the access rule of every category in the board.
Now served only by `GET /admin/categories`, behind `manage_categories`.

### `latestTopics` off the main-page projection — `GET /api/aerun/forum-index`

Landed in `4dc5c6e`. Fifty whole topic records on every page load to render one
navbar integer, which was itself capped at the page size and computed against a
per-browser localStorage map. The count is now `unread_topics` on
`/me/unread-counts`, where the notification and DM counters already lived.

### `GET /roles` reduced to badge fields — the defect below, now closed

`GET /roles` is ungated on purpose (`account_isolation_test.go` pins that a
signed-out visitor must still render role badges), so the fix was to gate the
FIELDS, not the route.

The client's gate is what made that necessary, so the halves had to land together:

1. **The gate reads the answer instead of re-deriving it.** `hasPermission`
   resolved the caller's role in the registry and read that role's permission list
   — a second copy of a decision the command layer had already made, derived from
   the ROLE column and therefore blind to the status narrowing the server applies.
   It now reads `/me`'s effective `permissions`, the same fact the command layer
   enforces. That is what stops the matrix from being load-bearing.
2. **Guests get an answer too.** `fetchUserProfile` needs a uid, so a signed-out
   visitor never fetched `/me` and had no server answer to fall back on.
   `subscribeToEffectivePermissions` reads `/me` for both identities — the guest
   branch of `profilePayload` returns the guest identity with its real permission
   set — keyed by uid (or `guest`), so signing in or out is a different resource
   rather than a stale answer from the previous identity.

`GET /roles` now answers `role_id`, `name`, `rank`, `color` — what a badge paints,
and all four already public through badges on posts. `GET /admin/roles`, behind
`manage_roles`, carries `permissions`, `is_system`, `base_role_id`,
`max_characters_limit` and the record `id` the editor form submits back. The role
table and its save/delete reloads read the admin route.

Pinned by `TestRolePayloadIsSplitByAudience`, asserting BOTH halves: a gate
checking only the public route would pass while the matrix rode along on another
key; one checking only the admin route would pass while the editor silently lost
the fields it needs — the failure that makes roles unfixable.

## Reviewed and deliberately left alone

Recording these matters: an audit listing only its own edits reads as if the rest
was never looked at.

**`GET /roles` is public at all** — deliberate, per the isolation test above.

**`GET /designs` is public** — the CSS/JS/logos of every design is the product
(theme switching), a published theme store rather than a leak. It does mean anyone
can read a design's `js`, so designs must never hold secrets; that is a constraint
on the collection, not a defect in the read.

**`GET /presence/guests` and `GET /presence/online-users` are DEAD ROUTES.** An
earlier draft of this audit recorded them as "deliberately public" — that was wrong,
and the distinction matters. They are not public *by decision*; they are leftovers
from before `GET /api/aerun/status`, which already answers both questions in one
snapshot (`presence.users`, `presence.guests`, `presence.guests_count`) and is what
the client actually polls, through a single shared `statusPoll` in
`rtdb-presence.js` that also feeds AuthProvider, ForumStats and the connection
banner. No client code calls either route; they survive only in Go tests and docs.
They are candidates for deletion rather than for an access-control decision.

## Decisions for the owner

These are not silent edits. Each changes what the client can decide on its own,
which is a product call rather than a cleanup.

### 1. ~~Client-side `hasPermission()` vs. server-only permissions~~ — DECIDED, DONE

The owner chose (b). `hasPermission` now reads the effective permission set from
`/me` instead of re-deriving it from the role registry, guests included, and
`GET /roles` is reduced to badge fields. See the Landed section.

Recorded here because the rejected option is worth keeping: the permission NAMES
are compiled into `src/constants/permissions.js` and shipped in the JS bundle, so
the vocabulary was never secret. What (b) actually protects is the per-role
ASSIGNMENT — which account may do what — and it removes the second authority that
could disagree with the server rather than pretending to remove a public constant.

### 2. ~~`max_characters_limit` and `base_role_id`~~ — moved to `/admin/roles`

Neither is a badge field, and both now travel only with `manage_roles`.

### 3. The audit has not covered the admin routes field-by-field

`/admin/*` payloads were checked for GATE PRESENCE, not field-by-field: each is
behind a permission, and an admin who can change a role does not need the
permission hidden from them. If the same field-level treatment should be applied to
the admin surface — separating "renders a form" from "edits a form" — that is the
same shape of work as the category cut.

**`GET /me` does not leak email.** Pinned by `http_test.go` (`notExpect:
player@example.com`), and the guest branch is pinned to contain no `email` key.

**`GET /users/:id/voters` masks private voters.** `rep_show_history` is honoured,
the voter becomes `Anonymous` with a nil id, and the caller's own votes plus staff
see through. Correct as written.

**`GET /admin/users` returns `role` and `status` for every account.** Gated behind
`change_roles`; this is the moderation surface and needs exactly these.

**`GET /forum-stats` returns aggregate counts and the newest member.** Public totals
are the product. `newestUser` carries id, nickname and role — all three already
public via the online list and post badges.

navbar integer, which was itself capped at the page size and computed against a
per-browser localStorage map. The count is now `unread_topics` on
`/me/unread-counts`, where the notification and DM counters already lived.
