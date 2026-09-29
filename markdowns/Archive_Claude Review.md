# Firebase Security & Cloud Functions Review

**Reviewed:** 2026-07-29
**Scope:** `firestore.rules` (deployed version) + `functions/index.js`
**Not reviewed (not provided):** frontend `src/`, `src/constants/permissions.js`,
`firestore.indexes.json`, actual Firestore data.

## How to use this document

Some fixes may already be applied — **verify current state before changing anything**.
For each item: confirm the defect still exists, apply the fix, then run the
verification step. Do not batch-apply blindly.

The project-context doc (`CURRENT_PROJECT_SCHEMA.json`) is known to be **stale** —
it is missing `users.topics_count`, `settings.maxPostsPerTopic`, the
`post_quoted` notification type, and it documents a `characters` root collection
that does not exist. Treat code and data as authoritative, not that file.

---

## Cross-cutting decision required first

A full server-side permission layer exists (`getSecuredCategories`,
`getSecuredTopics`, `getSecuredPosts`, `getUserPosts`, `getReputationLogs`), but
the rules leave `topics`, `posts`, `categories` and `reputation_logs` at
`allow read: if true`. A client can read everything directly with the SDK and
bypass the entire layer — including restricted categories, master dice values and
`[hide]` tag contents, which are only stripped inside `getSecuredPosts`.

Pick one, then the rules follow:

- **Option A — close direct reads, callables only.** `topics`/`posts`/`categories`:
  `allow read: if isAdmin();`. Cheap and airtight. Breaks any `onSnapshot`
  realtime listeners on those collections.
- **Option B — denormalize `category_id` into `posts`** (posts currently have no
  such field; `getUserPosts` reconstructs it via `topics`) and gate reads in the
  rules with `hasCategoryPermission(resource.data.category_id, 'view_forum')`.
  Keeps realtime, needs a backfill, a write of the field at post creation, and
  every client query narrowed — in a `list`, one inaccessible document fails the
  whole query.

For `posts` specifically, Option A is the stronger choice because dice/hide
scrubbing cannot be expressed in rules at all.

---

## CRITICAL

### C1. `onReputationLogDeleted` contains another function's `catch` block

Its error handler reads `logger.error('Error rejecting character:', ...)` and
throws `HttpsError('internal', 'Failed to reject character')`. This is the tail of
a `rejectCharacter` callable that was spliced in by a bad merge. It is
syntactically valid, so it deploys.

- `HttpsError` is meaningless in a background trigger — it becomes an unhandled
  rejection instead of a logged, recoverable failure.
- `rejectCharacter` / `approveCharacter` were probably **lost entirely**. Check:
  `git log -p --all -S 'rejectCharacter' -- functions/index.js`
  If they existed, restore them; if the character moderation UI calls them, it is
  currently broken.

Fix: replace the catch with `logger.error(\`Error reverting reputation log ${snap.id}:\`, error);`
and no rethrow.

### C2. Reputation is reverted twice when a post is deleted

`onPostDeleted` decrements the author's reputation by `totalVal` **and** deletes
the `reputation_logs`. Each deletion fires `onReputationLogDeleted`, which
decrements the same amount again. Additionally `onReputationLogDeleted` calls
`batch.update(postRef, ...)` on the already-deleted post — `update` on a missing
document aborts the entire batch with `NOT_FOUND`, so the second revert sometimes
lands and sometimes does not. Net effect: non-deterministic reputation drift.

Fix — one owner, the log trigger:

1. In `onPostDeleted`, delete the logs but **do not** touch reputation:
   ```javascript
   const logsSnap = await db.collection("reputation_logs").where("post_id", "==", event.params.postId).get();
   logsSnap.forEach(l => batch.delete(l.ref));
   ```
2. In `onReputationLogDeleted`, probe existence before queueing updates (see C3).
3. In `onPostDeleted`, skip the metadata sync when the topic is already gone —
   otherwise every cascade-deleted post logs a `NOT_FOUND`:
   ```javascript
   if (topicSnap.exists) { await syncTopicMetadata(db, topic_id); }
   ```

