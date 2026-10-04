# Realtime: hybrid transport plan

Status: **plan only, not started.** Written 2026-10-03 before implementation, so
the reasoning survives the session.

## Why this document exists

An earlier pass concluded "realtime cannot work here, keep polling" and deleted
the subscription hooks. That conclusion was factually right about the *rules*
and wrong about the *decision*. Realtime is the reason this stack is Go +
PocketBase rather than a cron job: for a TRPG forum, a reply appearing
instantly in an open topic, an online-status flip, and a DM arriving while you
are reading something else are the product. Dropping that to simplify a test
trades the feature the stack was chosen for against a convenience.

So: realtime comes back, as the **primary** transport, with polling demoted to
the fallback it should always have been.

## The actual blocker

`lockBrowserRules` (migration `1766100000`, plus `1766400000` for DM and
notifications) sets `ListRule`/`ViewRule` to `nil` on every collection the
forum reads. PocketBase v0.40 resolves a wildcard realtime subscription through
that same `ListRule` (`core/record_query.go`: `if accessRule == nil { return
false }`), so:

- the SSE handshake **succeeds** — the network tab shows `PB_CONNECT`;
- the server then delivers **zero** events;
- nothing anywhere reports an error.

That is the whole failure. It looks exactly like a healthy idle stream, which is
why it survived review: there is no red state to notice. Any test asserting
"realtime works" must assert on *delivery*, not on connection, or it will pass
against a dead channel.

`RealtimeRule` is a separate field from `ListRule`, and it is currently unset
on every collection. Opening it is the prerequisite for everything below.

## Principle: authorization is the whole design

The collections are locked *deliberately* — the `/api/aerun` command layer owns
all reads and writes precisely because Sprint 4 visibility rules are not
finished. A `RealtimeRule` any broader than the command layer would re-open the
hole `lockBrowserRules` closes, through a channel nobody audits.

So the rule is: **a realtime subscription may never be broader than the REST
read the same user would get.** A wildcard `*` subscription is not acceptable
for any collection whose rows are role-scoped (`topics`, `posts`, `categories`),
because it cannot express "categories this member may read".

Three candidate shapes, in order of preference:

1. **Subscribe per visible id.** The client already knows which categories it may
   read (the server filtered `/forum-index` for exactly this member), so it
   subscribes to `topic/<id>` for those and nothing else. Narrow by
   construction; revoking access closes the stream on the next subscribe cycle.
2. **Scoped `RealtimeRule` per collection** (`@request.auth.id = user_id`, or a
   join against the member's categories). Fewer connections, but the rule
   becomes a second, parallel copy of the visibility logic — and per
   `.agents/AGENTS.md`, duplicated authorization is how the delete-incident
   class of bug happens.
3. **A server-side broadcast channel** the command layer writes to on mutation.
   One topic carrying only ids; the client re-reads through `/api/aerun` and the
   command layer applies the real filtering. This is the right shape for
   anything role-scoped, because it cannot leak: the event carries no forum
   data, only a nudge, and authorization stays in one place.

Shape 3 is likely correct for `topics`/`posts`; shape 1 or a plain wildcard is
fine for `dm_messages`/`notifications` (already owner-scoped by construction).
The exact split is a decision to make with the migration in hand, not from this
document.

## Hybrid contract

The requirement: realtime primary, polling only when realtime is not carrying
the resource. Per resource:

- **Realtime healthy** → no interval at all. An event coalesces (250 ms) into
  one read, same as today.
- **Realtime not established within a grace window** (say 10 s) → the interval
  starts, so the resource still works.
- **Realtime drops after being healthy** → the interval resumes, and closes
  again if realtime re-establishes. The transition must be observable, or a
  permanently dead stream silently runs at interval speed forever while looking
  configured.
- **Both unavailable** → the last good value is kept and the error reported,
  which is what `shared-poll` already does.

`shared-poll` already has this shape. It needs to stop *refusing* a realtime
hook and start *requiring* one to prove delivery, plus one new piece of state:
whether realtime is currently believed to be live.

## Unsubscribe

The failure to avoid: an SSE connection that outlives the component that opened
it. The symptom is a long session that accumulates open connections until the
browser caps them per origin and new subscriptions stop working — which looks
like "realtime randomly stopped", months after the leak.

Rules:

- `subscribe` resolves to an unsubscribe that is **idempotent and safe before
  the promise settles** — the window in which a React effect cleanup runs. The
  removed `bestEffortRealtime` helper existed for this and was right about it.
- The unsubscribe runs on the resource's last subscriber leaving
  (`shared-poll` already tracks subscriber counts, so this is where it belongs).
- Guard against double-unsubscribe: React StrictMode mounts effects twice in
  dev, so an unsubscribe that throws on a second call is a dev-only crash that
  hides real bugs.
- No unbounded reconnect loop. A reconnect storm against a down backend is
  worse than polling.

## Work items, in order

1. **Decide the rule shape per collection**, with the migration read. Nothing
   else is safe to build before this — every other item depends on knowing what
   may be subscribed to.
2. **Migration** setting `RealtimeRule` per the decision, keeping
   `lockBrowserRules` intact for REST. A `RealtimeRule` must never be the
   mechanism that re-opens REST reads.
3. **Go tests that assert *delivery*, not connection**: subscribe as a member,
   write through the command layer, assert the event arrives. A connection-only
   test passes against the dead channel that exists today — that is precisely
   the bug being fixed, so the test must not be written that way.
4. **Client**: reinstate `subscribe` hooks on the resources where the decision
   allows (notifications, DMs first — owner-scoped, lowest risk), with the
   hybrid contract and the unsubscribe rules above.
5. **Observability**: surface which transport is live per resource. Without
   this, "realtime is configured" and "realtime delivers" stay
   indistinguishable — the exact ambiguity that let the dead channel ship.
6. Only then the resource-by-resource rollout, removing the interval per
   resource as it lands.

## Deliberately not in this plan

- Removing polling. It stays, permanently, as the fallback — it is the only
  thing that works when the network drops mid-session, and "graceful fallback"
  was the requirement.
- Realtime for the forum index projections (category counters, forum stats).
  Those are aggregates the command layer recomputes; a subscription per category
  would be many connections to learn a number. Poll them.
