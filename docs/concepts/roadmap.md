# The roadmap

What gets built, in what order, and which parts of that order are forced rather than chosen.

The principle is [ADR 0054](../adr/0054-build-the-spine-first.md). Every decision referenced here
is indexed in [`docs/decisions-index.md`](../decisions-index.md).

---

## Forced versus chosen

Most of this order is not a preference. Reading it as "what would be nice" misses that most of it
follows from decisions already made.

**Forced by the schema:**

- Ordering before fan-out — the outbox row carries `seq`, so [0005](../adr/0005-message-ordering.md)
  must land before the relay exists.
- Receipts before the chat view — the view *renders* "Seen", so [0003](../adr/0003-receipt-watermark.md)
  and [0010](../adr/0010-receipt-mechanics.md) precede any UI that displays a transcript.
- Conversations before the conversation list — the list orders by `last_seq`, which is
  [0007](../adr/0007-conversation-model.md).
- Identity before anything with a `user` in it — [0016](../adr/0016-identity-is-one-table.md) makes
  `user` our table and everything else an FK to it.

**Chosen, and the only genuinely contestable orderings:**

- **Spine before surface** ([0054](../adr/0054-build-the-spine-first.md)) — argued above.
- **Media and push after a thin interface.** Neither is load-bearing for anything else; both could
  move earlier. They are last among features because they are the most security-sensitive and the
  least structurally risky, which is a reasonable place to first write code against someone else's
  rules.
- **Search near the end.** Nothing depends on it, and it is the easiest of the three to swap later
  because [0009](../adr/0009-message-search.md) put the whole surface behind one function.

---

## The stages

### 1 — Groundwork
Bun workspaces; `apps/web`, `apps/realtime`, `packages/protocol`, `packages/database`. Neon
provisioned. Drizzle with Postgres.js — the driver choice holds until Bun's native driver survives a
`bigint` load test.

Schema: `user`, `handle_reservation`, `conversation`, `member`, `message` (with global `seq`),
`outbox`, `receipt`, `delivery`, `media`, `push_subscription`.

`packages/protocol` carries Zod schemas for every wire frame and REST payload, from day one, so a
native client is additive rather than a rewrite.

> **Note:** Tailwind v4 emits zero CSS for workspace library code until `@source` globs are written
> by hand. Budget that at the start of stage 9, not the end.

### 2 — Identity
Self-hosted Better Auth per [0001](../adr/0001-self-hosted-better-auth.md). `immutableUsername` with
handle reservation enforced by **Postgres triggers** ([0016](../adr/0016-identity-is-one-table.md)) —
because normalisation happens inside the plugin, so a Drizzle write that bypasses it never
normalises, and only `CREATE UNIQUE INDEX ON "user" (lower(username))` catches that bypass.
Handle alphabet `^[a-z0-9_]{3,20}$` ([0017](../adr/0017-handle-alphabet.md)). Sessions at 30 days with
`freshAge: 5m` and `cookieCache` **off** ([0018](../adr/0018-socket-is-a-lease.md)).

### 3 — The durable spine — the stage that must be right
Four things in here are worth building first and testing hardest:

| | |
|---|---|
| **Ordering** | global `seq`, `pg_advisory_xact_lock` serialising inserts within a conversation ([0005](../adr/0005-message-ordering.md)) |
| **Optimistic send** | Dexie row with `position: null`, `POST`, dedupe on the client UUID, persist-before-acknowledge ([0004](../adr/0004-message-durability.md)) |
| **One receive write path** | live frame, catch-up page, and own-message echo all through one function |
| **Reconciliation** | `COUNT(*)` per conversation after catch-up — the independent net under the advisory lock |

Then the outbox relay, keyset pagination in both directions, and the reconnect cursor.

### 4 — Reading and liveness
`delivery` and `receipt` as monotonic watermarks, with `read_through` and `shared_through` on the
receipt ([0010](../adr/0010-receipt-mechanics.md)). "Seen" derived, never stored. Presence as a Redis
TTL refreshed from **connection liveness**, never a JS timer ([0006](../adr/0006-presence.md)). Typing
throttled to 2s, expiring on a client timer, never persisted.

### 5 — Conversations
`direct_key` with `ON CONFLICT DO NOTHING` — the race disappears because it is a constraint
([0007](../adr/0007-conversation-model.md)). Blocks enforced by **one application function** called from
both the send path and the UI; Postgres RLS rejected because it cannot also drive the interface.
Membership retained with `left_at`; a rejoining member inherits their receipt.

### 6 — A thin interface
The token layer ([0002](../adr/0002-messenger-token-layer.md)), then the transcript, conversation list,
composer and settings. Deliberately thin: **no media, no push, no search.**

The burst state machine is inherited, not re-derived — "fused" at 4px, `middle` and `last` identical,
a date divider terminating a run, CSS logical longhands. Rendering comes from the Dexie table via
`liveQuery`, never component state.

### 7 — Media, push, search
Media ([0008](../adr/0008-media-pipeline.md)): R2 presign, worker with a server-side sniff and an
allowlist, three derived variants, **the raw upload never served**. Push
([0011](../adr/0011-push-notifications.md)): triggered by the outbox, with a two-path suppression
check — presence, then `delivered_through >= seq`. Search ([0009](../adr/0009-message-search.md)):
`'simple'` configuration, generated `tsvector`, GIN, trigrams guarded at 3 characters.

### 8 — Hardening, Gate 1
[27 items, two gates](../concepts/hardening-backlog.md). Gate 1 is "before a second user exists" and
is ~10–11 days — of which **four are one item**: perform a backup restore, time it, and record what
was missing. A database restore contains rows and no bytes; discovering that at one user is free.

---

## What this deliberately does not build

Tier 2 is beyond the destination and stays beyond it: replies, reactions, edit, delete, forwarding,
pinning, mentions, voice notes, link unfurls. Tier 3 — calls, threads, stories, payments, bots,
marketplace, contacts sync — is out of scope entirely.

The Tier 2 items are not merely deferred; ADR [0005](../adr/0005-message-ordering.md),
[0008](../adr/0008-media-pipeline.md) and [0053](../adr/0053-nothing-is-retracted.md) each record the
constraint that would apply if one arrives, because each is cheaper to honour now than to migrate
later.

**Precise last-seen** is out by decision, not by omission
([0006](../adr/0006-presence.md)): no Centrifugo primitive beats a 60-second TTL, so a precise last-seen
would be a fiction we build ourselves, on top of a GDPR Art. 4(1) retention question, for a feature
outside the core messenger.

---

## The two questions this roadmap deliberately leaves open

**Does vartalap ever need end-to-end encryption?** Not v1. The schema should not foreclose it, and
the hardening work priced the cost: a stored generated `tsvector` **cannot be built from
ciphertext**, so full-text search and E2EE are in direct conflict, and choosing E2EE means losing
message search. That is a real price, not a formality, and it should be paid knowingly rather than
discovered later.

**Do handles ever become renewable?** Cheap in either direction. It is a product call, and nothing
in the schema prevents it.

---

## The stage that is not in this roadmap

A working chat app with media, push and search, deployed for one person. It arrives at the end of
stage 7, with Gate 1 closing behind it. Everything in stages 1–5 exists to make that trustworthy
rather than merely working — and none of it is visible until stage 6.