Verification: create a post, vote on it, delete the post, confirm the author's
`reputation` returns to exactly its pre-vote value.

### C3. Unguarded `batch.update()` on possibly-deleted documents

`batch.update()` on a missing document fails the **whole commit**, silently losing
every other counter in that batch. Affected: `onReputationLogCreated` (deleted
target user), `onReputationLogDeleted` (deleted post/user), `onTopicCreated` /
`onTopicDeleted` (deleted author; also `.doc(undefined)` throws synchronously when
a legacy topic has no `category_id`), `onPostCreated`, `onPostDeleted`.

Add one helper and route all counter updates through it:

```javascript
/**
 * Queues an increment onto a batch only if the target document still exists.
 * batch.update() on a missing document fails the entire commit, which is how
 * counter updates were silently lost when an author or post had been deleted.
 */
async function queueIncrement(batch, ref, field, delta) {
    const snap = await ref.get();
    if (!snap.exists) return false;
    batch.update(ref, { [field]: admin.firestore.FieldValue.increment(delta) });
    return true;
}
```

Also guard every `db.collection("categories").doc(category_id)` against
`category_id` being undefined.

### C4. `getSecuredPosts` uses a different permission model and leaks

Every other callable resolves `view_forum` from `categories.permissions.view_forum`
(a list of role ids). `getSecuredPosts` alone reads
`rolesMap[effectiveRole].category_overrides[catId]` — a field that exists nowhere
in the schema or the rest of the code. Consequences:

```javascript
const globalPerms = (rolesMap[effectiveRole]?.permissions || []);
if (globalPerms.includes('view_forum')) return true;   // <-- for ANY category
```

- Any role with global `view_forum` (i.e. a normal `player`) can read posts from
  **every restricted category** — the category's own `permissions.view_forum` list
  is ignored.
- Conversely, a role without global `view_forum` is denied even where the
  category explicitly grants it.
- `base_role_id` inheritance is not honoured here, unlike everywhere else.

The root cause is duplication: this logic is copy-pasted five times in three
variants (`getSecuredCategories`, `getSecuredTopics`, `getUserPosts` — with the
pending→spectator downgrade; `getReputationLogs` — **without** the downgrade;
`getSecuredPosts` — its own model).

Fix: create `functions/permissions.js` as the single implementation and have all
five callables use it. Required exports:

- `loadContext(db)` — loads `roles`, `categories` and `settings/global` once and
  caches them in module scope with a ~60s TTL (these are tiny and change rarely,
  yet were re-read on every invocation).
- `effectiveRole(roleId, settings)` — mirrors AuthProvider: `pending` becomes
  `spectator` while `settings.whitelistMode` is falsy.
- `hasViewForum(rawRole, categoryId, ctx)` — `root`/`admin` always true; category
  override wins over the role's global permission list; `base_role_id`
  inheritance honoured in **both** branches; a missing category denies.
- `getRequester(db, uid)` — one user read, returns `{ uid, role, data }` so
  callers can also reuse `post_count`.

**Behaviour changes to expect after unification** (both are corrections, but they
are visible): `getReputationLogs` will start applying the pending→spectator
downgrade, and `getSecuredPosts` will start denying topics whose `category_id` is
missing (it previously treated uncategorized as public). Confirm the second one
is acceptable, or decide explicitly to allow it.

Verification: as a `player` whose role has global `view_forum`, call
`getSecuredPosts` for a topic in a category whose `permissions.view_forum` lists
only `admin`. Must throw `permission-denied`.

### C5. `onUserCreated`: user managers are never notified

```javascript
const USER_MGMT_PERMS = ["APPROVE_USERS", "BAN_USERS", "DELETE_USERS"];
```

Permission ids are lower snake_case everywhere else (`view_forum`,
`moderate_content`, `view_master_dice`, `bypass_hide_tags`). These UPPERCASE names
match nothing, so `eligibleRoleIds` is empty and only `role_id === 'root'` ever
receives a registration notification.

