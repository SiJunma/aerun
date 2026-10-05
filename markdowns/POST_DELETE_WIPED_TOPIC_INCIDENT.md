# Incident: deleting a post destroyed the whole topic (2026-09-30)

Status: **client and Go both fixed and verified (2026-10-01).** `gofmt`,
`go build ./...`, `go vet ./...` and `go test ./...` are clean, and the JS gate
(`npm test`) is clean. See "Verification found" for what that verification
actually turned up — it was not a formality.

> **Read this first if you are touching any delete path.** This incident had two
> halves, and the second one is the reason this document exists. Fixing the
> trigger (`abed3e8`) stopped the data loss; fixing the residue (`be6ca82`) is
> what stops the counters, reputation and subscriptions from quietly lying about
> content that no longer exists. The residue half is the one that gets
> re-introduced by well-meaning new code, because every individual piece of it
> looks harmless. The generalised rules are in "Rules for agents" at the end —
> read that section before writing a handler that deletes or hides anything.

## What happened

On production (Firestore era, `aerun-forum`) a topic titled "Нортбейский мыслефлуд #2"
was lost with every post in it. Reported sequence:

1. Opened the topic, saw a post at the end of page 1.
2. Went to page 2, where a single post appeared to be a duplicate of it.
3. Chose to delete that duplicate.
4. The **entire topic** was deleted instead. No backups, no recovery.

The topic had ~21 posts across 2 pages, so page 2 held exactly one post.

Audit trail confirms the mechanism: a `topic_deleted` entry for
`Ida29XJHy3FgLci5e1rS` at `2026-09-30T12:33:19Z` with **no preceding post
deletion**. The client called the topic-delete command directly.

## Root cause (client)

`src/pages/TopicPage.jsx` decided "is this the topic's first post?" with:

```js
const isFirstPost = posts.length > 0 && posts[0].id === deletingPost.id;
```

`posts` holds **one server-side page** (`ITEMS_PER_PAGE`, 20 by default). On page 2+
`posts[0]` is an ordinary reply, not the topic's first post. Deleting it therefore
took the `deleteTopics()` branch instead of `deletePost()`.

