# 0060. Stored state is narrow and derived state is wide

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** stage 3.B — "Client-side `messageState` split: stored states are narrower than rendered states", the one decision in that unit that had no record of its own
**Extends:** [0059](0059-the-send-endpoint.md), whose response is what moves a row between these states, and [0010](0010-receipt-mechanics.md), which settled that reading and delivery are watermarks rather than facts about a message
**Teaches:** [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md) — the "five sources, four renderings, one indicator" table is the thing this implements
**Implemented in:** `packages/protocol/src/conversation.ts`

## Context

`composer-and-sending.md` requires the composer to render five things about a message the member
just sent: a queued send, a send in flight, a sent message, a delivered-or-read message, and a
failed message. Its own framing is **"five sources, four renderings, one indicator"** — and
connection loss is a sixth row in that table which is explicitly **not a state of a message at
all**.

The protocol had one enum, `messageState = ['pending', 'sent', 'delivered', 'read']`, and it could
express none of the two states the composer most needs:

- there was **no in-flight state**, so a send waiting on an open `POST` rendered the same as a send
  waiting for a window; and
- there was **no failed state**, so a definitive rejection had nowhere to go.

Meanwhile two of the four it *did* carry should never have been stored at all. `delivered` and
`read` are facts about a **member's** relationship to a position, not about a message.
[0003](0003-receipt-watermark.md) settled that they are watermarks, [0010](0010-receipt-mechanics.md)
settled that there are two of the reading one, and `GLOSSARY.md` says a Receipt is *"a member's
record"* and never a property of a message. Writing either onto a row is the second source of
truth the glossary bans: the moment either is wrong, the two disagree and nothing says which to
believe.

And `pending` is on the glossary's avoid list. The domain word is **queued send**.

## Decision

### The stored enum is three states wide

```
queued | inFlight | failed
```

Three is not an arbitrary number. It is the set of states a browser can know **with no network at
all**: is the row waiting for a window, is a request open, or has the server definitively refused
it. Anything that requires an answer — a position, a watermark — does not belong in a field on a
row that is written optimistically, before any request exists.

### `sent` is `seq !== null`, and is not stored

[0004](0004-message-durability.md) already fixed the fact this depends on: `seq` is null exactly
once, between the optimistic local write and the server's acknowledgement, and a client may never
interpolate it. So "committed" has a test that costs nothing and cannot drift — `seq !== null` —
and storing `sent` beside it means storing a fact that the same row already carries more reliably.

### `delivered` and `read` are never columns on a row

They are comparisons against **per-member** watermarks, made at render time:

```
delivered  ⇔  some member's delivery.delivered_through ≥ seq(this message)
read       ⇔  some member's receipt.read_through        ≥ seq(this message)
```

"Per member", not per device: any one device acknowledging is enough, because a powered-off device
may never acknowledge and "every device has it" is unfixable by construction.

### The derived enum is separate, wider, and never stored

`renderedMessageState` carries all six renderings, and **none of them is written to anything**.
The stored enum and the derived enum are two different things with two different names on purpose:
an enum called `messageState` that held derived values is precisely what made the old one
ambiguous.

### The watermarks arrive already reduced

`deriveRenderedMessageState` takes `deliveredThrough` and `readThrough` **already reduced by the
caller** to the members that rendering is about. The protocol compares a position against a
watermark. It does not decide **which members qualify** — that predicate, its exclusions (the
sender, former members, members who are not sharing), and the choice of `shared_through` over
`read_through` are [0003](0003-receipt-watermark.md)'s, and they are a privacy decision, not a
wire shape.

Reimplementing that reduction inside a schema would be a second implementation of a decision whose
entire failure mode is that two implementations disagree and one of them broadcasts the gap a member
spent hiding.

## Consequences

- **One source of truth per fact.** Three facts are stored (the request's local state) and two are
  computed (position, watermarks). Nothing is stored twice.
- **`failed` is reachable only by a definitive rejection.** Nothing time-based produces it — a
  queued send that has waited two days has not failed, it has not been *answered* — so a row in
  this state always has a reason, and `Not sent` is always a statement the system can support.
- **That makes the retry classification load-bearing for the row's state, not just for the
  network.** A refusal that could plausibly answer differently on a retry is `retryable` and
  leaves the row `queued`; only a terminal one moves it to `failed`. A block is the interesting
  case: it is server-side state, the *other* member can lift it, and the blocked member does not
  have to do anything for it to change. [0059](0059-the-send-endpoint.md) records why a block is
  retryable, and why the member-facing `You can't send messages to this conversation` is a separate
  concern from the queue's classification rather than the same fact.
- **The send queue gets narrower, which makes it a better query.** `message-lifecycle.md` §3 says
  the send queue is `messages where state = 'pending'` — a query, not a second table. The protocol
  word is `queued`, and `queued | inFlight` is a tighter predicate than three of four values was.
  The concept document says `messages where state = 'queued'` and its opening table now splits
  stored from derived; the protocol is the canonical shape and `GLOSSARY.md` settles which word is
  right — "Queued send", never "pending message".
- **`renderedMessageState` cannot be cached onto the row.** A cached rendering is the old design
  again: the moment a frame or a watermark fails to apply, the row says something untrue and nothing
  says which of the two is stale.
- **The residual hazard is a wrong reduction, and it is silent.** `deriveRenderedMessageState` will
  happily return `read` for an un-reduced watermark that one member passed in. The type cannot
  catch it and no schema can. That is the price of not duplicating ADR 0003's predicate, and it is
  the reason the reduction is documented at the parameter rather than left to the caller to
  remember.

## What would reverse this

**Storing the rendered state as a performance cache.** It would make the transcript cheaper to draw
and would be wrong the first time a frame arrived out of order, which is not an edge case — it is
what the advisory lock in [0005](0005-message-ordering.md) exists because of.

**Per-device delivery.** Not a change to this ADR but the thing it would change: `delivered`
becomes a set rather than a watermark, the reduction in `deriveRenderedMessageState` stops being a
comparison, and every sender-facing indicator grows a device dimension. ADR 0004 already rejects it
as unfixable by construction, so reversing this would be reversing that too.

**A server-rendered "what has this member seen" API.** If the interface ever asks the server for a
rendered state instead of deriving it, the reduction stops being render logic and becomes wire
shape — and then ADR 0003's predicate is being implemented in a schema, which needs its own
decision rather than a comment.

**`shared_through` becoming the only stored position.** That would collapse the two positions [0010](0010-receipt-mechanics.md)
exists for, and it would break the member's own unread count rather than anything visible to
others.
