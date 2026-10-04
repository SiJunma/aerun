# Endpoint payload audit

Written 2026-10-03, after the `allowed_roles` cut on the category list prompted
the question "what else is being sent that nobody asked for?".

**Scope.** Every `/api/aerun` endpoint that answers a RENDER, checked against what
the consuming component actually reads. The test applied throughout is not "is this
field sensitive" but "does a consumer read it, and would the screen be wrong
without it". A field nobody reads is cost on every page load and a liability in
every future screenshot; a field a screen needs is not waste even if it feels like
one.

Status: **audited, two changes landed, one real defect found, three decisions for
the owner.** The endpoints that turned out NOT to be problems are recorded too — an
audit that only lists what it changed teaches nothing about the rest.

## Landed

### `allowed_roles` off the public category list — `GET /categories`

Already fixed in `cfa3c38`. Recorded as the template for this audit: the field
answered "what may this caller see", and shipping it on the render payload told
every caller — guest included — the access rule of every category in the board.
Now served only by `GET /admin/categories`, behind `manage_categories`.

### `latestTopics` off the main-page projection — `GET /api/aerun/forum-index`

Landed in `4dc5c6e`. Fifty whole topic records on every page load to render one

## Open defect: `GET /roles` publishes the permission matrix of every role

**This is the same defect as `allowed_roles`, one level up, and it is still open.**

`roleRecordPayload` returns `permissions`, `max_characters_limit`, `base_role_id`
and `is_system` for every role, on a route with **no permission gate** — anyone,
including a signed-out guest, can read the complete authorisation model of the
board: which roles exist, what each may do, which system role a custom one derives
from, and how many masks its members may hold. That is a map of the entire
security model, and it is the single most useful thing to read before choosing an
account to target.

The route is public for a real reason — `account_isolation_test.go` records that
`AuthProvider` subscribes to roles unconditionally, because a signed-OUT visitor
must still render role badges and the theme must load before a session exists. So
the fix is to gate the FIELDS, not the route:

- Public needs `id`, `name`, `color`, `rank` — what a badge renders.
- Admin needs `permissions`, `is_system`, `base_role_id`, `max_characters_limit` —
  the editable form.

Same split as categories, same reason: two different questions answered by one
payload. `GET /admin/roles` behind `manage_roles` is the natural home for the
second set. **Deliberately not done here** — see decision 1, because `hasPermission`
evaluates the CLIENT'S copy of the permission list, and moving the fields changes
what the client can decide on its own.

## Reviewed and deliberately left alone

Recording these matters: an audit listing only its own edits reads as if the rest
was never looked at.

**`GET /roles` is public at all** — deliberate, per the isolation test above.

**`GET /designs` is public** — the CSS/JS/logos of every design is the product
(theme switching), a published theme store rather than a leak. It does mean anyone
can read a design's `js`, so designs must never hold secrets; that is a constraint
on the collection, not a defect in the read.

**`GET /presence/guests` publishes guest ids and `last_seen` to everyone.** The
handler argues it deliberately: the sibling `/presence/online-users` already
publishes member ids and nicknames, so hiding opaque visitor ids while publishing
member identities would be incoherent. Accepted — the rows carry no PII (an id and
two timestamps), which is what makes it defensible.

**`GET /presence/online-users` publishes member id, nickname, avatar and role** to
everyone. Same reasoning: the online list is a public feature, and a role badge on a
post already reveals the role.


## Decisions for the owner

These are not silent edits. Each changes what the client can decide on its own,
which is a product call rather than a cleanup.

### 1. Client-side `hasPermission()` vs. server-only permissions

`AuthProvider.hasPermission` reads `roles[].permissions` to decide what UI to
render. If the permission lists move behind `manage_roles`, that check has nothing
to read and every client-side gate breaks.

- **(a) Keep the matrix public.** The permission NAMES are already public — they
  are compiled into `src/constants/permissions.js` and shipped in the JS bundle,
  including every key and which system role maps to which. Moving the server
  payload would change nothing an attacker cannot already read from static assets,
  and would add a second source of truth to keep in sync. The honest framing:
  **the permission vocabulary is public by design and the server treats it as
  such.** What should be gated is the per-role ASSIGNMENT.
- **(b) Gate on the server's own answer.** `/me` already returns the caller's
  effective `permissions` via `profilePayload` — that is what client gates should
  read. Then `/roles` public needs only badge fields, and the matrix in
  `DEFAULT_ROLES` stops being load-bearing.

**(b) is the correct end state**: one authority for "what may this caller do",
already present, currently duplicated. It is a real refactor of gating across the
app, so recommend scheduling it rather than rushing it. Until then (a) is the
status quo and this audit records that it is a decision, not an oversight.

### 2. `max_characters_limit` and `base_role_id` are pure configuration

Neither is a badge field. Under (a) they stay public as part of the already-public
matrix; under (b) they move to `/admin/roles`. Low stakes either way — recorded so
the choice is deliberate rather than accidental.

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