The old guard only protected non-moderators, so a moderator (or anyone, when the
topic's `posts_count` was stale) went straight through to the destructive call.

Fixed by `isTopicFirstPost()`, which computes the **absolute** post number:

```js
const absoluteIndex = (pageNumber - 1) * itemsPerPage + pagePosts.findIndex(p => p.id === post.id);
```

Applied at all three sites that used the page-local index: `handleDeletePost`, the
confirm modal (which displayed the wrong warning), and `handleMovePosts` (same
latent bug — it redirected away after moving a page's first post).

The first-post branch also no longer lets a moderator delete a topic that has
replies via the post menu; that now requires the explicit topic action.

## Does the Go backend have this bug?

**The data-loss half: no.** `deletePostHandler`
(`backend/internal/platform/pocketbase/forum_posts.go`) soft-deletes exactly one
post. `deleteTopicHandler` (`forum_topics.go`) soft-deletes a topic and, by design,
**leaves its posts alone** (the comment at forum_topics.go:412 states posts_count is
deliberately untouched). The two are separate routes, and nothing cascades.

So on this branch the destructive behaviour was purely the client's
`deleteTopics()` call. Deletion is also **soft** here, so even a mistaken topic
delete is recoverable by clearing `deleted` — a meaningful improvement over the
Firestore implementation, whose cascade was irreversible.

**The residue half: YES, and it has now been fixed here.** Soft-deleting instead
of cascading removes the data loss, but it does **not** remove the second half of
the incident. A soft-deleted topic is refused by `canViewTopic`, so its posts are
invisible to every read path — yet three things kept pointing at them:

- **reputation was not paid back.** Votes on the topic's posts kept paying their
  authors while the posts were unreachable. This is exactly the `be6ca82` defect
  ("users kept reputation for posts that no longer exist"), inherited by the Go
  layer precisely because Go had not been written yet when the incident was
  diagnosed.
- **`topic_subscriptions` leaked.** A subscriber kept following a topic the API
  refuses to serve, and the row pinned the topic id in their subscriptions list
  forever — they could not even unsubscribe, because the route requires the topic.
- **`posts.reputation` kept displaying a score** that no longer existed anywhere.

Fixed in `purgeTopicResidue` (`forum_topics.go`), called from
`deleteTopicHandler` inside the tombstone's transaction, with the per-post
equivalent in `deletePostHandler`:

- The topic's votes are summed **per target user** and paid back in one write
  each. The aggregate matters: `be6ca82` had to add it on the Firestore branch
  because the per-post decrement lost its owner when the topic document vanished
  first.
- `sumVotes` (`user_counters.go`) now **excludes votes whose post or topic is
  soft-deleted**, so `RecomputeUserCounters` reproduces the payout instead of
  re-granting the score on the next run. Without this the drift returns by
  itself, which is the failure mode that made `be6ca82`'s manual repairs fragile.
- `topic_subscriptions` rows are **hard**-deleted: unlike a vote they are not
  content, and they are unrecoverable-by-design pointers to a topic nobody can
  open.
- `posts.reputation` is zeroed for the topic.

**Deliberate difference from Firestore: the vote rows are KEPT.** `be6ca82`
deleted `reputation_logs` with the topic. That is not portable here, because
deleting a topic on this branch is a soft delete whose entire value is that a
mistake can be undone — hard-deleting the votes would make reputation the one
thing a restore could not bring back. Hiding is expressed by the `deleted` flag on
the topic, and the derivation (`sumVotes`) honours it. `be6ca82` needed a
separate `reputation_reverts/{logId}` claim document to stop a redelivered
trigger paying twice; that has no analogue here, because the payout and the
tombstone share one transaction and the command refuses to run against an
already-deleted row.

## What was changed on this branch

- `src/pages/TopicPage.jsx` — `isTopicFirstPost()` + the three call sites.
- `backend/.../forum_posts.go` — `deletePostHandler` now refuses
  `sequence <= 1` with `409 conflict`. Defence in depth: the first post *is* the
  topic, so removing it must go through `DELETE /topics/{id}`.
  `posts.sequence` is `Required` and 1-based; `0` is reserved for drafts, which are
  removed through the draft commands.
- `backend/.../forum_commands_test.go` — `TestDeletePostRefusesFirstPost` covers the
  moderator path, the author path, that the topic survives, and that a reply is
  still deletable (so the guard is not over-broad).
- `scripts/check-first-post-guard.mjs` — the client-side regression test, ported
  from the production fix. Passes here.

### The residue fix (ported from main `be6ca82`)

- `backend/.../forum_topics.go` — new `purgeTopicResidue`, called by
  `deleteTopicHandler` inside the tombstone's transaction: pays back the topic's
  reputation **aggregated per target user**, zeroes `posts.reputation`, and
  hard-deletes `topic_subscriptions` rows.
- `backend/.../forum_posts.go` — `deletePostHandler` pays back the deleted post's
  own votes and zeroes its `reputation`.
- `backend/.../user_counters.go` — `adjustUserReputation` adds the reputation
  variant of the counter helper **without the zero clamp** (a negative score is a
  legitimate sum of negative votes, and clamping would make the command layer
  disagree with the recompute); `sumVotes` now ignores votes on soft-deleted
  posts/topics so the repair tool reproduces the payout.
- `backend/.../topic_delete_residue_test.go` — four regression tests:
  `TestDeleteTopicRevertsReputationAndCleansResidue` (payout + subscriptions +
  no cascade + recompute agreement), `TestDeletePostRevertsReputation`,
  `TestDeleteTopicPaysBackReputationExactlyOnce` (replayed with a *different*
  idempotency key, proving the tombstone is the claim and not the key), and
  `TestRecomputeAgreesWithTopicPayout` (the repair tool must not re-grant).

## What still needs doing

Verified on 2026-10-01 (`gofmt`, `go build ./...`, `go vet ./...`, `go test ./...`
all clean; the four residue tests and the first-post guard pass).

- [x] ~~**Run the Go tests.**~~ Done, and it found real bugs — see
      "Verification found" below. The code had never been compiled: `forum_topics.go`
      did not build (`Execute()` returns two values) and one existing test was
      asserting against made-up post ids.
- [ ] Confirm the 409 does not break the draft flow: `drafts.go` sets
      `sequence: 0`, and `publishDraft` assigns a real sequence. A draft must never
      reach `deletePostHandler`, but the interaction is unproven.
- [ ] Confirm no other caller relied on deleting a first post through
      `DELETE /posts/{id}` (e.g. an admin "delete topic" shortcut).
- [ ] Decide whether `posts_count` should also drop when a topic is hidden. It
      currently does **not**, and that is deliberate (migration `1767100000`:
      the rows still exist and an un-delete brings them back), but it means a
      member's post count includes posts in a hidden topic. Reputation is paid
      back immediately, so the two counters now answer different questions. Worth
      a product decision before cutover; do not "fix" it casually.
- [x] ~~`movePostsHandler` did not move `reputation_votes.topic_id` with the post.~~
      Fixed, and now covered by `TestMovePostCarriesItsVotes`, which passes.

## Verification found (2026-10-01)

The first `go test ./...` on this branch was not a formality — it found three
defects that had been sitting in an uncompiled package:

1. **`forum_topics.go` did not compile.** `purgeTopicResidue` bound a single
   variable to `.Execute()`, which returns `(sql.Result, error)`. The whole
   package — and therefore every test in it — could not build. This is what CI
   run 24 was reporting with an empty `checks` map: every step died at
   `go build`, so no check ever got to record itself.

2. **`TestRecomputeUserCountersSumsEveryVote` was asserting a fiction.** Its
   fixture voted on `postmissing001`…`postmissing003` — post ids that exist in no
   table. That was harmless while `sumVotes` counted every vote row, but rule 5
   made `sumVotes` resolve visibility through the post row (`post_id IN (SELECT
   id FROM posts WHERE deleted = false AND topic_id IN (...))`), so the new
   predicate correctly excluded them and the test failed. The rule was right and
   the fixture was stale; the fixture now seeds real posts. Worth recording
   because it is rule 5 biting in the least expected direction: tightening a
   predicate silently invalidates fixtures that only ever *looked* realistic.

3. **A latent `ReferenceError` in `src/api/dm-cache.js`.** Unrelated to this
   incident but found while verifying the merged changes: commit `2591610`
   rewrote `reviveTimestamp` to drop the Firebase `Timestamp` import and deleted
   the declaration block above it in the same hunk, taking `DM_CACHE_PREFIX`,
   `DM_CACHE_BUILD_KEY`, `MAX_CACHED_MESSAGES`, `CURRENT_BUILD` and `getCacheKey`
   with it. Every *use* survived. The module would throw the first time anything
   touched `localStorage` — including `clearAllDmCache()`, which `AuthProvider`
   calls on signOut.

   It stayed invisible for a month because of a single line:
   `/* global __APP_BUILD_TIME__ */` at the top of the file. That comment silenced
   `no-undef` for the build-time constant and made the file read as deliberately
   configured; the other four identifiers were never in it, but nothing reported
   them until `be6ca82` removed the comment (by which point `eslint.config.js`
   declared `__APP_BUILD_TIME__` globally, making it redundant). The lint errors
   that finally surfaced them were a symptom of a real outage, not lint noise.

   This is the client-side twin of the rules below: a stale copy of a definition
   is indistinguishable from a live one until something dereferences it. Fixed by
   restoring the constants, and pinned by `scripts/check-dm-cache-constants.mjs`
   (`npm run test:dm-cache-constants`, wired into `npm test`), which *executes*
   the module against a `localStorage` stub rather than reading it — reading the
   file is exactly what failed to catch this.

## The duplicate post was probably a double submit

The duplicate that triggered the deletion is a **separate, still-open** issue. The
most likely cause is a double submit, and the idempotency layer cannot catch it:

- `src/api/pocketbase.js` `sendApi()` calls `generateIdempotencyKey()` **per HTTP
  request** when the caller does not supply one. Two clicks therefore produce two
  *different* keys, and the server correctly treats them as two distinct commands.
- `handleReply` does guard with `if (submitting) return;` and the submit button is
  `disabled={submitting}`, but `submitting` is read from the render closure. React
  batches state updates, so two clicks in the same tick both observe
  `submitting === false`. That window is real, though small.

TODO: make the key **stable per compose attempt** — generate it when the reply box
is armed (or when the draft is loaded) and reuse it across retries, instead of
minting one per request. Only then does `Idempotency-Key` actually dedupe. A cheap
interim belt-and-braces fix is to set `submitting` synchronously via a ref before
the first `await`, so the guard cannot be raced.

## Not fixed: posts_count drift

A stale `posts_count` was a plausible contributor to posts appearing on two pages
at once (the page-2 window is computed from that counter). This was **not**
investigated and is **not** fixed here. Worth a separate look at how
`posts_count` is maintained versus the authoritative post count.

## Rules for agents

Generalised from this incident. Read these before writing or reviewing any
handler that deletes, hides, or moves content.

**1. A delete is not done when the row is flagged. It is done when nothing
denormalized still points at the row.** Before calling a delete "finished", list
every place the deleted thing is *copied* — counters, votes, subscriptions,
caches, audit rows — and decide explicitly for each: moved, paid back, or
deliberately kept. "The rows still exist" is not a decision, it is the default
that produced this incident. See `purgeTopicResidue` for the worked example.

**2. Never write the cleanup in a different transaction than the flag.** The
Firestore version applied the tombstone and the cleanup as separate batches; a
crash between them produced the half-deleted state `be6ca82` had to repair by
hand across 2081 documents. In Go everything goes through `runCommand`, so this
is free — but only if the cleanup is written *inside* that closure. A cleanup
scheduled after the commit reintroduces the whole bug.

**3. Aggregate before you mutate, and never early-return out of the decrement.**
The single most expensive defect here was a per-post loop that returned early
because its parent document was already gone, leaving every per-author decrement
without an owner. Aggregate per author/user/target *first*, then apply one write
per key. If a loop can `return` or `continue`, something in it may never run.

**4. A payout must be exactly-once by construction, not by an extra claim
document.** Do not reach for a "did I already revert this?" marker — that is
`be6ca82`'s `reputation_reverts/{logId}`, needed only because Cloud Functions
redeliver. Prefer making the state itself the proof: derive the payout from rows
that the same transaction removes or hides, so a second pass finds nothing to
pay. Test it by replaying the command with a **different** idempotency key; a
guard that only holds under the same key is not a guard.

**5. Keep the recompute tool and the command layer in agreement — and assert it.**
Any predicate that decides "does this count?" exists in two places: the
incremental command and `RecomputeUserCounters`. They drift silently, and the
recompute is what silently *undoes* your fix on the next run. Whenever you change
one, check the other, and pin the agreement with a test that runs the recompute
after the command. `TestRecomputeAgreesWithTopicPayout` exists for exactly this.

**6. Soft delete means reversible; do not hard-delete the recoverable parts.**
Delete is soft here precisely so a mistake can be undone (unlike the Firestore
cascade). Express "this no longer counts" through the `deleted` flag and the
derivation that honours it, not by destroying rows. Hard-delete only what is not
content and not recoverable — a subscription pointer is; a vote is not.

**7. Do not clamp a value the domain allows to be negative.** The counter helper
clamps at zero because a negative post count is meaningless; `adjustUserReputation`
deliberately does not, because a negative score is a legitimate sum of negative
votes. A clamp that the recompute does not also apply is a permanent
disagreement — see rule 5.

**8. Move the copies when you move the thing.** `movePostsHandler` re-sequenced
the post and left `reputation_votes.topic_id` pointing at the old topic, which
would have made the new cleanup pay out against the wrong topic. When a row
carries a denormalised reference, grep for every writer of that field before
concluding the reference is maintained.
