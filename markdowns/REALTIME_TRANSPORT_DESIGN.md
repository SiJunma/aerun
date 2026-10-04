# Realtime: transport design

Status: **proposal, not implemented.** Written 2026-10-04 as the inventory and
design that `REALTIME_HYBRID_PLAN.md` asks for in its work item 1. Nothing here
is built; nothing here changes a rule.

## The finding that reframes the plan

`REALTIME_HYBRID_PLAN.md` rests on one sentence:

> `RealtimeRule` is a separate field from `ListRule`, and it is currently unset
> on every collection. Opening it is the prerequisite for everything below.

**In PocketBase v0.40.4 that field does not exist.** Verified three ways:

- `core.Collection` declares `ListRule`, `ViewRule`, `CreateRule`, `UpdateRule`,
  `DeleteRule`, `AuthRule` (`core/collection_model.go:358-362`). A reflection
  lookup for `RealtimeRule` returns `found=false`.
- `grep -r RealtimeRule` across the whole module: **zero** hits.
- `apis/realtime.go:605-614` is the actual authorization, and it reads:

```go
subscriptionRuleMap := map[string]*string{
    (collection.Name + "/" + record.Id + "?"): collection.ViewRule,
    (collection.Id + "/" + record.Id + "?"):   collection.ViewRule,
    (collection.Name + "/*?"):                 collection.ListRule,
    (collection.Id + "/*?"):                   collection.ListRule,
    (collection.Name + "?"):                   collection.ListRule,
    (collection.Id + "?"):                     collection.ListRule,
}
```

So realtime is gated by **the same `ListRule` / `ViewRule` that REST uses**. A
`topic/<id>` subscription is authorized by `topics.ViewRule`; `topics/*` by
`topics.ListRule`.

### What this means for the plan

Every "shape 1 / shape 2" option in the plan that scopes a per-collection
realtime rule is **not expressible in this version**. And the consequence is
sharp:

> On this PocketBase, enabling realtime for a collection's content IS enabling
> REST reads on that collection's content. There is no second, narrower door.

That is the whole authorization problem in one sentence. It is why the plan's
"principle: a realtime subscription may never be broader than the REST read the
same user would get" is not a design choice — it is a law of this engine. The
## Why the stream is dead today, confirmed

Not a hypothesis. All 24 collections are locked, and the lock is what silences
realtime:

| collection | type | listRule | viewRule |
|---|---|---|---|
| `users` | auth | nil | nil |
| `categories`, `topics`, `posts` | base | nil | nil |
| `dm_conversations`, `dm_members`, `dm_messages` | base | nil | nil |
| `notifications`, `outbox_events` | base | nil | nil |
| `reputation_votes`, `topic_subscriptions`, `topic_read_states` | base | nil | nil |
| `characters`, `designs`, `category_groups`, `forum_settings` | base | nil | nil |
| `guest_presence`, `audit_logs`, `idempotency_keys`, `roles`, `_superusers` | base/auth | nil | nil |

`lockBrowserRules` sets `ListRule`/`ViewRule` to nil. Then, per
`core/record_query.go`:

```go
func (app *BaseApp) CanAccessRecord(record *Record, requestInfo *RequestInfo, accessRule *string) (bool, error) {
    if requestInfo.HasSuperuserAuth() { return true, nil }
    if accessRule == nil { return false, nil }
```

nil rule ⇒ false ⇒ `broadcastRecord` filters the client out. The SSE handshake
still completes, so the network tab shows a healthy `PB_CONNECT` and the console
is silent. `realtimeBroadcastRecord` fires on create, update and delete
(`apis/realtime.go:423,443,467`) — the events exist, they are simply never
delivered to anyone. That is precisely the failure mode the plan warns about,
and it is why any test must assert **delivery**, not connection.

Only `_mfas`, `_otps`, `_externalAuths`, `_authOrigins` are `set` — PocketBase's
internal auth tables, which carry no forum data and are why the SDK's own auth
streams still work.

## Resource inventory

Every `subscribeTo*` in `src/api/` currently delegates to `shared-poll`, whose
`realtime` option **throws by design** (`assertNoRealtimeHook`). These are the
resources, and what each one actually needs:

| resource | today | what it needs | sensitivity |
|---|---|---|---|
| `subscribeToUserNotifications` | poll | owner-scoped, own rows only | private |
| `subscribeToDmList` / `subscribeToDmMessages` | poll | owner-scoped | private |
| `subscribeToUnreadCounts` | poll | owner-scoped | private |
| `subscribeToTopic` / `subscribeToPosts` | poll | role-scoped (category visibility) | semi-public |
## Proposed shape: a signal collection, not a content stream

The engine forces the choice: either the browser gets a broad `ListRule` on real
content, or the browser gets a narrow rule on a table that carries no content.
Only the second is safe, so:

**Add one collection, `realtime_signals`, holding only nudges.**

```
topic        text   "topic.post" | "dm.message" | "notification.new" | ...
entity_id    text   the topic / conversation id that changed
audience_id  text   the recipient, or "*" for anything public
at           date   when the signal was written
```

It contains **no titles, no bodies, no nicknames, no counters**. A row says only
"something in topic X changed". The list of topics a member may read is *not*
encoded in it and does not need to be — the client cannot read topic X anyway;
it uses the signal to know to re-read X **through `/api/aerun`**, which applies
the real authorization.

