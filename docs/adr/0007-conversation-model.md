# 0007. One `conversations` table, and a NULL that does the uniqueness work

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation model and 1:1 uniqueness"
**Teaches:** [`docs/concepts/conversation-model.md`](../concepts/conversation-model.md)

## Context

The question was whether a direct conversation is the same kind of thing as a group conversation, and
what makes a 1:1 unique.

The second half turns out to have a one-line answer that removes an entire class of bug. The first
half is a schema decision with a bill attached, and the bill is smaller than it looks.

## Decision

### One `conversations` table, with a `kind` discriminator

Not `direct_conversations` and `group_conversations`.

Conversation list, unread badge, last-message preview, drafts, read state, socket subscription, push
notification — every one of these is implemented once against a single shape. Split the table and each
is implemented twice, and then someone ships a feature that works in only one branch.

### A nullable canonical pair key, and one unique index that does both jobs

```sql
direct_key text NULL
UNIQUE (direct_key)
```

`direct_key` is the two member ids **sorted and joined**, so argument order cannot produce two keys.

**Postgres treats NULLs as distinct in a unique index by default**, so this single index yields
*exactly one row per direct pair* and *unlimited group rows* at the same time. No partial index, no
second table, no application-level check.

Race-proof creation is therefore `INSERT … ON CONFLICT DO NOTHING`, then re-select — the classic
read-then-write race with a single round trip and no window.

Format: **two UUIDs sorted, joined by `:`**, as `direct_key text`. A colon is not a hex character and
both halves are fixed-width, so the split is exact and the sort is canonical. A `bytea` would be
marginally more compact and considerably harder to debug — the failure mode of a mangled key is two
conversations for one pair, which is precisely what the mechanism exists to prevent.

A check constraint ties `kind` to the key's presence: `kind = 'direct'` requires a non-null key.

### Group ceiling of 500, with a defined error at the limit

The number is not sacred. What matters is that hitting it is a **clean rejection**, not a partial
fan-out. Receipt writes amplify as members × messages, making the largest group the most expensive
thing in the system — cheap to lower later, expensive to raise.

### A block prevents the blocked party from sending

B blocks A ⟹ **A can no longer send to B**, and B's messages to A are not delivered. One-directional
in intent, but with actual consequences rather than silence.

### The "can this user send" predicate lives in the application, once

A single function, called by the send path and by the interface.

### Membership is retained with `left_at`; a rejoining member inherits their receipt

Already settled by `GLOSSARY.md` and [0003](0003-receipt-watermark.md). Recorded here so the schema
matches it.

### Direct conversations derive their title and avatar; groups store them

A direct conversation has **no stored name at all**, so it cannot go stale when someone changes their
display name.

## Consequences

- **The read-then-write race disappears.** Two people messaging each other for the first time,
  simultaneously, is the *normal* case for every new contact — not a rare edge. An application-level
  uniqueness check is a race with extra steps. This one is a constraint.
- **One bill, stated plainly.** Every query against `conversations` carries a `kind` filter that will
  occasionally be forgotten, and direct rows carry nullable fields that are always null. The
  conversation header already needs `kind` in two places. That is the cost, it is real, and it is
  far smaller than duplicating the entire read model — which is the most-regretted schema decision in
  chat apps, because the duplication compounds with every feature added afterwards.
- **Postgres RLS is rejected, for a specific and slightly uncomfortable reason.** It is the stronger
  guarantee — impossible to bypass from application code. But RLS cannot also drive the interface: if
  the rule lives in the database, the client must reimplement it to grey out a compose box, and that
  copy is the one that drifts. Defence in depth here means **two** implementations of one rule, which
  is the thing being avoided. One function, called from both places, cannot disagree with itself.
- **Messenger's block semantics are declined.** B blocking A there stops only notification — A can
  still send, and the message is silently discarded. Silent drops are how you get bug reports nobody
  can reproduce.
- **v1 has no roles, so there are no add permissions.** `Member`'s _Avoid_ list bans *owner* and
  *admin*, which means there is no such thing as a permission to add someone. Every member may add
  every member. An invite-and-approve flow would require resurrecting a concept the map killed.
- **A rejoining member does not get a huge unread badge.** Their receipt is stale but *true* — they
  genuinely had read that far. Resetting it to zero is a lie in the other direction.

## A trap recorded so nobody "simplifies" it

**Do not replace the nullable unique index with a partial unique index on the members table.**

Postgres supports partial indexes and they look like the tidier expression of the same rule. The
documentation's warning is the reason: a partial index is usable only when the planner can prove the
query implies the index predicate, and **parameterized query clauses do not work with one**.

The failure is the reason this is written down. It is not an error — the constraint still holds. The
read path simply **stops using the index**, and a hot query gets slow in a way that is very hard to
trace back to this decision. A correctness guarantee that silently degrades into a performance
problem is worse than an obvious one.

## What would reverse this

**The single-table decision is reversible only cheaply, while no messages exist.** Splitting into two
tables afterwards means migrating every read path, and the members of a direct conversation already
need to be discoverable. Early enough this is a rename; late it is a project.

**500 is a guess with a defensible shape.** The failure mode is defined — a clean rejection — so
changing the number is a one-line migration. What is *not* cheap is raising it much further, because
receipt write amplification grows with it.