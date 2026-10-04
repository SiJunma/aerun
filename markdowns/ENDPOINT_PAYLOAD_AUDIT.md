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

### 3. Admin routes, field by field — DONE, one decision left

The owner asked for the same treatment on `/admin/*`. The principle differs from
the public side: an admin who can change a role does not need the permission
hidden from them, so the question is not "may they know" but "is this field doing
a job".

- **`GET /admin/users`** — `id`, `nickname`, `role`, `status`, `verified`,
  `avatar_url`, `created`, `updated`, `last_seen`, and the three counters the
  members table sorts on. Every field is rendered. Correctly omits `email`.
- **`GET /admin/roles`, `GET /admin/categories`** — already split above.
- **`GET /admin/audit-logs`** — the record of what staff did. Nothing to trim.
- **`GET /admin/outbox-events`** — the ONE finding, below.

#### The outbox publishes every member's email address, and no UI renders it

`outboxEventPayload` echoes the stored row verbatim, and `MailPayload` carries
`to_email` and `body_text`. That row exists because the WORKER needs the address to
dispatch — so the field is correct in storage and wrong in an operator read.

The shape of the problem: `/me` is pinned by test not to leak an email,
`/admin/users` omits one by hand, and the outbox hands an admin the full mailing
address of every member who has ever been mailed, plus the rendered body of each
message. It is the only place an admin can read member emails at all, and it is
there as a byproduct of echoing the dispatch payload rather than as a decision.

Mitigating, and why it is a decision rather than a fix: `view_audit_log` is
**root/admin only** — `moderator` does not hold it (see the imported role matrix),
so this is not a broad disclosure. And the operator view has a real use that
argues for keeping it: "which address bounced, and what did we actually try to
send" is the whole point of an outbox screen, and trimming the payload would make
the view unable to diagnose the failure it exists for.

So the finding is recorded rather than acted on. The options, if you want it
changed: drop `to_email` and let staff resolve the address through `recipient_id`,
which costs the bounce diagnosis; or keep it and say so out loud, which costs the
inconsistency.

Worth noting separately: **no client code calls `/admin/outbox-events`.** It is an
API surface exercised only by tests. Confirm that is intended rather than a UI
that was planned and not built.

### 4. The duplicated requests in the network log — most are NOT bugs

The screenshot showed `forum-stats` ×2, `forum-index` ×2, `designs` ×2,
`notifications?limit=100` ×2 and `heartbeat` ×4 on a single page view. That reads
like the same class of duplicate that was fixed for notifications and
`unread-counts`. It is not, and "fixing" it would have been wasted work.

`src/main.jsx` wraps the app in `<StrictMode>`. React double-invokes mount
effects — setup, cleanup, setup — so every mount effect in the tree fires its
request twice in development. The uniformity is the tell: five different
resources, all doubled, all from mount effects, and `/status` and `/roles` NOT
doubled (they are shared polls with reference counting and a subscriber that
mounts once). In production there is no double-invoke and each fires once.

So: recorded, not changed. The reason it is written down at all is that a
developer looking at that log will otherwise spend an afternoon deduplicating
endpoints that are not duplicated.

**One real bug was hiding underneath it.** `refreshForumState` had no in-flight
guard, so two callers could read the forum concurrently and whichever RESPONSE
arrived last won — not whichever asked first. A mutation's refresh (scheduled
1.5s after a post) racing an identity-change refresh, with the slower response
carrying counters computed before the post, would repaint the index with the
older numbers after the newer ones had landed. Now single-flight with at most
one queued read behind it, which is the same shape `shared-poll` already uses:
joining the in-flight read would be wrong here, because that is precisely the
stale answer.

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
