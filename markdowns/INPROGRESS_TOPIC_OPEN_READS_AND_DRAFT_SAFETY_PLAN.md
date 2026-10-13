# Topic open reads + unsent-reply safety

Written 2026-10-11. Owner-approved plan, **not yet implemented**.

Three things landed here: a network audit of what the topic page asks for on
open, a new feature — an unsent reply must never be lost to a topic that closes
or disappears under the author (both from one conversation), and the `@All`
broadcast mention — a task previously handed to an agent and lost, recovered
into a written spec on 2026-10-11 (Part 9).

Written as a file because the scope spans four backend handlers, two API modules,
one page, a new global modal and — since Part 9 — a permission key; nothing about
it survives an agent change in chat history. Read `.agent/rules/AGENTS.md` before
touching anything below.

**Status: IN PROGRESS → COMPLETE (2026-10-12). All items shipped.**
Checkpoint 1 (B1 stats) SHIPPED 2026-10-12 — all five §7 questions resolved 2026-10-11 —
§7.5 settled as Variant B (two notification resource names). Part 9 (`@All`
mention tag) added the same day from owner rulings. Step 2 (F3 characters
sharedPoll) SHIPPED 2026-10-12. Part 4 (F4 unsent-reply rescue) SHIPPED
2026-10-12. Part 8 (F6 banned-member contract) SHIPPED 2026-10-12.
B2 (`/context` backend), C1 (`fetchTopicContext` API), C2 (TopicPage collapsed),
B3 (notification filters), C3 (`subscribeToTopicNotifications`),
B5 (README §endpoints updated), Part 9 (B6 `PermMentionAll`, B7 migration
`1769500000`, B8 delivery branch, C8 frontend constants) — all SHIPPED 2026-10-12.

## Progress log

### Part 9 — B6/B7/B8/C8 `@All` broadcast mention (SHIPPED 2026-10-12)

- **B6 — `PermMentionAll`** added to `backend/internal/auth/permission.go` const block
  and `allPermissions` registry. Admin/root inherit it via `AllPermissions()`; player,
  moderator, spectator and guest do not — default-off everywhere else, exactly per the
  owner ruling (2026-10-11).
- **B7 — Migration `1769500000_mention_all_permission.go`** in `backend/internal/migrations/`:
  extends the `roles.permissions` SelectField dictionary and calls
  `reconcileSystemRolePermissions` — the same two-step recipe as `1769400000`. Idempotent.
  Covered by `1769500000_mention_all_permission_test.go`.
- **B8 — Delivery branch** in `post_notifications.go`:
  - `mentionAllRegex` (`(?:^|[^a-zA-Z0-9_])@All(?:[^a-zA-Z0-9_]|$)`) next to
    `quoteRegex`/`mentionRegex`.
  - Section 4 in `dispatchPostNotifications`: checks `mentionAllRegex.MatchString(content)`,
    loads the author record, calls `accessForUser`, verifies `PermMentionAll`; on success
    queries ALL users excluding the author and calls `deliver(u.Id, "post_mentioned")`.
    The `seen` dedup map ensures a post that `@All`s AND names one member gives that member
    exactly one row.
  - Tests added: regex standalone-only, permitted dispatch (all users notified), unpermitted
    no-op, dedup with named mention.
- **C8 — `src/constants/permissions.js`**:
  - `PERMISSIONS.MENTION_ALL = 'mention_all'`.
  - `PERMISSION_LABELS` entry (en: 'Broadcast @All Mentions', ru: 'Уведомление всех (@All)').
  - Added to `PERMISSION_GROUPS.features`.
  - `MAX_ROLE_PERMISSIONS.player` and `.moderator` ceilings include `MENTION_ALL`
    (admin picks it up from `Object.values(PERMISSIONS)` automatically).
- **Go test** `TestMentionAllPermissionDefaultsAndStatusNarrowing` in `auth_test.go`: pins
  the matrix — admin/root hold it, player/moderator/spectator/guest do not; pending and
  banned accounts lose it via `NarrowForStatus`.

### Steps B2/C1/C2/B3/C3/B5 — topic-open 7→4 consolidation (SHIPPED 2026-10-12)

- **B2 — `topic_context.go`**: `getTopicContextHandler` (GET /api/aerun/topics/{id}/context)
  returns `{ topic_id, draft, subscribed, votes, request_id }`. Votes carry full fields
  (`id, post_id, topic_id, target_id, voter_id, value, comment, created_at`) so
  `VoteInfoModal` can view/edit comments without a second request.
  Banned caller: `403` before visibility check. Guest: `200` with empty shape.
- **C1 — `src/api/forum.js`**: `fetchTopicContext(topicId)` exported. Normalises `votes`
  into `{ [post_id]: voteObj }` so `setMyVotes` state setter stays unchanged.
  Signal filter also fixed: DM signals and `topic.post` signals for OTHER topics no longer
  trigger stats refresh.
- **C2 — `src/pages/TopicPage.jsx`**: three separate mount effects (draft, votes,
  subscription) collapsed into one `fetchTopicContext` call; notifications effect switched
  from `subscribeToUserNotifications` with client-side filter to `subscribeToTopicNotifications`
  (server-filtered). `subscribeToCharacters` separated into its own `[user?.uid]`-keyed
  effect. Removed `getVotesInTopic`, `subscribeToTopicStatus`, `subscribeToUserNotifications`
  imports and the now-redundant `getTopicDraft`.
- **B3 — `notifications.go`**: `type=quote` filter expands to
  `dbx.In("type", "post_quoted", "post_mentioned", "POST_MENTIONED")`. `topic_id=` param
  filters on `json_extract(payload, '$.topic_id')`. Existing callers unaffected.
- **C3 — `rtdb-notifications.js`**: `topicNotificationsResource(uid, topicId)` and
  `subscribeToTopicNotifications(uid, topicId, cb)` exported (Variant B resource name
  `notifications:${uid}:topic:${topicId}`). Re-exported through `notifications.js`.
- **B5 — `backend/README.md`**: `/stats`, `/context`, and notification filter params
  documented under the Sprint 4 route table with the "one question" justification.

### Part 8 — F6 the banned-member contract (SHIPPED 2026-10-12)

The incident: `GlobalModals` has always read `sessionStorage['banned_logout']`
(`GlobalModals.jsx:24-26`) to raise «Доступ заблокирован», but the Firebase-era
effect that WROTE the flag (commit `e746c09`) was lost in the PocketBase
migration. Nothing wrote it, so a banned member was evicted silently:
`ProtectedRoute` shadow-logged them to a guest for routing, every topic read
answered `404` that read as "content missing", the forum shell came back empty
after a reload — and the modal never appeared. `LoginPage.jsx:46-48` returned
`null` waiting for a forced logout that never came. Silent failure by
`.agent/rules/AGENTS.md` §Zero Silent Failures.

