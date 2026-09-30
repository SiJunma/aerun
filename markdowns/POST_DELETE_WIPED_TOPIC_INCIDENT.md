# Incident: deleting a post destroyed the whole topic (2026-09-30)

Status: **client fixed on this branch; Go guard added but UNVERIFIED (no toolchain on
the machine where it was written).** See "What still needs doing".

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

**No — there is no data-loss path in Go.** `deletePostHandler`
(`backend/internal/platform/pocketbase/forum_posts.go`) soft-deletes exactly one
post. `deleteTopicHandler` (`forum_topics.go`) soft-deletes a topic and, by design,
**leaves its posts alone** (the comment at forum_topics.go:412 states posts_count is
deliberately untouched). The two are separate routes, and nothing cascades.

So on this branch the destructive behaviour was purely the client's
`deleteTopics()` call. Deletion is also **soft** here, so even a mistaken topic
delete is recoverable by clearing `deleted` — a meaningful improvement over the
Firestore implementation, whose cascade was irreversible.

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

## What still needs doing

- [ ] **Run the Go tests.** `go` is not installed on the machine where the guard
      was written, so `forum_posts.go` and the new test are **unverified** — not
      even compiled. Run `go build ./... && go test ./...` on the main machine.
- [ ] Confirm the 409 does not break the draft flow: `drafts.go` sets
      `sequence: 0`, and `publishDraft` assigns a real sequence. A draft must never
      reach `deletePostHandler`, but the interaction is unproven.
- [ ] Confirm no other caller relied on deleting a first post through
      `DELETE /posts/{id}` (e.g. an admin "delete topic" shortcut).

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