Fix: lowercase the list and compare case-insensitively
(`(doc.data().permissions || []).map(p => String(p).toLowerCase())`).
Also replace `.slice(0, 30)` with a chunked loop — `in` accepts at most 30 values
and the slice silently dropped every role past the 30th.

**Verify first** against `src/constants/permissions.js`: if the frontend really
does emit `APPROVE_USERS`, then the role documents in the database are the side
that diverges and the fix belongs there instead.

Verification: register a test user, confirm every admin/moderator with a
user-management permission receives a `new_registration` notification.

### C6. `getSecuredTopics` drops topics between pages

Pinned topics are fetched by a separate query, but the main query does **not**
exclude them — they are filtered out in memory *after*
`.offset(startIndex).limit(pageSize + 5)`. `offset` counts the pinned documents,
so each pinned topic inside the window pushes one regular topic out of the result
set entirely; it appears on no page at all. The `+5` buffer is a lottery, not a fix.

Fix: exclude pinned in the query — `.where("is_pinned", "==", false)` — drop the
`+5` buffer and the in-memory filter, fetch pinned only on page 1, and return
`totalCount` via `.count()` so the client can paginate.

This requires `is_pinned` to be present on **every** topic: Firestore skips
documents where the field is absent. Write a one-time backfill setting
`is_pinned: false` on all topics where it is `undefined` (batches of 400), and run
it **before** deploying the query change.

Also extract the repeated Timestamp→ISO conversion into a `serializeTopic(doc)`
helper — it is duplicated in four functions.

### C7. Deleting a topic orphans its posts

`onTopicDeleted` adjusts counters and cleans notifications but never deletes the
topic's posts. They remain in `posts` with a dangling `topic_id`; `getUserPosts`
filters them out, but `locatePost` and `getPostVoters` still serve them, and
their `reputation_logs` survive so that reputation is never reverted.

Worse, `categories.posts_count` correctness currently depends on **deletion
order**: `onPostDeleted` only touches category counters `if (topicSnap.exists)`,
while `onTopicDeleted` subtracts `-posts_count` in one go. If the client deletes
posts before the topic, the category is decremented twice.

Fix: cascade-delete posts inside `onTopicDeleted` (chunks of 400) so the order is
guaranteed, and stop deleting posts from the client.

Cost caveat: a 1000-post topic produces 1000 `onPostDeleted` invocations, each
with its own queries, against `maxInstances: 10`. If such topics are realistic,
handle the per-post side effects inline in `onTopicDeleted` instead and add an
early-exit flag to `onPostDeleted`.

---

## IMPORTANT

### I1. Triggers are not idempotent; Firestore v2 delivery is at-least-once

A redelivered `onReputationLogCreated` event grants reputation twice. Claim the
log in a transaction before applying (an `update` does not re-fire
`onDocumentCreated`, so there is no loop):

```javascript
const logRef = db.collection("reputation_logs").doc(snap.id);
const claimed = await db.runTransaction(async (tx) => {
    const cur = await tx.get(logRef);
    if (!cur.exists || cur.data().applied === true) return false;
    tx.update(logRef, { applied: true });
    return true;
});
if (!claimed) return;
```

For `post_count` / `posts_count` idempotency is not worth the cost — add a
scheduled reconciliation job that recounts with `count()` and repairs drift.

### I2. `getReputationLogs` seek reads every newer document

The `seekLogId` branch fetches all documents newer than the cursor just to count
them. Replace `.select().get()` + `.size` with `.count().get()` +
`.data().count` — `count()` bills 1/1000 of a read per document. Note `select()`
was saving bandwidth only; the reads were billed in full.

Also delete the comment claiming the query avoids a composite index — it does not:
`where('target_id') + orderBy('created_at')` requires one, and the main query
below needs the same index anyway.