- **C6 — `AuthProvider.jsx`.** The monitoring effect is restored immediately
  after `logout` (it must be, or `logout` in the deps array is a TDZ error at
  render time). One branch covers both halves of the owner's ruling because
  both arrive identically — as a profile whose `status` reads `'banned'`:
  banned mid-session (the `refreshOwnProfile` snapshot re-reads the row) and
  banned at sign-in (the OAuth branch loads it right after the credentials
  resolve). It writes the flag, then `logout(true)` — presence cleanup skipped,
  because a banned account has already lost every permission and
  `setRtdbOffline` would only be a permission-denied write on the way out. No
  re-entrancy latch: `logout` clears the auth store, `pb.authStore.onChange`
  hands that to `resetAuthState`, and a null user/profile returns before the
  flag can be written twice.
- **C7 — `scripts/check-account-status-axis.mjs`.** Extended with the section
  this incident needs: AuthProvider must write `banned_logout` BEFORE it signs
  the session out, and no component may read the flag unless that writer
  exists. Verified by negative test — deleting the writer makes the gate name
  the orphaned reader (`GlobalModals.jsx`); deleting the eviction makes it
  report "writes but never signs out". Both directions fire.
- **Go — `forum_read_contract_regressions_test.go`.** `TestMyVotesAreServable`
  now pins `403` for a banned caller on `/me/votes`, the same refusal the
  future `/context` (Part 6c) must mirror. The `404` half — banned topic reads —
  was already pinned at `topic_stats_test.go:117-128`. `/context` itself does
  not exist yet, so its `403` pin lands with Part 6, not here.

**Gates:** `check-account-status-axis.mjs` 3/3 ok (plus both negative tests);
`check-identity-refresh` / `check-drafts-and-settings` /
`check-forum-read-contract` / `check-last-selected-mask` /
`check-user-profile-normalization` all ok (every gate that reads AuthProvider);
`eslint .` clean; `TestMyVotesAreServable` PASS. The full `npm test` chain
reached `test:shared-poll` (4/4) before the terminal wrapper killed the run —
an environment artifact, not a failure; the touched files' own gates are green.


### Part 4 — F4 the unsent-reply rescue (SHIPPED 2026-10-12)

The incident: a member writes a reply, presses send, and the server refuses
(post limit reached, moderator lock) or the topic is deleted underneath them.
The form died and the text was gone, because it only ever lived in React state
and in `DRAFT_KEY` — which only *that topic's page* reads back, and a locked
topic has no composer while a deleted topic has no page.

Client-side only, localStorage only, no server change. Second key
`aerun_unsent_reply_${topicId}_${uid} → {content, saved_at, reason}`, uid a
correctness requirement (no pooling of visitors' text on a shared machine).

Decisions taken while building (owner ruling preserved):

- **Three write paths, one gate.** `submitReply`'s catch (the incident itself:
  404 → `topic_unavailable`, anything else → `topic_closed`); and a postability
  effect that fires when `is_locked` flips via the stats poll *or* the read
  turns 404/403 — written from the effect, before React unmounts the composer,
  because an unmount cleanup is not guaranteed to run and is too late anyway.
  An empty form writes nothing: a rescue nobody typed reads as a phantom reply.
- **Dedupe via `rescueWrittenRef`**, latched only on a successful key write and
  compared per-topic, so the 15s stats poll cannot re-write every tick. The
  latch is an OBJECT (`{topicId, reason}`), not the reason string: the
  postability effect reads `.topicId`, and a bare string would leave it
  undefined so a navigation's old-topic poll could suppress a new rescue.
  Cleared when the text changes or is emptied.
- **Cleared in exactly two situations** — successful submit (beside `DRAFT_KEY`)
  and the modal's delete. **No age-based eviction**, by explicit owner ruling:
  *«Как только юзер нажмёт "удалить автордафт" — он удалится и из хранилища»*.
- **Global surface, not a TopicPage button.** `UnsentReplyNotice` mounts in
  `App.jsx` beside `GlobalModals` — the case that most needs the rescue is the
  one where the topic page no longer exists to show it on. Cross-tab via the
  `storage` event, same-tab via a listener bus (`storage` does not fire in the
  document that wrote).
- **The modal is a copy, not a form.** `<pre>`, BBCode deliberately not applied
  — what must reach the clipboard is the SOURCE, exactly as DraftsPage reasons.
  Delete takes two clicks. Explicitly out of scope: pasting it into another
  topic's form.
- **`listUnsentReplies` scans with `key(i)`**, not `Object.keys`: a Storage
  object exposes entries as indexed properties, so `Object.keys` returns `[]`
  and the notice would show nothing forever while every single read worked.
- **Guests are not served** — no uid, and a `guest` bucket would pool every
  visitor's text on a shared machine. Their text still survives in `DRAFT_KEY`.

Files: `src/api/unsent-replies.js` (store, bus, list, lifecycle),
`src/components/modals/UnsentReplyModal.jsx` (ForumModal),
`src/components/common/UnsentReplyNotice.jsx` (global button + auto-open),
`src/pages/TopicPage.jsx` (three write paths + clear on success),
`src/App.jsx` (mount), `src/i18n/dictionary.js` (both languages),
`scripts/check-unsent-reply-rescue.mjs` (13 checks, wired into `npm test`).

Verified: 13/13 gate checks PASS, eslint clean (0 warnings) on all five touched
frontend files, full `npm test` green.

### Checkpoint 1 — B1 `GET /topics/{id}/stats` (SHIPPED 2026-10-12)

Owner rulings taken during implementation (verified against the code, §B1):

- `getTopicHandler` carries NO visibility check — the plan's "same check as
  getTopicHandler" describes a check that does not exist. `canViewTopic` added
  to BOTH handlers in one change; hidden thread answers `404` from both.
- Full topic loads ONCE per open (`fetchTopic`); `stats` runs sequentially
  after it as the freshness loop (15s + `topic.post` realtime nudge, polling
  as fallback).

Files: `backend/.../forum_topics.go` (stats handler + canViewTopic in both),
`run.go` (route), `topic_stats_test.go` (5 tests), `src/api/forum.js`
(fetchTopic/fetchTopicStats/subscribeToTopicStats), `src/pages/TopicPage.jsx`
(one-shot full read + stats-loop merge), `scripts/check-forum-read-contract.mjs`
(B1 gate), `backend/README.md` (route docs).

