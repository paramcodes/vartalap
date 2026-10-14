# Reading, delivered, and receipts

How far someone has read, how far a message has travelled, and the two columns that keep them apart.

Decisions are in [0003](../adr/0003-receipt-watermark.md), [0004](../adr/0004-message-durability.md),
[0005](../adr/0005-message-ordering.md) and
[0010](../adr/0010-receipt-mechanics.md). Vocabulary is in
[`GLOSSARY.md`](../../GLOSSARY.md).

---

## Two tables, one shape each

```sql
CREATE TABLE delivery (
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES "user"(id),
  delivered_through bigint,        -- the server-assigned seq position
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE receipt (
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES "user"(id),
  read_through    bigint,          -- always advances
  shared_through  bigint,          -- advances only while sharing
  PRIMARY KEY (conversation_id, user_id)
);
```

One row per (conversation, member) each. **Replace on write, never append.** Positions are the
global `seq` from [message ordering](./message-ordering.md).

Neither table carries a foreign key to `messages`. A position is not a row, so deleting a message
must not delete the thing pointing at it.

---

## Delivery: any one device is enough

A member's client acknowledges the frame after persisting it, and the server advances
`delivered_through`. **Any single device acknowledging counts** — "she has it somewhere" is the fact
a sender wants, and per-device delivery would need device identity to answer a question nobody asks.

It is not per-device because "every device has it" is **unfixable by construction**: a powered-off
device may never acknowledge.

---

## Read: two positions, because one cannot express privacy

The obvious design is one position plus a `sharing` flag. It fails the moment someone turns sharing
back on.

`read_through` advances the whole time sharing is off — it has to, or the member's own unread count
breaks. So when sharing is re-enabled, their `read_through` is already **ahead** of where they left
it. Broadcasting that reveals the entire gap they spent the time hiding, immediately. Broadcasting
nothing reveals it on the next advance anyway.

**A boolean cannot express "my position is frozen at where it was when I turned this off."**

So:

| column | advances | who reads it |
|---|---|---|
| `read_through` | always | the member's own unread count |
| `shared_through` | only while sharing is on | everyone else's "Seen" |

`shared_through` freezes while sharing is off and **resumes from the frozen value**. The sender sees
ordinary forward progress that happens to lag. No discontinuity, no leak.

---

## Monotonicity, and where it lives

```sql
ON CONFLICT (conversation_id, user_id) DO UPDATE
SET read_through   = GREATEST(receipt.read_through,   EXCLUDED.read_through),
    shared_through = GREATEST(receipt.shared_through, EXCLUDED.shared_through)
```

`GREATEST` is the entire correctness story for out-of-order arrival — a send queue flushing after a
reload, a receipt landing before the message it references, two tabs racing. Without it, "Seen"
flickers off at random.

It also absorbs a device clock jumping backwards, **but only because the client sends an absolute
position.** If the protocol ever switches to deltas, this quietly stops working and nothing fails
loudly. That dependency is recorded because it is invisible.

No `CHECK` constraint: the invariant is about *how* a row is written, not what one row contains.

---

## "Seen"

```
Seen under M  ⇔  ∀ m ∈ currentMembers(M), m ≠ me, shares(m):
                     receipt[m].shared_through >= seq(M)
```

Derived on every render. **Never stored.**

Two exclusions, one reason: a position the sender cannot see must not gate a predicate the sender
cannot satisfy. A **former member** qualifies — their receipt survives, per the glossary, and would
otherwise pin "Seen" off forever. So does a member who is not **sharing**.

Nothing in the schema says "under the last outgoing message". It falls out: a member's own sends
never advance their own receipt, so their own watermark can never satisfy the condition for their own
message.

`read_through >= shared_through` always holds — nobody reads what did not arrive. Free to enforce,
cheap to violate silently if never written down.

---

## What the client sends

**Opening a conversation advances to the end immediately** — matching Messenger and WhatsApp. Showing
a conversation reads all of it, including what was never scrolled to.

**Scrolling backwards into older history sends further receipts, debounced.** Never per message.

**Scrolling forwards sends nothing**, because the receipt is already past it.

Bandwidth stays flat as a result: a member working through a long backlog sends a handful of updates.

---

## Honest gaps

**Throttling here is justified by judgment, not by a number.** The original framing claimed receipts
are *"orders of magnitude more traffic than the messages themselves."* **No primary source publishes
any such ratio** — Discord, Slack, Signal and Telegram engineering contain zero measurements of
receipt or typing traffic. Debouncing stands because writing a row per scroll event is obviously
wasteful. It is not backed by a published figure, and it is not claimed to be.

**Still open, and owned elsewhere:** `CRDT` or local-first sync becomes worth reconsidering when
message volume per open conversation justifies it. That is a threshold to measure, not a decision to
anticipate.