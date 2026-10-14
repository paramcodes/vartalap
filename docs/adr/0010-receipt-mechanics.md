# 0010. A receipt has two positions: the one you own, and the one everyone else sees

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Read receipt mechanics: row shape, monotonicity, throttling, and catch-up"
**Extends:** [0003](0003-receipt-watermark.md), which settled the watermark model
**Teaches:** [`docs/concepts/message-receipts.md`](../concepts/message-receipts.md)

## Context

[0003](0003-receipt-watermark.md) settled that a receipt is a bookmark rather than a diary — one
monotonic position per (conversation, member), replacing rather than appending. It left five
mechanics open, and the position type among them was settled by
[0005](0005-message-ordering.md): a single global `seq`, server-assigned.

The remaining four all reduce to one question the ticket did not think to ask: **a receipt whose
position depends on a member's privacy setting cannot be a single position.**

## Decision

### One row, two columns

```
read_through     -- always advances. Drives the member's own unread count.
shared_through   -- advances ONLY while the member is sharing.
```

`Seen` is computed over **`shared_through`**. This mirrors the `delivery` table from
[0004](0004-message-durability.md), which keeps the same `(conversation_id, user_id)` key and the same
monotonic upsert, and which never carries a sharing flag: delivery is the fact that a frame arrived,
not a disclosure about the member.

### Why a boolean cannot work

The obvious design is one row with a `sharing` flag. It fails on re-enable, and the failure is not
obvious until it happens.

`read_through` advances the whole time sharing is off — it must, or the member's own unread count
breaks. So when they turn sharing back on, their `read_through` is already **ahead** of where they
left it. Broadcasting that value reveals the entire gap they spent the time hiding, immediately.
Broadcasting nothing reveals it anyway on the next advance.

**A boolean cannot express "my position is frozen at where it was when I turned this off."** That
requires a second stored value, and the second value is what carries the meaning.

The two columns advance on different clocks and are read by different people, which is why they are
columns in one row rather than two rows.

### Turning sharing back on resumes forward progress, with a lag

`shared_through` freezes while sharing is off and resumes from the frozen value. The sender sees
ordinary forward progress that happens to lag real time. **No discontinuity, no leak.**

### Monotonicity lives in the upsert

```sql
ON CONFLICT (conversation_id, user_id) DO UPDATE
SET read_through   = GREATEST(receipt.read_through,   EXCLUDED.read_through),
    shared_through = GREATEST(receipt.shared_through, EXCLUDED.shared_through)
```

`GREATEST` is the whole correctness story for out-of-order arrival — a send queue flushing after a
reload, a receipt landing before the message it references, two tabs racing. It also handles a member
whose device clock jumps backwards, **provided the client sends an absolute position rather than a
delta**. That dependency is recorded because it is invisible: changing the protocol shape to deltas
would not fail loudly, it would just stop working.

No `CHECK` constraint: the invariant is about *how* a row is written, not what a single row contains.

### The client sends receipts on backward scroll, debounced

Opening a conversation advances to the end immediately. Scrolling **backwards into older history**
sends further receipts, debounced — never per message.

Scrolling forwards sends nothing, because the receipt is already past it.

## Consequences

- **A user can read without advertising, and resume without a tell.** Turning sharing off freezes
  their visible position; the unread count keeps working because it reads the other column. This is
  what the map meant by "a member who never saw it missed nothing", extended to receipts.
- **The predicate in 0003 gets more precise.** "Seen" is now over `shared_through`, over current
  members, excluding the sender — and excluding members who are not sharing, which is the same
  exclusion as former members for the same reason: *a position the sender cannot see must not gate a
  predicate the sender cannot satisfy.*
- **Receipts are two write paths now.** Both monotonic, same key, same transaction. The `delivery`
  table has one. A builder who assumes "the receipt table" is singular will get this wrong.
- **Bandwidth stays flat.** Debounced backward-scroll receipts mean a member reading a long backlog
  sends a handful of updates, not one per message. Forward scrolling sends none.
- **⚠️ Throttling is justified by judgment, not by a number.** The original framing — unthrottled
  receipts being *"orders of magnitude more traffic than the messages themselves"* — **has no
  primary source.** Discord, Slack, Signal and Telegram engineering contain zero measurements of
  typing or receipt traffic, and no ratio could be sourced. The throttle stands because writing a row
  per scroll event is obviously wasteful; it is simply not backed by a published figure, and this
  record says so rather than borrowing authority it does not have.

## What would reverse this

**Private read as a separate receipt *type*, à la Matrix's `m.read.private`,** is a defensible
alternative and would make the two positions symmetric rather than one being derived from the other.
We collapsed them into one row because they advance on different clocks and are read by different
people — which is an argument about the code, not about the model, and would not survive a real
divergence.

**Dropping sharing entirely** is the other direction, and it would delete a column and a UI control.
The cost would be that a member who wants to read privately must leave the conversation, which is a
worse answer than the problem.