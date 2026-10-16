# 0057. The outbox relay is a poller, and its delivery guarantee is at-least-once

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Build the spine first" — the relay's execution model, which no document states
**Extends:** [0004](0004-message-durability.md), which put `outbox` in the schema and left it without a reader
**Amends:** [hardening backlog H-18](../concepts/hardening-backlog.md), which named the purge rule before the columns existed to express it
**Teaches:** [`docs/concepts/message-lifecycle.md`](../concepts/message-lifecycle.md) §7

## Context

[0004](0004-message-durability.md) explains why the outbox exists — "commit, then call the broker" produces a message that exists, a transaction that succeeded, and a broadcast that failed, and "nobody ever hears about it". Every other document refers to "a relay" as though it were a documented component.

It never is. `outbox.published_at` shipped with no reader, and nothing in the repository says whether rows are polled, signalled, or streamed. Stage 3.F is the first code to touch the table, and it has to choose.

The choice is not free, because the obvious alternative is foreclosed. ADR [0018](0018-socket-is-a-lease.md) established that "no `LISTEN`/`NOTIFY` […] anywhere in this design", and stage 3 runs against **Neon**, which terminates connections and pools them. A `LISTEN` sits on a dedicated session that scale-to-zero and PgBouncer both destroy, so a notification-triggered relay would be a relay that silently stops existing. Polling is the execution model, and the rest of this ADR is about doing it correctly.

## Decision

```sql
SELECT id, message_seq, conversation_id, payload
  FROM outbox
 WHERE published_at IS NULL
 ORDER BY id
 LIMIT 100
   FOR UPDATE SKIP LOCKED;
```

Loop on a short interval. On each row: publish to the sink, then in the same transaction `UPDATE outbox SET published_at = now() WHERE id = $1`. On failure: `UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1` and commit — leaving `published_at` NULL so the row returns to the working set.

### Why `SKIP LOCKED` and not plain `FOR UPDATE`

**`FOR UPDATE` is what makes it correct. `SKIP LOCKED` is what makes it parallel.** They do different jobs and confusing them is how relays get built wrong.

Plain `FOR UPDATE` is sufficient for correctness: the second relay blocks on the first relay's rows, so no row is ever published twice. That is the whole requirement. But blocking means the two relays do not share the work — the second one waits for the first, so a two-relay deployment runs at one-relay throughput. Worse, the failure case inverts the intent: if the first relay dies holding locks, its rows stay locked until the backend is reaped, and the healthy relay **waits on the dead one** rather than taking over. The redundancy is there and cannot be used.

`SKIP LOCKED` changes who gets which rows, not whether two relays can get the same one. The second relay skips straight to the next hundred and starts immediately, and a dead relay's rows become claimable as soon as its transaction ends.

### Batch size: 100

**This number is judgment, not measurement, and is recorded as such** — the same standing ADR [0010](0010-receipt-mechanics.md) gives the receipt throttle, which it also cannot source.

The reasoning is three-sided and all of it is reasoning:

- **Too small** (say 10) and a busy conversation keeps the relay permanently at the front of the table, doing ten round trips per pass. The lock is held for the whole batch, so a small batch means many short transactions instead of few long ones.
- **Too large** and one batch holds row locks on thousands of rows while the sink is called sequentially, so the batch's tail is locked long after it stopped being useful. Under at-least-once, a crash mid-batch re-delivers everything after the crash point — a big batch makes that re-delivery proportionally bigger.
- **100** is one round trip per hundred messages at human send rates, a crash mid-batch loses at most 100 frames rather than a thousand, and the lock hold is seconds. If those three numbers ever disagree, the measurement wins.

### The delivery guarantee is **at-least-once**, deliberately

No document named it. Naming it is most of the point of this ADR, because **the correctness argument rests on a property of the client that nobody would otherwise know the relay depends on.**

Exactly-once is unavailable, and not for want of trying. The message commits in Postgres; the broadcast happens in Centrifugo. There is no transaction spanning them, and *that gap is the entire reason the outbox exists* — 0004 rules out the alternative precisely because you cannot make one atomic fact out of "committed" and "delivered". Any protocol claiming exactly-once here is claiming something the architecture forecloses.

So the choice is at-most-once or at-least-once, and they are not symmetric:

- **At-most-once** means a row that fails to publish is marked done and never retried. The message exists in `message` and in every member's transcript-on-reconnect, but every member who was **connected at that instant** never saw it arrive, and no client can detect the absence. A silent hole.
- **At-least-once** means a failed publish is retried, and a relay killed after the sink accepted but before `published_at` committed re-delivers on restart.

At-least-once is correct here because **the client must already be idempotent.** [0005](0005-message-ordering.md) makes `message.id` a client-generated UUIDv7 that is *simultaneously* the identity and the idempotency key, and stage 3.G requires one receive write path — live frame, catch-up row, own-echo — that upserts on the client id. A duplicate frame that upserts is **free**. An at-most-once relay that drops one frame is a hole nobody detects.