Verified: `gofmt -l` empty, `go vet` clean, 5/5 stats tests PASS, read-contract
gate prints `OK topic freshness`, eslint clean.

### Step 2 — F3 `subscribeToCharacters` on sharedPoll (SHIPPED 2026-10-12)

Row #4 of Part 1: `GET /users/{uid}/characters` was the one topic-open read with
no shared cache — TopicPage, TopicFormPage and ProfilePage each paid their own
request for the same member's masks.

- `subscribeToCharacters` wrapped in `sharedPoll('characters:${uid}')`. Keyed by
  account for the same reason as `notifications:${uid}`: the resource caches the
  last value, so without the uid a sign-out/sign-in on a shared machine would
  paint the previous member's masks for one tick.
- `intervalMs: 0` — no timer. Masks move through the profile editor this session
  owns, so a poll would re-read what nobody else writes. A mask edited elsewhere
  re-reads on remount.
- `refreshCharacters(uid)` added and called from `addCharacter`,
  `updateCharacter`, `deleteCharacter`, `uploadCharacterAvatar`: the server state
  already moved, every subscriber still renders the last read value. Best effort,
  wrapped in try/catch — a missed refresh only delays masks, never fails a write
  (same contract as `refreshUnreadCounts` in `dms.js`).
- `uploadCharacterAvatar(charId, file, uid = '')` gained the third parameter.
  Without it the call sites silently passed `undefined` and the refresh no-oped.
  `ProfilePage.jsx` now passes the real `uid`.

Also fixed in passing: `scripts/check-last-selected-mask.mjs` matched
`const updateProfile = async (…` literally, so the gate would break the day
`updateProfile` is wrapped in `useCallback` in `AuthProvider.jsx` — it now
accepts both forms.

Files: `src/api/character.js`, `src/pages/ProfilePage.jsx`,
`scripts/check-last-selected-mask.mjs`.

Verified: `npm test` gates (shared-poll, identity-refresh, mask-avatar-isolation,
user-profile-normalization, forum-read-contract, last-selected-mask,
roles-live-update, dm-mutation-state, jsx-comments, endpoints — 0 unmatched
frontend calls), eslint clean.

Next up: Step 3 (F4) — the unsent-reply safety net.

---

## Part 1 — What the topic page asks for today

Seven GETs plus one POST, all fired from mount effects in
`src/pages/TopicPage.jsx`. Measured on the owner's dev build: **418 requests for
146 page loads** — the same seven, repeated on every topic open and every page
turn.

| # | Request | Source | Scope | Cadence |
|---|---|---|---|---|
| 1 | `GET /topics/{id}` | `forum.js:81` via `subscribeToTopic` | topic | **poll 15s** |
| 2 | `GET /topics/{id}/posts?page=…` | `forum.js:254` `fetchSecuredPosts` | topic | once per page turn |
| 3 | `GET /me/notifications?limit=100` | `rtdb-notifications.js:44` | caller | **poll 15s** |
| 4 | `GET /users/{uid}/characters` | `character.js:22` | caller | **once, no sharedPoll** |
| 5 | `GET /me/votes?topic_id=` | `reputation.js:42` | caller + topic | once per mount |
| 6 | `GET /topics/{id}/subscription` | `subscriptions.js:19` | caller + topic | once per mount |
| 7 | `GET /topics/{id}/draft` | `forum.js:387` | caller + topic | once per mount |
| 8 | `POST /topics/{id}/read` | `auth-resources.js:93` | write | once per page |

### The doubled requests in the network log are NOT the bug

Every request above appears twice in dev. That is `src/main.jsx`'s `<StrictMode>`
double-invoking mount effects. Recorded in `markdowns/ENDPOINT_PAYLOAD_AUDIT.md` §4
and deliberately left alone — in production each fires once. Do not "fix" it.

---

## Part 2 — Findings

### F1. `GET /topics/{id}` on a 15s interval carries ~1.2 KB to read three numbers

The poll exists for exactly one consumer: the effect at `TopicPage.jsx:420-443`.
It compares `posts_count`, `last_post_id` and `last_post_at` against
`prevTopicStatsRef` and calls `loadPosts()` when one moved. That is its whole job —
"did this topic change while I was reading it".

Everything else in that payload is unread on this page:

- `author_signature`, `author_status_line`, `author_reputation`,
  `author_posts_count`, `last_post_author`, `last_post_author_avatar` — **zero
  reads** in `TopicPage.jsx`. They exist for `TopicRow.jsx` (category list) and
  come from the same `topicPayload` in `forum_topics.go`.
- `author_name` — one read, `TopicPage.jsx:2465`, as `fallbackName`.

So a member pays ~1.2 KB every 15 seconds to learn three integers. Same defect
class as the one `scripts/check-forum-read-contract.mjs:239` already pins: *"a row
list carried for a number"*.

**Fix: `GET /topics/{id}/stats`** — a new route, answering only what this page
reads on a loop:

```json
{
  "posts_count": 43,
  "last_post_id": "l5ze59v0q4aca04",
  "last_post_at": "2026-08-20 02:43:20.839Z",
  "locked": true,
  "request_id": "…"
}
```

`locked` is **not optional**. `topic.is_locked` gates the reply form in four
places (`TopicPage.jsx:2696, 3206, 3230, 3613`). Today that gate is refreshed by
the topic poll; remove the poll without carrying `locked` and a moderator who
closes a topic leaves readers looking at a live reply form for up to 15 seconds —
which is the exact scenario Part 4 exists to handle. `stats` must be the authority
that closes that window.

**Why a new route rather than trimming `GET /topics/{id}`.** That endpoint is
shared: `subscriptions.js:75` (`fetchTopicById`, the fallback path) reads it, and it
is the public topic read. Owner's ruling: *"лучше несколько мелких под актуальные
нужды своих страниц, чем один большой, который делят несколько слушателей"*.
`/topics/{id}` keeps its full payload for the lists; the topic page pays only for
what it reads.


### F2. `draft`, `subscription`, `me/votes` — three one-shot reads of caller-scoped state

Owner's rulings on all three:

- **draft** — shown on every page of the topic regardless of page number, and
  changes only when the author saves it. **Once per topic, not per page.**
- **subscription** — purely the Follow/Unfollow button state, changes only by the
  author's own action. **Once per topic.**
