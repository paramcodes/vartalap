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
  delivered_through bigint NOT NULL DEFAULT 0,   -- the server-assigned seq position
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE receipt (
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES "user"(id),
  read_through    bigint NOT NULL DEFAULT 0,     -- always advances
  shared_through  bigint NOT NULL DEFAULT 0,     -- advances only while sharing
  sharing         boolean NOT NULL DEFAULT true, -- never what freezes the row; see below
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
```

One row per (conversation, member) each. **Replace on write, never append.** Positions are the
global `seq` from [message ordering](./message-ordering.md).

**Watermarks are `NOT NULL DEFAULT 0`, and `0` is a real position** — it sits before the first
message's `seq`, which is exactly what a member who has read nothing in a conversation holds. **A
`NULL` watermark is not a position.** It would force `GREATEST`, the `Seen` comparison, and every
unread count to special-case one, and those are three places that would have to agree for a
watermark to work.

`updated_at` is bookkeeping and nothing on the message path reads it. It is not a watermark and never
feeds a position.

`sharing` is a **transport signal about a permission, not the mechanism.**
[0058](../adr/0058-receipt-sharing-is-a-transport-signal.md) settles what an earlier draft of this
section left open, and it is a division of roles:

| | what it is | what it does |
|---|---|---|
| `shared_through` | the mechanism — the stored position everyone else reads | moves, or does not move |
| `sharing` | a signal — "may I move it right now?" | changes nothing by itself |

`read_through` therefore advances on **every** write, whatever `sharing` says, and `shared_through`
advances only while the signal permits it. That is the whole of the wiring, and 0058 says so because
an unread count that stops working when someone reads privately is a worse bug than the leak it
avoids.

**The signal does not ride the advance.** [0059](../adr/0059-the-send-endpoint.md) settled that
`sharing` is not a field on the receipt-advance body — it is a settings change with its own transport
under [0022](../adr/0022-settings-boundary-and-transports.md), and the server learns the permission
from that separate write. 0058's distinction is about meaning and not about which endpoint carries
the flag: both transports carry a signal, and neither makes the boolean a mechanism.

**The honest cost, stated because it is accepted rather than solved.** A signal is only as fresh as
its last transmission. **A member who turns sharing off and then sends nothing further leaves
`sharing = true` on the server**, and the server keeps advancing their `shared_through` on any
receipt arriving from another device or a background sync. Nothing in the schema prevents it, and
0058 declines a poller: a job whose purpose is to watch a privacy flag is a new failure surface.
Treating the stored column as authoritative instead is exactly what would make it a mechanism.

Neither table carries a foreign key to `message`. A position is not a row, so deleting a message
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

**"Only while sharing is on" describes the outcome, not the wiring.** `shared_through` is the
mechanism and it moves because the server moves it; `sharing` says whether it may, and does nothing
itself. Reading the boolean as the thing that freezes the position is
[0058](../adr/0058-receipt-sharing-is-a-transport-signal.md)'s named failure — the one where a
privacy control is turned into a disclosure button.

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
**That is now true of the database and not only of this document.** `receipt_shared_le_read` shipped
in `0001_init.sql` and stage 3's `0006_reconciliation.sql` dropped it.
[0058](../adr/0058-receipt-sharing-is-a-transport-signal.md) is why the drop is coherent rather than
merely permitted: the row's validity is decided by the branch that gates `shared_through`, and by
nothing else.

---

## "Seen"

```
Seen under M  ⇔  ∀ m ∈ currentMembers(M), m ≠ me, shares(m):
                     receipt[m].shared_through >= seq(M)
```

> **ADR 0003 was corrected on this point by [0010](../adr/0010-receipt-mechanics.md).** It originally
> read `receipt[m].read_through`, and building it off that column broadcasts the entire gap a member
> spent hiding — the failure 0010 exists to prevent. It now reads `shared_through`, with the amendment
> recorded in 0003's own header. **0010 governs**, and the two agree.

Derived on every render. **Never stored.**

Two exclusions, one reason: a position the sender cannot see must not gate a predicate the sender
cannot satisfy. A **former member** qualifies — their receipt survives, per the glossary, and would
otherwise pin "Seen" off forever. So does a member who is not **sharing**.

Nothing in the schema says "under the last outgoing message". It falls out: a member's own sends
never advance their own receipt, so their own watermark can never satisfy the condition for their own
message.

`read_through >= shared_through` always holds — nobody reads what did not arrive. Both columns are in
`receipt`, so the comparison is a row against itself. Free to enforce, cheap to violate silently if
never written down.

> **0004 wrote this invariant as `read_through >= delivered_through`, and has been corrected.** Those are
> two columns in two different tables, so the comparison named nothing and enforced nothing — and
> because both tables exist and both columns are monotonic, the mistake is invisible rather than loud.
> [0004](../adr/0004-message-durability.md) now states `read_through >= shared_through`, which agrees
> with the line above. The mistake is kept in the trap list because it is exactly the kind of
> plausible-looking invariant nobody catches in review.

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