Same pattern in `getPostVoters`: it fetches **all** logs for a post to compute
`total` and sorts in memory. Split into `count()` plus an ordered `limit(maxLimit)`
query (needs a `post_id ASC, created_at DESC` composite index).

### I3. Client-controlled `created_at` poisons `last_post_at` and pagination

`onPostCreated` uses `created_at || serverTimestamp()` and writes it into
`topics.last_post_at` and `categories.last_post_at`. A client can write
`created_at` far in the future: the topic sticks to the top of every listing
permanently, and `locatePost` / `locateUnreadPost` (which count by `created_at`)
return wrong pages.

Fix in the rules, on `create` for both `posts` and `topics`:
`&& request.resource.data.created_at == request.time` (requires
`serverTimestamp()` client-side, which is already in use).

### I4. Post limit is enforced twice, inconsistently

`onPostCreated` reads `settings.maxPostsPerTopic ?? 1000` and sets
`is_locked = true` on reaching it, while the rules hardcode `posts_count < 1000`.
Raising the setting has no effect — the rules still block at 1000.

Since the trigger locks the topic, drop the counter check from
`canPostToTopic()` and keep only the `is_locked` gate.

Separately, `shouldLock` is computed from a `posts_count` read **outside** a
transaction and combined with `increment(1)`, so concurrent replies can overshoot
the limit by one or two. Low severity; needs a transaction to fix properly.

### I5. `handlePostNotifications` — sequential transactions, silent failure

One transaction per subscriber inside an `await` loop: 100 subscribers means 100
sequential transactions, each containing a query. Batch them with `Promise.all`
in chunks of ~10.

The transaction query needs this composite index:
`notifications: recipient_uid ASC, type ASC, payload.topic_id ASC, read ASC, archived ASC`.
Without it **every** reply notification fails, and the outer `catch` hides it.
Confirm it exists in `firestore.indexes.json`.

### I6. All callables are open to the internet

`enforceAppCheck: false` plus no auth requirement. `getSecuredCategories` reads
all roles and all categories per call; `getReputationLogs` does the same. An
anonymous script can loop them and burn the read budget — `maxInstances: 10`
caps concurrency, not cost.

The `permissions.js` cache (C4) removes most of the read volume. Then set
`setGlobalOptions({ maxInstances: 10, enforceAppCheck: true })` and remove the
per-function `enforceAppCheck: false` overrides, once the frontend has an App
Check provider configured.

### I7. `offset()` pagination is billed as reads

`getSecuredTopics`, `getUserPosts` and `getReputationLogs` paginate with
`.offset(startIndex)`; Firestore charges a read for every skipped document. Page
50 at pageSize 20 costs 1000 extra reads per request. Acceptable for a forum;
revisit with cursor pagination (`startAfter`) if read costs grow — that changes
the API contract from page numbers to next/previous.

### I8. `onUserDeleted` only cleans up Auth

Posts, topics, reputation logs, subscriptions and DM threads of a deleted user
survive. Fine for rejecting `pending` accounts (no content), wrong for deleting a
real player. Decide whether a cascade is needed.

---

## Rules changes implied by the functions

These supersede any earlier rules advice given without knowledge of the triggers:

1. **Remove the `hasOnly(['reputation'])` branch from `posts.update` entirely.**
   `onReputationLogCreated` / `onReputationLogDeleted` already own that field via
   `increment()`. If the frontend also writes it optimistically, reputation is
   currently double-counted — check the vote code path in `src/api/`.
2. **`notifications.create` can be `if false`.** All fan-out is already
   server-side (`handlePostNotifications`, `onUserCreated`,
   `onReputationLogCreated`). Nothing legitimate writes notifications from the
   client any more.
3. **`topic_subscriptions.read` can be narrowed to own-documents only**
   (`resource.data.user_id == request.auth.uid`) — subscribers are read by
   `handlePostNotifications` through the Admin SDK, which bypasses rules.
4. **Add `post_quoted`** to any notification-type whitelist: it is produced by
   `handlePostNotifications` but missing from the schema doc.