So the duplicates are not a defect to be engineered away. They are the price of not losing messages, and the client is built to absorb them.

### The purge rule, now that `attempts` and `last_error` exist

H-18: *"delete on successful fan-out; failed rows retained 24 h then purged"*, justified because "the outbox is the only table whose growth is unbounded and whose rows stop being useful the moment they work."

Until stage 3 that rule was **inexpressible**: with only `published_at`, a row the relay has tried five times and a row it has never touched are both `published_at IS NULL`. "Failed" and "never attempted" were one value, and nothing could count on them.

```
published                          → deleted on success
unpublished, attempts > 0          → deleted 24 h after created_at
unpublished, attempts = 0          → a fresh send; never purge on age alone
```

**The 24 hours are anchored on `created_at`, not on the last attempt.** That is the load-bearing choice. Purging 24 hours after the *last* attempt would need a last-attempt timestamp the schema does not have, and — worse — it would let a permanently-failing row be retried forever and never purged, which is unbounded growth, the exact defect H-18 exists to close. Anchoring on `created_at` bounds the table unconditionally.

**What that costs, and why it is acceptable:** a row that keeps failing for 24 hours is never broadcast. That is survivable because **the outbox is a latency optimisation layered over a durable record.** The message is in `message`. The client's catch-up query (3.D) and the `COUNT(*)` reconciliation (3.G, gate G4) both fetch it. Deleting the outbox row degrades a *live frame* into a *catch-up row*; it does not delete the message. Finite retention is only safe because of that, and that is worth writing down rather than leaving as an assumption.

**There is no attempt cap.** `attempts` counts and `last_error` records; neither gates. A cap would convert a two-hour broker outage into permanently undelivered frames, which is a strictly worse failure than a temporarily hot table.

## Consequences

- **Three paths write outbox rows, and each writes in the same transaction as the state it broadcasts.** The send path writes `message.created` with its `message_seq`; `advanceReceipt` writes `receipt.advanced` and `acknowledgeDelivery` writes `delivery.acked`, both with `message_seq` NULL — which is what migration 0007's nullability and the `outbox_message_created_needs_message_seq` CHECK exist to allow. A stored watermark nobody is told about is a `Seen` that never renders; a broadcast watermark nobody stored is a frame a catch-up cannot reproduce. The two commit together or neither does.
- **A no-op advance writes nothing.** An advance that re-reports a position `GREATEST` refused leaves the stored row unmoved, and the write paths compare before against after and skip the insert. Without that rule every duplicate frame arrival — a second tab, a retried ack — would manufacture a broadcast for a watermark that did not change, and the outbox would fill with noise the relay is obliged to publish. At-least-once tolerates a duplicate it did not manufacture; it must not manufacture them.

- **Two relays can run, and one can be replaced mid-flight.** Running a second relay needs no coordination, no leader election, and no fencing token.
- **A relay killed mid-batch re-delivers the remainder of that batch.** Up to 100 frames. Every one of them is a duplicate the client already handles, and every one of them is cheaper than the alternative of a hole.
- **`attempts` and `last_error` are the only diagnostic a permanently-broken row ever gets**, and H-18's 24-hour window is now a number a query can express rather than a rule somebody has to remember.
- **The relay's correctness depends on a client property in a different repository.** That dependency is the thing this ADR exists to make visible. A future client that appends instead of upserting on the client id does not fail loudly — it duplicates rows — and the relay's at-least-once choice is what makes that duplication reachable.
- **Nothing is broadcast from request handling**, which is the property 0004 was actually buying. Polling enforces it structurally: the send transaction writes a row and returns.
- **The sink is an interface, not Centrifugo.** Centrifugo is not installed and is not stage 3. The guarantee above is a property of the *relay loop*, not of any broker, which is what lets a recording implementation stand in and lets the loop be tested without a broker.

## What would reverse this

**A broker that can be part of the database transaction.** If the sink ever gains a transactional publish — or the relay moves into the same Postgres via logical decoding, where `pg_logical_emit_message` writes into the WAL and survives a crash — the at-least-once argument weakens, because the publish and the offset commit become one fact and duplicates stop being reachable. That is the honest path to exactly-once and it is a different architecture.

**`LISTEN`/`NOTIFY` becoming viable**, which requires abandoning ADR 0018's "no session state anywhere in this design" and confirming that the deployment target stops terminating connections underneath a `LISTEN`. On Neon it does not.

**A read replica taking relay traffic.** It cannot: `FOR UPDATE SKIP LOCKED` needs a primary, and a replica would read rows the primary is still locking. Worth naming because "point the relay at the read replica to spare the primary" sounds free and would publish stale payloads or publish nothing.