# 0004. Persist before acknowledge: the durable spine of the message lifecycle

**Status:** Accepted — the durability spine stands; **two points below are corrected in place** by [0005](0005-message-ordering.md)
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The message lifecycle, end to end"
**Feeds:** every subsystem on or attached to the message path — ordering, presence, push, search, receipts, and every conversation-view feature spec
**Amended by:** [0005](0005-message-ordering.md) — **the position is a single global column, not one per conversation.** That was the one thing this record deferred and then stated wrongly, so it is corrected below rather than left as a line known to be wrong.
**Teaches:** [`docs/concepts/message-lifecycle.md`](../concepts/message-lifecycle.md)

## Context

The map committed vartalap to a transactional outbox feeding a self-hosted Centrifugo, optimistic
send with a durable send queue in Dexie, and an `O(1)`-per-member watermark for receipts. Those
choices are individually defensible and jointly irreversible, because everything downstream inherits
them.

What was not decided is the *order of operations* on the send path, and it is the decision that
determines whether the system can lose a message silently. Four things had to be settled together,
because each one constrains the next.

## Decision

### 1. The message and its outbox row are committed in one transaction, before the server responds

Live fan-out is a latency optimisation layered on top of a durable record. It is never the system of
record.

### 2. The client's UUID is simultaneously the message identity and the idempotency key

One generated value, used as `message.id`, as the idempotency key on the request, as the send-queue
key, and in every frame that later mentions the message. The server trusts it for identity and
nothing else.

### 3. Sending is `POST`; everything else rides the socket

Message creation, delivery acknowledgement, receipt advancement, presence, and typing are all
frames. Sending is not.

### 4. Delivery and read are watermarks, not per-message rows

`delivery.delivered_through` and `receipt.read_through`, each one row per (conversation, member),
each monotonic, in two separate tables. Neither carries a foreign key to `message`.

## Consequences

- **A committed message is a message that exists**, even if every relay and every device is offline
  for the next hour. That is the guarantee, and it is purchased with one round trip of added latency
  on the send path. The alternative — commit, then call the broker — has a failure mode with no
  recovery: the message exists, the transaction succeeded, the broadcast failed, and nobody ever
  hears about it.
- **There is no path that can lose a message silently.** Every failure either leaves the member's
  row visible as pending, or moves it to a visible failed state. A message someone pressed send on is
  never discarded by the system.
- **Three tables for what looks like one concept**, which will invite the question. `message`,
  `delivery`, `receipt` — why not collapse them? Because a **Receipt** is defined in
  `GLOSSARY.md` as a record of how far a member has *read*, and delivery is the separate fact that a
  frame arrived. Overloading one table would corrupt a definition the map spent a ticket sharpening.
  The cost of not collapsing is three narrow tables instead of one wide one.
- **`read_through >= shared_through` always holds**, because nobody reads what did not arrive. Both
  columns are in `receipt`, so this compares a row against itself. Free to enforce, cheap to violate if
  it is not written down.

  > **Corrected.** This line previously read `read_through >= delivered_through`, which names two
  > columns in two different tables and therefore compares nothing. The invariant is within one row.
  > The mistake is worth naming because it is silent: both `receipt` and `delivery` exist, both
  > columns are monotonic, and a cross-table "invariant" looks true forever while enforcing nothing.
- **No foreign key from either watermark to `message`.** A watermark points at a *position*, not a
  row. An FK with `ON DELETE CASCADE` would make deleting a message delete the watermark pointing at
  it and un-see everything behind it. Edit and delete are on the roadmap.
- **The client cannot influence ordering.** Positions are server-assigned, in a **single global
  column**. A UUIDv7 sorts and is a fine index layout, but its timestamp is the *client's* clock, and
  RFC 9562 scopes same-millisecond monotonicity to a single node — distributed generators get no
  ordering guarantee at all. How the sequence is allocated is [#7](https://github.com/paramcodes/vartalap/issues/7)'s
  decision; this ADR only fixes that the position is the server's to give.

  > **Amended by [0005](0005-message-ordering.md).** This bullet said *per conversation*, which was
  > the guess that ticket existed to correct, and 0004 had already deferred the shape to it — so the
  > record contradicted itself. **One global column, not one per conversation.** That is not a detail:
  > per-conversation positions do not compare across conversations, so there is no global cursor and
  > reconnect becomes one query per conversation. A single column *is* the cursor.
- **Sending cannot be a fire-and-forget frame.** A socket write has no defined failure: if the
  connection drops mid-emit the client cannot tell whether the message landed, and every retry is a
  coin flip. The idempotency key only means anything because an HTTP request has one response.
- **`409` on an idempotency-key mismatch is our choice, not Stripe's precedent.** Stripe documents
  the comparison and the error *type* (`idempotency_error`) but not the status code, and the
  available sources conflict — a 2017 issue in Stripe's own repository says `400`, a third-party site
  claims `409`. Worth stating plainly so nobody later assumes it is inherited behaviour.

## What is deliberately *not* in this ADR

**`POST` for sending and presence being ephemeral are not decisions.** They are what a competent
team does anyway, and an ADR that records obvious choices dilutes the ones that cost something. The
anti-goal that matters — presence and typing never enter the durable path — is stated in the
[concept document](../concepts/message-lifecycle.md) with its three reasons, because the reason is
what stops someone adding `last_seen_at` for a settings screen in six months and making the whole
constraint unfixable without a migration.

## What would reverse this

**Making delivery durable is the cheap half of the spine; making it *per-device* is not.** The
watermark advances when any one device acknowledges. Switching to "delivered only when every device
has it" is not a schema change — it is unfixable by construction, since a powered-off device may
never acknowledge. If device-level delivery is ever wanted, it is a new fact beside `delivered_through`,
not a redefinition of it.

**Persist-after-acknowledge is the one that would genuinely hurt.** It is faster, and it is wrong in
a way that only shows up during an incident: the message was accepted, the client was told so, and
then the transaction failed. Nothing reconciles it. The one-round-trip cost is the price of never
having to explain that.

**Per-message receipt rows remain rejected** on the arithmetic in
[0003](0003-receipt-watermark.md): `O(messages × members)` is 10⁹ rows for a large conversation, and
"has this member read this message" becomes a self-join over a table that will not fit on the disk we
rent. That decision is already recorded and is not reopened here.