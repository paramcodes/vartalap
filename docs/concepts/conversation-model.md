# The conversation model

One table for every kind of conversation, one NULL doing the uniqueness work, and one predicate that
decides who may send.

The decisions are in [`docs/adr/0007`](../adr/0007-conversation-model.md). Vocabulary is in
[`GLOSSARY.md`](../../GLOSSARY.md): a **Conversation** is a place where a set of **Members** exchange
**Messages**, defined by its membership rather than by a stored type, and a **Former member** is
one who left and remains one.

---

## One table

```sql
conversations (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL,          -- 'direct' | 'group'
  direct_key  text NULL,              -- the two member ids, sorted, joined by ':'
  title       text NULL,              -- groups only; null for direct, always
  created_at  timestamptz NOT NULL,
  UNIQUE (direct_key)
)
```

Not `direct_conversations` and `group_conversations`. The conversation list, the unread badge, the
last-message preview, drafts, read state, socket subscription and push notification are each written
once against a single shape. Split the table and each is written twice — and then somebody ships a
feature that works in only one branch.

**The bill, stated rather than discovered:** every query carries a `kind` filter that will
occasionally be forgotten, and direct rows carry nullable fields that are always null. The
conversation header alone needs `kind` in two places. That is cheaper than the alternative, which is
compounding duplication across every feature added later.

---

## The NULL that does the work

**Postgres treats NULLs as distinct in a unique index by default.** So `UNIQUE (direct_key)` gives
you both halves of the rule at once:

- exactly **one row per direct pair**, because two conversations for the same pair would collide on a
  non-null key
- **unlimited group rows**, because every group row's key is NULL and NULLs never collide

No partial index. No second table. No application-level check.

`direct_key` is the two member ids **sorted and joined**, so argument order cannot produce two
different keys for the same pair. The format is two UUIDs joined by `:` — a colon is not a hex
character, and both halves are fixed width, so the string splits exactly and sorts canonically.

A check constraint ties the two together: `kind = 'direct'` requires a non-null key.

### Why this matters more than it looks

"Find or create the direct conversation between A and B" is inherently read-then-write, and two people
messaging each other for the first time **at the same moment** is the *normal case for every new
contact*, not a rare edge. An application-level check is a race with extra steps.

Creation is one statement plus a re-select:

```sql
INSERT INTO conversations (id, kind, direct_key)
VALUES ($1, 'direct', $2)
ON CONFLICT (direct_key) DO NOTHING;

SELECT * FROM conversations WHERE direct_key = $2;
```

Two concurrent senders cannot produce two conversations. They can produce two inserts, one of which
is discarded, and both callers end up at the same row.

### The trap to not fall into

**Do not replace this with a partial unique index on the members table.** Postgres supports them, they
look like the tidier expression of the same rule, and the documentation explains why they are not:
a partial index is usable only when the planner can prove the query implies the index predicate, and
parameterized query clauses do not work with one.

The failure is the reason this is written down at all. It is not an error. The constraint still holds.
The read path just **stops using the index**, and a hot query gets slow in a way that is very hard to
trace back to a schema decision made months earlier. A guarantee that silently degrades into a
performance problem is worse than an obvious one.

---

## Groups

Ceiling of **500 members**, and hitting it is a clean rejection rather than a partial fan-out.

The number is not the important part — the failure mode is. Receipt writes amplify as members ×
messages, so the largest group is the most expensive thing in the system. Lowering the ceiling later
is a one-line migration; raising it much further is not.

v1 has **no roles**. `Member`'s _Avoid_ list bans *owner* and *admin*, which means there is no such
thing as a permission to add anyone: every member may add every member. An invite-and-approve flow
would require resurrecting a concept the map deliberately killed.

---

## Blocks

**B blocks A ⟹ A can no longer send to B, and B's messages to A are not delivered.**

One-directional in intent — B should still be able to message A — but with real consequences rather
than silence. Messenger's behaviour is to let A keep sending and silently discard the message, which
means sent messages simply vanish; silent drops are how you get bug reports nobody can reproduce.

Unblocking does not retroactively deliver anything.

### One predicate, one place

Whether a member may send to a conversation is decided by **a single application function**, called by
the send path and by the interface.

**Postgres RLS is rejected, deliberately.** It is the stronger guarantee — impossible to bypass from
application code. But it cannot also drive the interface: if the rule lives in the database, the
client has to reimplement it to grey out a compose box, and that copy is the one that drifts. Defence
in depth here means *two* implementations of one rule, which is the thing being avoided.

---

## Leaving, and coming back

Already settled by the glossary: a **Former member** has left and remains one. Nothing they sent is
deleted and no membership is erased, so the row is **retained with `left_at`**. Their receipt
survives too — which is precisely why [ADR 0003](0003-receipt-watermark.md) excludes former members
from the `Seen` predicate. A retained receipt belonging to someone who left would otherwise pin
"Seen" off forever.

A member who rejoins **inherits their old receipt**. They should not come back to a 900-message badge.
The receipt is stale but *true* — they genuinely had read that far — and resetting it to zero is a lie
in the other direction.

---

## Title and avatar

**Direct conversations derive both, always. Groups store both, mutable by any member.**

A direct conversation stores no name whatsoever, which means it cannot go stale when someone changes
their display name — the behaviour you want, and the reason not to denormalise it.

This is where the shared table's cost first becomes visible: the read path for a conversation header
branches on `kind`. Two branches today, more later. Cheap, and worth paying — but named rather than
left as a surprise.