- **votes** — only paints the karma arrows. The voter list and comments come from a
  *separate* request when the eye button is clicked (`GET /posts/{id}/voters`), so
  the page needs nothing but a `post_id → value` map.

All three are caller-scoped, all three are read once on mount, none is read
anywhere else on this page. That is the same shape as `GET /me/unread-counts`,
which `backend/README.md:321` justifies as *"one question — all four belong on one
endpoint"*.

**Fix: `GET /topics/{id}/context`**

```json
{
  "topic_id": "lrsrfy0uxkcavpc",
  "draft": { "id": "…", "content": "…", "author_character_id": "…", "rolls": {} } | null,
  "subscribed": false,
  "votes": [ { "id": "…", "post_id": "…", "value": 1 } ],
  "request_id": "…"
}
```

Reuses, does not re-implement: `draftPayload` (`drafts.go:33`), the
`topic_subscriptions` lookup from `getTopicSubscriptionStatusHandler`
(`subscriptions.go:126`), the `reputation_votes` lookup from `listMyVotesHandler`
(`reputation.go:679`). One `runCommand` transaction, one `request_id`.

**The guest contract is a requirement, not an option.** Today the three separate
calls fail differently — draft `403`, votes `401`, subscription `200`/`false` — and
all three failures are swallowed (`catch {}` at `TopicPage.jsx:583`, `return {}` at
`reputation.js:53`). Collapsed into one endpoint, a `403` for a signed-out visitor
breaks the **entire topic page**. `/context` must answer `200` with
`{draft: null, subscribed: false, votes: []}` for a guest, the way `profilePayload`
already does for the guest identity. Owner approved this pattern.

### F3. `GET /users/{uid}/characters` is the last `subscribeToX` without a sharedPoll

`subscribeToCharacters` (`character.js:26`) calls `load()` once on mount with no
`sharedPoll` wrapper — the only `subscribeTo*` in the codebase that does. Two
callers (`TopicPage.jsx:645`, `TopicFormPage.jsx:64`) each pay a full request.

Direct violation of `.agent/rules/AGENTS.md:55`: *"subscribe through
`src/api/shared-poll.js`, never with a bare `setInterval`"*.

**Fix:** wrap in `sharedPoll(`characters:${uid}`)`. TopicPage → TopicFormPage then
costs zero requests. Same shape as `topic:` (`forum.js:81`) and `notifications:`
(`rtdb-notifications.js:42`).

### F4. `notifications?limit=100` pulls a hundred records to find 0–3 quotes

`TopicPage.jsx:598` subscribes to the caller's whole notification list and filters
in the browser:

```js
n.payload?.topic_id === id &&
(n.type === 'post_quoted' || n.type === 'post_mentioned' || …)
```

Same defect already fixed twice — `Navbar.jsx:31` and `TitleProvider.jsx:64` both
moved to `/me/unread-counts`. TopicPage stayed because it needs *rows*, not a
count.

`listUserNotificationsHandler` (`notifications.go:288`) already supports
`unread=true`. It supports **neither** `type` nor `topic_id`.

**Fix:** add both filters, and point the topic page at
`/me/notifications?unread=true&type=quote&topic_id={id}` — with `type=quote`
covering the whole family per the owner ruling below (quote, profile mention,
`@All`).

> **Constraint this creates.** The client-side filter also matches
> `POST_MENTIONED` (uppercase — a legacy value). A server-side `type=quote` must
> match **both** spellings or mentions silently stop highlighting. Enumerate the
> stored `type` values before writing the predicate; do not assume the frontend's
> list is exhaustive.
>
> **Owner ruling (2026-10-11): the family is wider than "quotes".** `type=quote`
> must cover a post that carries a **quote**, a **profile mention**, or an
> **`@All`** — all three. And the read-on-focus behaviour must cover all three
> too: when a post with a quote/mention/@All scrolls into view, its notification
> is marked read. That mechanism already exists — `IntersectionObserver` at
> `TopicPage.jsx:612-626` calls `markNotificationRead(n.id)` for the matching
> rows — so the work is widening what matches, not inventing the trigger.
>
> Two vocabularies must be reconciled before the server predicate is written:
> (a) what the backend CREATES today — `post_quoted` (`post_notifications.go:112`)
> and `post_mentioned` (`:117`); (b) what is STORED — the migration dump carries
> legacy `POST_MENTIONED` uppercase rows. For `@All` there is nothing to
> reconcile: no `@All` type exists in the current backend or in
> `functions/index.js`, and the owner confirmed (2026-10-11) that **Firebase
> never had the feature** — an earlier attempt to build it was simply lost.
> `@All` is now a greenfield spec: Part 9, whose delivery design (recommended:
> reusing `post_mentioned`) is what the family filter has to match.

### F5. Realtime is not a second source of truth here — do not treat it as one

`realtime_signals` carries `{topic, entity_id, audience_id, at}` and **no record
data** (`realtime-signals.js:6`). `shared-poll` treats a signal purely as a nudge
to re-read through `/api/aerun`, where authorization lives.

So replacing the 15s `topics/{id}` poll with `stats` does **not** change the
realtime relationship at all — the signal was already only triggering the same
`/api/aerun` read. What changes is the *size* of that read. `stats` must be bound
to the same signal path as `topic:` is, or a topic change will stop nudging the
page and freshness drops to the 15s floor.

**Owner ruling (2026-10-11): `stats` is realtime-driven, with polling as the
fallback — the interval is not the primary channel.** *«Он должен идти от
реалтайм с фоллбеком на поллингу. Мы для чего реалтайм делали вообще тогда?»*
This is exactly the pattern `notificationsResource` already follows
(`rtdb-notifications.js:57-60`): the interval stays configured as the fallback
for a silent stream, and `shared-poll` drops it the moment a signal arrives. A
member with a healthy stream pays no polling; a member whose stream is silent
keeps the pre-realtime behaviour. Same contract for `stats`.

### F6. A banned member is told nothing — every door just says "not found" (incident 2026-10-11)

Incident, owner-reported: when a member is banned, they receive **no notification and no banner**; opening any topic throws them to "Этот топик не найден"; on a page reload the categories are not served at all. The session stays alive and nothing ever explains why.

What the code shows:

- **Backend:** a banned account loses every permission including `view_forum`
  (`backend/internal/auth/auth_test.go:187-189`), so `canViewCategory` refuses it
  before the role is even consulted (`account_isolation_test.go:310-313`) and
  every topic read answers `404` — byte-identical to a genuinely missing topic.
  The categories read returns no rows (`account_isolation_test.go:95`).
  `listMyVotesHandler:683` answers `403`, and per owner (2026-10-11) a banned
  member must not reach it at all.