### Why this cannot leak

- The event carries an id and a topic name. Not forum data.
- A member who is not entitled to topic X learns only that *something* happened
  somewhere. The `/api/aerun` re-read that follows returns 403/404 exactly as
  it does today.
- Authorization stays in **one** place — the command layer — which is the
  property `lockBrowserRules` exists to protect. `.agents/AGENTS.md` calls
  duplicated authorization the cause of the delete-incident class of bug; this
  design has no second copy.

### The rule

```
ListRule = "@request.auth.id != '' && (audience_id = @request.auth.id || audience_id = '*')"
ViewRule = same
```

Two things worth stating plainly:

- **This rule is safe here and only here** — on a table whose rows contain no
  forum data. The identical rule pasted onto `dm_messages` would be a disaster,
  because there the row *is* the message. The rule is not the security boundary;
  the absence of content is.
- Guests get `''` for `auth.id`, so they receive no signals. A guest watching a
  public topic gets no push, and the poll keeps the page correct. That is a
  deliberate trade: guest realtime is not worth re-opening anonymous access.

### Who writes a signal

The command layer, at the end of the mutation handlers that already exist:
post create, post delete, DM send, notification create. One helper
(`publishSignal`) so there is a single call site shape. Write failures are
logged and swallowed — a missed nudge degrades to "the poll picks it up", and
must never fail the user's post.

Retention: prune signals older than ~1 hour on the existing prune job. They are
purely transient.

## Transport layer

`shared-poll` already has coalescing (250 ms), subscriber counting, visibility
handling and last-good-value retention. It needs three changes:

1. **Stop refusing realtime.** Replace `assertNoRealtimeHook` with a real hook
   that subscribes to `realtime_signals/*` and calls `requestRefresh()`,
   filtering by the topics this poll cares about.
2. **Track the live transport.** New state: `transport ∈ {realtime, polling,
   dead}`, exposed to subscribers and to the connection banner.
3. **Hybrid switch, per the plan:** realtime healthy ⇒ no interval at all; not
   established within a 10 s grace ⇒ interval starts; dropped after healthy ⇒
   interval resumes and closes again on recovery. The transition must be
   *observable*, or a dead stream runs at interval speed forever while looking
   configured — which is the ambiguity that let the dead channel ship in the
   first place.

Unsubscribe rules from the plan stand unchanged and are load-bearing: idempotent,
safe before the promise settles (React StrictMode double-mount), run when the
last subscriber leaves, and no unbounded reconnect loop.

## Testing

The rule from the plan: **assert delivery, not connection.** Concretely, for each
resource:

- subscribe as member A over the real SSE client;
- write through the command layer as member B;
- assert the **event arrives** within a timeout.

A connection-only assertion passes today against a stream that is connected and
permanently empty — that test would be green on a build with no realtime at all,
which is exactly the trap. Plus:

- a **negative** delivery test: member A subscribed, B posts in a category A
  cannot read → A receives **no** event, and A's re-read returns 404;
- a gate that fails if `realtime_signals` is ever given a text field that could
  hold forum content — the invariant is "no content", and a gate is how it stays
  true.

## Rollout

1. Migration adding `realtime_signals` + its rule. No other rule changes;
   `lockBrowserRules` stays intact for REST.
2. `publishSignal` helper + calls on post create / DM send / notification create.
3. `shared-poll`: hook, transport state, hybrid switch, banner.
4. Delivery tests, then flip on **notifications** first — owner-scoped, lowest
   blast radius.
5. Then DMs, then topic posts.

## What I want agreed before building

- The plan's `RealtimeRule` premise is wrong and should be corrected in
  `REALTIME_HYBRID_PLAN.md`. Everything above is built for the engine as it is.
- Signalling carries **no content**; the browser re-reads through `/api/aerun`.
  If anyone prefers true push of row data, that requires opening `ListRule` on
  real collections — I would not recommend it, and I would want that argued
  explicitly rather than assumed.
- Guests get no realtime. Polling keeps them correct.
- Presence and the members board stay polled, permanently.
| `subscribeToTopics` / `subscribeToLastTopicInCategory` | poll | role-scoped | semi-public |
| `subscribeToUser` (profile) | one-shot read | nothing — already a DTO | public |
| `subscribeToAllUsers` (members board) | poll | **keep polling** — a directory | public |
| `subscribeToCharacters`, `subscribeToDesigns`, `subscribeToRoles`, `subscribeToCategories` | poll | rarely change; low value | public |
| `subscribeToReadMap` | local cache | stays local | private |
| presence (`/status` + heartbeat) | poll | **keep polling** — see below | public |

Two of these are not realtime candidates at all:

- **Presence.** It is an in-process `map[string]userPresence` with a 75 s TTL
  (`presence.go:53-54`), not a collection. There is no record to broadcast. The
  heartbeat + `/status` poll is the correct design, and the plan already says so
  for aggregates.
- **The members board.** A live-updating directory of every account. Realtime
  would stream every row to every visitor. Poll it.
only way to honour it is to not put forum content behind a realtime subscription
at all.

`REALTIME_HYBRID_PLAN.md` should have its premise corrected before anyone builds
against it. Everything below is built to work with the engine as it actually is.