5. **Enforce `created_at == request.time`** on `posts` and `topics` create (I3).
6. **`canPostToTopic`**: drop `posts_count < 1000`, keep `is_locked` (I4).

Independently of the functions, the deployed rules still contain these holes —
confirm each has been fixed:

- `users.create` validates no fields → self-registration can set
  `role_id: 'root'`.
- `users.update` first branch requires only `isSignedIn()` (not "not banned"), and
  `previous_role_id` / `admin_message` are unprotected → a banned user writes
  `previous_role_id: 'root'` and is promoted when the ban is lifted. The protected
  list also names `join_date`, which does not exist; the real field is
  `created_at`.
- `categories.update` uses `hasAny([...counters])`, i.e. "everything except the
  counters is writable" — and `permissions` lives on the category document, so any
  active user *or unauthenticated client* can grant themselves rights.
- `topics.update` uses `hasAny([...])`, which means "touch one of these keys and
  you may change anything else too" — any active user can retitle, pin or unlock
  any topic.
- `topics.create` is `isActive()` only: no category check, no `author_id ==
  request.auth.uid` → impersonation and posting into closed categories.
  `canCreateTopic()` and `canPostToTopic()` are defined but **never called** —
  the whole category permission model is unenforced server-side.
- `posts.create` does not check `author_id`, `is_draft`, or `is_locked`.
- `notifications.update` recipient branch uses `hasAny` → `recipient_uid` and
  `type` are rewritable.
- `audit_logs.create` is `isSignedIn()` with no actor check → forgeable
  (`performer_id` is the field).
- `global_stats.write: if isSignedIn()` → any signed-in user, including banned,
  can overwrite it. The collection is not in the schema; delete the block if
  unused.
- `guest_activity` is fully open including `delete`. Keep read public (it is used
  for the online counter and holds no PII), shape-lock create/update to
  `['guest_id', 'last_seen']` with `last_seen == request.time`, and restrict
  delete to admins.
- `dms.update` lets a participant rewrite `participants` — pin it to the existing
  value so nobody can add a third party or remove the other side.
- `roles.delete` allows removing system roles.
- `reputation_logs.read: if true` makes `getReputationLogs`' privacy filtering
  decorative; `value` is unvalidated (any magnitude) and duplicate votes are only
  prevented by the frontend. Note `getPostVoters` is the legitimate consumer of
  "who voted on this post", so narrowing direct reads to own-documents does not
  break that UI.
- Dead rules block: `match /characters/{charId}` — that root collection does not
  exist (characters live at `users/{uid}/characters`) and the rule references a
  non-existent `owner_id` field.
- `hasCategoryPermission` reads `.permissions` without a guard: a category missing
  that field raises an evaluation error, which denies. Default to `{}`.

---

## Could not verify — check these directly

- Whether the frontend still writes `posts.reputation`, `topics.last_post_*` /
  `posts_count`, or notifications. If any of these are still client-side, the
  corresponding rule tightening will break the app; the trigger is the correct
  owner in all three cases.
- Actual casing of permission ids in `src/constants/permissions.js` versus the
  `roles` documents in Firestore (C5).
- Presence of the required composite indexes: the 5-field notifications index
  (I5), `reputation_logs (target_id, created_at desc)`,
  `reputation_logs (post_id, created_at desc)`,
  `topics (category_id, is_pinned, last_post_at desc)`.
- Whether any `onSnapshot` listeners exist on `posts` / `topics` — this decides
  Option A vs B above.
- Whether `rejectCharacter` / `approveCharacter` were lost in the merge (C1).

## Verification approach

Run the rules against the emulator rather than production:

```bash
firebase emulators:start --only firestore,functions
```

Worth having as `@firebase/rules-unit-testing` cases: registration with a chosen
role, banned user writing `previous_role_id`, posting into a locked topic,
posting with a forged `author_id`, writing `posts.reputation` directly,
a guest rewriting `categories.permissions`, and `getSecuredPosts` against a
restricted category as a plain `player`.