- **Client:** `ProtectedRoute.jsx:30-31` already reads
  `profile?.status === 'banned'` and shadows the user to `null` for routing;
  `LoginPage.jsx:46-48` returns `null` waiting for the forced logout that
  AuthProvider is supposed to trigger — the Firebase-era behaviour that was never
  ported to PocketBase. The finished UI already exists: `BannedLogoutModal`
  («Доступ заблокирован», `dictionary.js:822-823`) is raised by
  `GlobalModals.jsx:24-26` from the `sessionStorage['banned_logout']` flag — and
  **nothing in the codebase ever sets that flag.** The modal is wired to a
  trigger that was never rebuilt.

Required behaviour (owner, 2026-10-11): a logged-in banned member sees the
«Доступ заблокирован» modal; a banned account attempting to sign in is evicted
from the authed session immediately (Firebase parity). Until this lands, every
"topic not found" and every blank category page for a banned member is a silent
failure by `.agent/rules/AGENTS.md` §Zero Silent Failures. Work items: Part 8.

Scope note for this plan: the incident *constrains* the 7→4 consolidation rather
than extending it — `/context` (B2) keeps the same `403` a banned caller already
gets from `listMyVotesHandler`, because a banned member is supposed to be
intercepted globally (Part 8), not served an empty context.

---
## Part 3 — Backend work

### B1. `GET /api/aerun/topics/{id}/stats` (new file `topic_stats.go`)

No `RequirePermission` — it is a read of a publicly visible topic, same as
`GET /topics/{id}`. Must honour the same category-visibility check
(`canViewCategory`) that `getTopicHandler` uses, or it becomes a way to read a
topic the caller may not see.

> **Owner ruling 2026-10-12 (verified against the code, not the plan).**
> `getTopicHandler` (`forum_topics.go:466`) carries NO visibility check — it
> answers any topic by id, while `canViewTopic` is used only in
> `reputation.go`/etc. So the plan's "same check as getTopicHandler" describes
> a check that does not exist. Resolution: `canViewTopic` is added to BOTH
> handlers in one change (a stats route that checks visibility while the full
> read next to it does not would be the wrong way round). A topic in a
> category the caller may not see answers `404` from both routes —
> byte-identical to a missing topic. Sequential stats (below) does NOT remove
> this requirement: the client order is a freshness optimisation, the server
> check is the security boundary, and a direct `GET /stats` must refuse a
> hidden thread on its own.
>
> **Sequencing (owner ruling 2026-10-12).** The full topic loads ONCE per
> topic open (`fetchTopic`); `stats` runs sequentially after it as the
> freshness loop (15s + `topic.post` realtime nudge, polling as fallback).
> The one-shot `fetchTopicStats` right after the full read seeds
> `prevTopicStatsRef`, so the first loop tick compares against what the page
> rendered rather than against nothing.

Fields: `posts_count`, `last_post_id`, `last_post_at`, `locked`, `topic_id`,
`request_id`. Nothing else — every extra field is §F1 happening again.

Guest-safe: a signed-out visitor gets the same shape, since these four facts are
not caller-scoped.

### B2. `GET /api/aerun/topics/{id}/context` (new file `topic_context.go`)

One `runCommand` transaction returning the three caller-scoped reads above.
Guest contract per F2. Banned caller: **`403`, the same refusal
`listMyVotesHandler:683` gives** — resolved 2026-10-11 (§7.1). A banned member
never reaches the topic page at all; explaining the ban to them is the global
interception's job (Part 8), not this endpoint's.

### B3. `type` + `topic_id` filters on `listUserNotificationsHandler`

Additive query params. Existing callers pass neither and keep today's behaviour —
`NotificationsPage.jsx:85` must not change. `topic_id` filters on
`payload.topic_id` (the same key the client filter reads at `TopicPage.jsx:601`),
not on a top-level column — confirm the storage shape first.

### B4. Route registration

All three in `backend/internal/platform/pocketbase/run.go`, in the Sprint 3/4
block near `group.GET("/topics/{id}", getTopicHandler)` (line 373).

**A new Go route needs a backend restart.** `go test` runs handlers in-process and
`npm test` reads frontend source; neither exercises the running binary. A correct
new route answers `404` from a stale process, which reads exactly like a broken
route. Per `ENDPOINT_PAYLOAD_AUDIT.md` §"Operational note":

```powershell
Stop-Process -Name aerun,go -Force
cd backend; go run ./cmd/aerun
```

Compare `(Get-Item backend/internal/platform/pocketbase/run.go).LastWriteTime`
against `(Get-Process -Name aerun).StartTime` before re-reading the route table.

### B5. Update `backend/README.md` §endpoints for B1–B3, with the same
"why one endpoint" justification style used for `/me/unread-counts`.

---

## Part 4 — New feature: an unsent reply must survive a topic closing or vanishing

### The incident this comes from

Owner, on russff: writing a reply, submitting, and the server refuses because the
topic reached its post limit and closed. The reply form died, **the post was never
sent, and the text was gone** — uncopyable. Reported twice more as variants.

### Why it happens today

`submitReply` (`TopicPage.jsx:1409`) optimistically inserts a temp post, calls
`createPost`, and on failure rolls back — but the rollback path restores
`replyContent` from the **in-memory** `savedReplyContent` snapshot
(`TopicPage.jsx:1428`, restored at `1608`). That snapshot lives in a closure. It
survives a failed request. It does **not** survive a reload, a navigation, or the
form unmounting because the topic stopped being postable.

There *is* a localStorage autosave (`TopicPage.jsx:681-697`, key
`aerun_reply_draft_${id}_${uid}`), but it is only read back into the form **on that
same topic's page**. If the topic is gone, or closed, there is no page to read it
back on — and no way to reach the text.

### The design (owner-specified)

Purely client-side. localStorage only. No server change, no new collection — this
is explicitly **not** the server-side draft of `drafts.go`.

**Storage.** A second, deliberate key that is *not* cleared on successful submit
the way `DRAFT_KEY` is, because its job is to outlive the page:

```
aerun_unsent_reply_${topicId}_${uid}   →  { content, saved_at, reason }
```

`reason` records what stranded it: `"topic_closed"` (limit reached or moderator
lock) or `"topic_unavailable"` (deleted or hidden). It drives the modal's wording
and nothing else.

**Trigger — submit refused.** In `submitReply`'s catch (`TopicPage.jsx:1630`),
before the existing toast: if the reply content is non-empty, write the key. This
is the primary path and the one the incident describes.

