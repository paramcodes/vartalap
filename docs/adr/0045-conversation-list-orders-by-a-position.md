# 0045. The conversation list orders by a position, and `0` is not a position

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation list and chat view spec"
**Builds on:** [0005](0005-message-ordering.md) (global `seq`), [0007](0007-conversation-model.md) (one table), [0003](0003-receipt-watermark.md) (unread is derived)
**Teaches:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md)

## Context

The ticket asked what orders the conversation list and what happens to the order when a message is
pinned, edited, or a member joins. It got the order question right and the consequence question
wrong in the same breath — it asked for three events that the domain has already ruled out.

The real question underneath is narrower and much more valuable: **what single number is the list's
sort key, and what makes it impossible for that number to move for the wrong reason.**

Every chat app orders its conversation list by a wall-clock timestamp — `last_message_at`,
`updated_at`, `last_activity`. That is the obvious answer and it is wrong here for a reason
[0005](0005-message-ordering.md) has already written down: **`created_at` is never a sort key**,
because `now()` is `transaction_timestamp()` and a transaction that starts at T and commits at T+5s
stamps its rows T, so it sorts *below* rows a client loaded at T+2s. Device clocks drift and are
user-settable, so a client timestamp is not a sort key either. The map left one ordering primitive
standing: **`seq`**.

## Decision

### `conversation.last_seq` is the list's sort key, and it is a position

```sql
last_seq  bigint NOT NULL DEFAULT 0
```

Maintained in the same transaction that inserts the message, by

```sql
UPDATE conversation SET last_seq = GREATEST(last_seq, $seq) WHERE id = $1
```

**Never recomputed from `MAX(seq)`, never repaired by a job, never set from a timestamp.**
`GREATEST` for the same reason [0010](0010-receipt-mechanics.md) uses it: frames arrive out of
order, a send queue flushes after a reload, two tabs race, and a blind assignment would walk the
value backwards.

### `0` is the "no messages yet" sentinel, chosen because `seq` starts at 1

`seq` comes from a PostgreSQL sequence at its default `START WITH 1 INCREMENT BY 1`, which never
returns `0`. So `0` is unreachable by any real message and can carry "this conversation has no
position yet" without a `NULL`.

This is not cosmetic. **IndexedDB does not index `null`**, so a nullable `last_seq` produces a row
that is invisible to `orderBy('last_seq')` on the client and needs `NULLS LAST` on the server — two
different behaviours for the same field, and a conversation that vanishes from the list on one
platform. With `0` there is one column, one index, one query, and empty conversations sort last for
free.

### The column lives on the conversation, never on the membership

Because `last_seq` is a property of the **conversation**, being added to a busy old group cannot
reorder anybody's list. On a membership row it would: joining a four-year-old group would yank it to
the top of your list, which is the most surprising reorder a chat app can perform and the one nobody
asks for.

### The preview is the newest item you hold, queued sends included

The row's preview is the newest **queued send** if the conversation has one, and otherwise the newest
message. A conversation whose send you are waiting on must not preview as though nothing happened —
that is the row reading stale while you watch it try to go.

### A queued send does not move the row

`last_seq` advances only on the server's answer. So the first message ever sent to a brand-new
conversation appears **at the bottom of the list for the length of one `POST` round trip**, then
jumps to the top when the server's position lands.

That is deliberate and it is the whole point of the rule. The client may not interpolate a
provisional position — not from local time, not from `count(*)+1`, not from a UUIDv7 reading. It
applies **the server's value**, and until that value exists the row has none. One jump after ~100ms,
into the position the send genuinely caused, is honest; a row that appears to jump *twice*, once on
optimism and once on truth, is not.

**This is the only case where the list reorders itself, and it reorders because a message arrived**,
which is what the list orders by.

### An edit cannot reorder the list, and this is a schema constraint

[0005](0005-message-ordering.md) already records that an edit "rewrites a body in place and never
moves a row, changes its `seq`, or changes its `id`", and that a soft delete "keeps its `seq`
occupied". Both are upstream facts, and together they mean **`last_seq` cannot move for either
event**. The guarantee is a column property, not a UI discipline, and nobody has to remember it.

### `last_seq` carries no foreign key to `message`

Same reason `receipt.read_through` and `delivery.delivered_through` do not: **a position is not a
row.** A hard delete of the newest message leaves `last_seq` pointing at a position no row occupies,
which is correct — the conversation still has activity at that position, and the next message assigns
a higher one.

## Consequences

- **`ORDER BY last_seq DESC` and nothing else.** `seq` is globally unique across messages, so two
  conversations cannot tie and **no tie-break column is needed**. A `created_at DESC` tie-break is a
  symptom of having chosen the wrong key.
- **The list renders from Dexie with one indexed query**, because `last_seq` is replicated onto the
  conversation row. Deriving it as `MAX(seq)` per conversation at read time would be correct on the
  server and unusable on the client, where it is a scan across however many message rows each
  conversation happens to have cached.
- **Reordering a list is now a diff, not a reset.** The list is sorted by one number; a new message
  moves one row, and the row animates in over 280ms with the enter easing from
  [0002](0002-messenger-token-layer.md).
- **Three things the ticket asked about are declined, and the reasons are not tidiness.**
  **Pin** is not in the map's v1 feature list and is Tier 2; a pinned *conversation* is a sort
  override that only earns its keep next to an archive. **Archive** is not in the v1 list either, and
  Meta's own Help Center describes Messenger's version as a separate surface where archived
  conversations are found "by searching for it" — a filter that hides rows and makes a conversation
  *findable but not visible*, which is the shape of the "where did it go" support ticket. Neither
  earns a column in a v1 learning project.
  **Mention badges** need mentions, and mentions are Tier 2. An unread-styled badge variant that can
  never render is a variant that will never be tested.
- **Reordering stops being a place where a bug can hide.** The one column that orders the list moves
  only when the server assigns a position, and the server assigns a position only when a message is
  committed.

## What would reverse this

**A stored unread count or a stored "last message preview" beside `last_seq` would reverse the
derivation discipline** in [0003](0003-receipt-watermark.md) — a second source of truth that
disagrees with the receipt the moment either is wrong. The preview is derived from the transcript;
the unread count is derived from the receipt. `last_seq` is neither of those: it is a *position the
server assigned*, not a count and not a rendering.

**Adding archive later is cheap; adding it as a filter of the existing list is not.** The column is
one nullable `timestamptz` on the membership. The work is the second surface and the
"findable but not visible" behaviour — which is why declining it now is a judgement about
discoverability rather than about schema.

## A trap worth naming

**Two conversations can never tie on `last_seq`, and a tie-break you add anyway is the bug.** It
reads as defensive. It is actually a second sort key re-entering through the back door, and the
moment it exists, `created_at` is back in the query and the transaction-start-time problem from
[0005](0005-message-ordering.md) is back with it.