**Trigger — topic stops being postable under a full form.** When `topic.is_locked`
flips to `true` (via the F1 `stats` poll) **or** the topic read turns
404/403 (`TopicPage.jsx:458-462`), **and** `replyContent.trim()` is non-empty,
write the key and raise the modal. A form that is merely empty is not rescued.

**The modal.** New `src/components/modals/UnsentReplyModal.jsx`, rendered through
`ForumModal` (mandatory — `scripts/check-no-raw-modal.mjs` enforces it; see
`ForumModal.jsx:8` for the stuck-modal bug class raw `<Modal>` causes). Carries:

- the reason, in the member's language
- a **read-only** copy of the text, selectable — the whole point is that it can be
  copied out
- `Копировать` (clipboard)
- `Удалить этот черновик` — clears the key, modal stops appearing
- close without deleting

**Surfacing.** Auto-opens when the rescue is written. Dismissing it does not
delete anything. On any later forum page, if the key exists and the current route
is not that topic, show a small *"у вас есть неотправленный ответ"* button that
reopens the modal. This is what makes the `topic_unavailable` case reachable — the
topic page no longer exists to show it on.

Rendering that button globally means a small provider or a component mounted in
`App.jsx` next to `GlobalModals.jsx`, which is the established place for
cross-page notices driven by storage flags (`banned_logout`,
`maintenance_logout`). Follow its shape: read the flag on mount, `setTimeout(…, 0)`
before showing.

**Lifecycle — the part that decides whether this is a feature or a nuisance.**

- cleared on successful submit (same moment `DRAFT_KEY` is cleared)
- cleared by the modal's delete button — and that is the **only** way it goes
  away besides a successful submit. Owner ruling (2026-10-11): **no age-based
  eviction**: *«Как только юзер нажмёт "удалить автордафт" — он удалится и из
  хранилища»*. A rescue the member has not acted on stays until they act.
- never offered when `replyContent` is empty — nothing to rescue

**Explicitly out of scope:** restoring the text into a *different* topic's form.
The deliverable is that the member can **read and copy** what they wrote. Auto-
pasting it into an unrelated thread would post one member's words under another
thread's context.

### Scope note on the moderator-delete case

Owner's framing: *"если модератор удалит или скроет тему в момент когда у
пользователя был контент в форме ответа — точно такой же flow, но он будет
показываться не на странице топика, а на любой странице форума"*.

That is the `topic_unavailable` reason and the global-surface button above. The
topic page navigates away on delete (`TopicPage.jsx:3796` → category or `/`), so
the rescue write must happen **before** that navigation, in the same effect that
detects the 404 — not in an unmount cleanup, which is not guaranteed to run.

---

## Part 5 — Frontend work

### C1. `src/api/forum.js` — add `fetchTopicStats`, `fetchTopicContext`

`fetchTopicStats` replaces the fetch inside `subscribeToTopic`'s poll, bound to the
same `sharedPoll` and therefore the same realtime nudge (F5).

`fetchTopicContext` returns `{draft, subscribed, votes}`, already normalised into
the shapes `TopicPage` currently stores:

- `draft` → `setMyDraft`, still through `decorateDraft` (`TopicPage.jsx:582`)
- `subscribed` → `setIsSubscribed` (`TopicPage.jsx:655`)
- `votes` → `setMyVotes`, as a `post_id → vote` map, exactly as `getVotesInTopic`
  builds it at `reputation.js:43-51`

Normalising **in the API layer** is what keeps `TopicPage`'s four state setters
untouched. Do not push a raw array into `setMyVotes` — it is indexed by `post_id`
at `TopicPage.jsx:1214`.

### C2. `TopicPage.jsx` — collapse five effects into two

`getTopicDraft` (581), `getVotesInTopic` (648), `subscribeToTopicStatus` (655) and
the topic poll's dependency all fold into one `/context` call plus one `stats`
poll. `subscribeToCharacters` (645) keeps its own effect but gains a sharedPoll.

Keep the `useEffect` dependency arrays honest — the existing ones key on
`[user?.uid, id, profile?.role_id]`, and `profile?.role_id === 'pending'` is a real
gate at `TopicPage.jsx:654`.

### C3. `src/api/rtdb-notifications.js` — pass the filters through

The `fetch` at line 44 needs the topic id and type filters. §7.5 resolved
(2026-10-11): **two resource names.** The topic page subscribes to
`notifications:${uid}:topic:${topicId}` with the filtered fetch
(`?unread=true&type=quote&topic_id=X`); `notifications:${uid}` stays exactly as
today — unfiltered `?limit=100` — for `NotificationsPage`. Two names are
mandatory: `sharedPoll` keys a loop by NAME and the first caller's fetch wins
(`shared-poll.js:453-457`), so one shared name with per-caller filters would
hand the second page the wrong rows. The loops never coexist on one page, so the
topic-open path stays at 4 GETs.

### C4. New `UnsentReplyModal.jsx` + global surface

Per Part 4.

---

## Part 6 — Gating: these are counting bugs

`.agent/rules/AGENTS.md:55`: *"Because these bugs are COUNTING bugs, they are
invisible in review: gate a change here with a test that counts requests, never one
that greps for the call."*

So:

- **`scripts/test-shared-poll.mjs`** (existing) — extend, do not duplicate. It
  already counts requests per resource.
- **New `scripts/check-topic-open-request-count.mjs`** — reads `TopicPage.jsx` +
  the api modules and asserts the topic-open path makes **4 GETs, not 7**: stats,
  posts, notifications, characters. Assert the *absence* of the three collapsed
  calls, and assert `ForumModal` is what the new modal uses.
- **Go tests** — one per new handler in `forum_read_contract_regressions_test.go`
  style. Pin: (a) `/stats` returns exactly four fields and nothing more, (b)
  `/context` answers `200` with empty values for a **guest**, (c) `/context` for a
  banned caller answers `403` — the same answer `listMyVotesHandler` gives;
  banned interception is global (Part 8), never an empty-context `200`,
  (d) the notification filters match **both** `post_quoted` and
  `POST_MENTIONED`; Part 9 delivers `@All` as `post_mentioned`, so no fourth value,
  (e) `unread=true` alone still behaves as before.
- **Banned interception (Part 8)** — a client check that AuthProvider writes
  `sessionStorage['banned_logout']` before signing a banned session out, and
  that `GlobalModals` still raises `BannedLogoutModal` from that flag. The
  incident in F6 happened because the flag was read but never written; pin the
  write.

Register the new script in `package.json` `test` chain alongside the other
`test:*` entries.

---

## Part 7 — Owner decisions (2026-10-11) — all §7 questions resolved (item 6 points to Part 9)

Resolved:

1. **Banned caller on `/context`.** Not an empty `200`. A banned member must
   never reach the topic page at all: the correct behaviour is the
   «Доступ заблокирован» modal when logged in, and an immediate eviction from
   the authed session when signing in — the Firebase behaviour that was never
   ported to PocketBase. `listMyVotesHandler`'s `403` stands, `/context` mirrors
   it, and the interception is a global concern, not an endpoint concern:
   Part 8.
2. **Stale-reply threshold.** None. The rescue is deleted only when the member
   presses «Удалить этот черновик» (or after a successful submit). See the
   Part 4 lifecycle.
3. **`stats` cadence.** Realtime-driven, polling only as the fallback — the
   interval exists for a silent stream and nothing else. See F5.
4. **`type=quote` family.** Yes — profile mentions are included, and `@All` too:
   the server filter and the read-on-focus marking cover quote + profile mention
   + `@All`. See F4 for the vocabulary reconciliation this creates, and Part 9
   for the `@All` feature itself.
5. **Notification subset: two named resources (Variant B).** Resolved
   2026-10-11: *«да, согласна, вариант Б логичнее и правильнее»*.
   `notifications:${uid}` stays exactly as today for `NotificationsPage`
   (unfiltered `?limit=100`); the topic page subscribes to a second loop,
   `notifications:${uid}:topic:${topicId}`, with the filtered fetch
   (`?unread=true&type=quote&topic_id=X`). Two names are mandatory, not a style
   choice: `sharedPoll` keys a loop by NAME and the first caller's fetch wins
   (`shared-poll.js:453-457`), so with one name whichever page loads first would
   dictate the filter and hand the other page the wrong rows. The two callers
   never coexist on one page, so only one loop is ever running — the topic-open
   path stays at 4 GETs and each page gets precisely the rows it asked for.
6. **`@All` broadcast mention.** A new feature — never implemented on Firebase;
   an earlier attempt to build it was lost. Owner's spec (2026-10-11) and every
   work item: **Part 9**.

---

## Part 8 — Restore the banned-member contract (F6 incident)

The modal, the i18n strings and the routing guard all exist; the **trigger**
does not. `GlobalModals` reads `sessionStorage['banned_logout']`
(`GlobalModals.jsx:24-26`) and nothing in the codebase ever writes it, so a
banned member gets no message and no eviction — only `404`s that read as
"content missing" and a forum shell that renders empty after a reload.

Target behaviour (owner, 2026-10-11 — the Firebase-era contract that was never
ported to PocketBase):

1. **Banned while browsing.** The moment the client learns
   `profile.status === 'banned'` (profile refresh, any `403` carrying the ban,
   or the next successful identity read), it writes
   `sessionStorage['banned_logout'] = 'true'` and signs the session out.
   `GlobalModals` then raises the existing «Доступ заблокирован»
   (`BannedLogoutModal`) on the next mount. `LoginPage.jsx:46-48` already waits
   for exactly this — the comment *«AuthProvider will handle the forced logout
   shortly»* describes behaviour that was never implemented.
2. **Banned account trying to sign in.** Same flag, same modal — the session is
   evicted immediately after the credentials resolve and `status` reads
   `banned`, not after the first failed page load.
3. **`ProtectedRoute.jsx:30-31`** keeps its shadow-logout (banned renders as
   guest for routing), but it is no longer the *only* line of defence — today
   it silently downgrades a banned member to a guest who sees empty categories.

Constraints and non-goals:

- **No endpoint special-casing.** The backend answer stays what it is: banned
  loses `view_forum` (`auth_test.go:187-189`), topic reads answer `404`,
  `/context` and `listMyVotesHandler` answer `403`. The *client* owes the
  member an explanation; the server owes nothing but the refusal. This keeps
  the 7→4 consolidation (Parts 3/5) untouched.
- **The ban must also stop being invisible in the session itself.** An
  already-open tab learns it on the next identity/profile read; no new push
  channel is required for v1 (the realtime signal path can carry it later).
- **Verify against legacy first** (`.agent/rules/AGENTS.md:55`): check how
  `main`/Firebase forced the logout and which flag it set, and mirror that —
  do not invent a parallel mechanism.

Work items:

- **C6. AuthProvider** — on identity/profile load, branch on
  `status === 'banned'`: write the `banned_logout` flag, `logout()`, let
  `GlobalModals` speak. One code path for "banned mid-session" and "banned at
  sign-in".
- **C7. Gating** — extend `scripts/check-account-status-axis.mjs` (it already
  pins that `banned` is a status, not a role) with: AuthProvider must write the
  flag before signing out, and no component may read `banned_logout` without a
  writer existing.
- **Go test** — pin the refusal shape that Part 8 relies on: a banned caller
  gets `403` from `/context` (Part 6c) and `404` from topic reads, so a future
  change cannot silently turn a ban into a `200` and make the client-side
  interception unreachable.

Order relative to the rest: independent of steps 1–5; can ship before, between
or after. It does not change the topic-open request count.

---

## Part 9 — New feature: `@All`, a permission-gated broadcast mention (spec 2026-10-11)

Provenance: this was handed to an agent before and lost — written down now so it
survives. Firebase never had the feature (owner, 2026-10-11: *«На Firebase такой
реализации не было»*), so there is no legacy to mirror: this section is the spec.

**The ruling (owner, 2026-10-11):**

1. Gate the tag with a NEW permission key, grantable **from player and above** —
   *«разрешение, которое будет доступно от игрока и выше»*.
2. Defaults: **off for everyone, on for the administrator** — *«по умолчанию
   выключено у всех, у администратора включено»*.
3. Behaviour: a post using the `@All` tag fires a mention notification **to all
   users**. Without the permission the tag fires nothing — the post still
   publishes (*«Без разрешения — не триггерит»*).

**Design — how the ruling maps onto what exists:**

- **Key: `mention_all`** (working name; snake_case like every key in
  `permission.go:5-7`). Register it in `allPermissions` (`permission.go:136`)
  and mirror as `PERMISSIONS.MENTION_ALL`.
- **Defaults fall out of the matrix for free.** Admin and root hold
  `AllPermissions()` (`role.go:80,88`), so registering the key turns it ON for
  the administrator by default — the ruling, satisfied by one line. Player,
  moderator, spectator and guest have explicit lists (`role.go:110-217`) and
  simply do not get it: default-off everywhere else, moderator included.
- **Ceiling = «от игрока и выше».** Add the key to `MAX_ROLE_PERMISSIONS.player`
  and `.moderator` (`permissions.js:446`, `:469`); `admin: Object.values(PERMISSIONS)`
  picks it up automatically (`:511`). The role editor then offers the checkbox
  from player upward and to nothing below player.
- **Delivery = a fourth branch in `dispatchPostNotifications`**
  (`post_notifications.go:65`): token present → deliver to every account except
  the author, inside the same transaction, under the same never-fail-the-post
  rule as quotes and mentions (`:63-64`). The opening post goes through the same
  dispatch (`forum_topics.go:201`); nothing is topic-specific. The `seen` map
  (`:69`) dedups by `recipient|type`, so a post that `@All`s everyone AND names
  one member gives that member exactly one row.
- **Type: REUSE `post_mentioned` — no new notification type.** This is the
  choice that keeps the rest of the plan cheap:
  - the `type=quote` family (F4, §7.4) already matches quote + profile mention +
    `@All` with the set `{post_quoted, post_mentioned, POST_MENTIONED}` — no
    fourth value to reconcile, and Part 6(d) stays as written;
  - `NotificationsPage` renders, labels and pref-filters `post_mentioned`
    today (`NotificationsPage.jsx:44-56`, `:94-97`);
  - TopicPage's highlight and the read-on-focus marking (`TopicPage.jsx:612-626`)
    already key on it.
  The recipient reads the normal *You were mentioned in: …*
  (`post_notifications.go:217`), which is exactly what `@All` is.
- **Enforcement lives in the transaction, server-side.** The branch resolves the
  AUTHOR's effective set by the `access.go:99` path — stored role row →
  `NarrowForStatus` — and skips when `mention_all` is absent. A player who types
  `@All` gets a plain post; any client affordance is cosmetic. Pending accounts
  lose the key to `pendingAllowedPermissions` narrowing automatically
  (`status.go:46`); banned loses everything.
- **Token:** the literal `@All` as a standalone token — not glued to other
  letters on either side (`@Alliance`, `mail@All` must not match), exact casing
  as ruled (widening to case-insensitive is one regex change if wanted later).
  Fires on post CREATE only, the same lifecycle mentions have
  (`forum_posts.go:230`); editing a post to add `@All` notifies nobody.

**Known costs, accepted on purpose:**

- Fan-out is one row per account minus author, inside the post's transaction —
  linear in member count. Fine now; if the member base grows an order of
  magnitude this is the first item to re-shelve (batch), a deliberate deferral,
  not an oversight.
- Recipients who cannot open that category get a notification whose click 404s.
  The ruling says *«всем юзерам»* — all users, no visibility filter in v1.
- No email: mentions are in-app only until their mail types exist
  (`post_notifications.go:93-95`); `@All` rides the same rule.

**Work items (ship as one unit — see Order of work, step 8):**

- **B6. The key itself.** `permission.go`: the const, the `allPermissions`
  registry entry, and nothing in any explicit role list — defaults follow from
  the matrix as described above. Go test pins the matrix reading of the ruling:
  `DefaultPermissions(RoleAdmin)` contains `mention_all`,
  `RolePlayer`/`RoleModerator`/`RoleSpectator`/`RoleGuest` do not, and
  `NarrowForStatus` strips it from pending/banned.
- **B7. Migration for stored rows.** The compiled matrix is only the fallback —
  the admin `roles` row on production was seeded before the key existed, and the
  `roles.permissions` SelectField dictionary may lack the value (the exact gap
  `1769400000_profile_permission_repair.go` documents). New migration after
  `1769400000`, same two steps in the same order: dictionary first, then
  `reconcileSystemRolePermissions` — idempotent, custom roles untouched, revert
  a no-op. Its own test mirrors `1769400000_profile_permission_repair_test.go`.
- **B8. Delivery branch.** `post_notifications.go`: `@All` detection
  (standalone-token regex next to `quoteRegex`/`mentionRegex`), the author
  permission check through the `access.go` path, fan-out to all accounts except
  the author as `post_mentioned`. Go tests: (a) permitted author → one row per
  other account, (b) unpermitted author → zero rows although the tag is in the
  content, (c) `@Alliance`/`mail@All` → zero rows, (d) author never notifies
  self, (e) combined `@All` + named mention → one row for the named member.
- **C8. Frontend.** `src/constants/permissions.js`: `PERMISSIONS.MENTION_ALL`,
  a `PERMISSION_LABELS` entry (en/ru), the `features` group, `MAX_ROLE_PERMISSIONS`
  player/moderator ceilings, `DEFAULT_ROLES` untouched (the ruling is
  default-off). The mention picker in `RichEditor.jsx` may offer an `@All`
  affordance gated on `hasPermission(PERMISSIONS.MENTION_ALL)` — cosmetic;
  server enforcement in B8 is what makes the rule real.
- **Gating.** There is no JS↔Go permission parity script today — create
  `scripts/check-permission-parity.mjs` (or fold the check into B6's Go test):
  the JS `PERMISSIONS` values and Go `AllPermissionValues()` must stay equal
  sets (they are one wire contract, `permission.go:5-7`); `mention_all` missing
  on either side is the drift this whole plan warns about.

---

## Order of work

1. B1 `stats` + Go test → wire into `forum.js`/`TopicPage` → verify the 15s read
   shrinks. **This is the biggest single win and is independently shippable.**
2. F3 `characters` on `sharedPoll` — two lines, removes a standing rule violation.
3. B2 `context` + C1/C2 → **7 GETs become 4.**
4. B3 + C3 notification filters.
5. Part 4, the unsent-reply feature — self-contained, no dependency on 1–4 except
   that F1's `stats` is what makes the "topic closed under me" trigger reliable.
6. Gating scripts + `npm test` + backend CI per `AGENTS.md` §CI.
7. Part 8, the banned-member contract (F6) — independent of 1–5, no effect on
   the request count, but a live incident: ship it whenever its own readiness
   (C6/C7) is reached, even mid-sequence.
8. Part 9, the `@All` mention tag — independent of 1–7, no request-count
   impact; its B6–B8 + C8 ship as one unit: a key the role editor offers but
   the server does not validate (or the reverse) breaks the editor↔server
   contract that `permission.go:5-7` declares.

Steps 1–4 are the audit. Steps 5 and 8 are features. Step 7 is the incident.
They ship separately; 5 does not require 2–4, 7 requires nothing but itself, and
8 needs only Part 9.
