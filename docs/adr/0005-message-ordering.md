# 0005. A global `seq` orders messages, and per-conversation serialisation makes the commit-inversion race impossible

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Message ordering and pagination, including the commit-inversion race"
**Feeds:** every transcript read, every pagination query, and the cursor in the client's Dexie
**Amends:** [0003](0003-receipt-watermark.md), which recommended a *per-conversation* sequence
**Teaches:** [`docs/concepts/message-ordering.md`](../concepts/message-ordering.md)

## Context

The message lifecycle fixed that a server-assigned position exists and that clients cannot influence
it. It left the position's *shape* open, and wrote down a guess: a per-conversation sequence.

Three things make that guess wrong, in increasing order of how much they cost.

**A per-conversation sequence makes reconnect O(conversations).** Positions only compare within a
conversation, so there is no global order across them and therefore no global cursor. Catching up
after a reconnect means one query per conversation. A single global column is that cursor.

**A single column used for two jobs is not two orderings that can disagree.** The lifecycle declined
this as "a second global sequence beside the per-conversation position", worried about keeping them
consistent. That worry was misplaced: one column serving both jobs *cannot* disagree with itself, and
it makes the reconnect storm disappear.

**The density argument cuts the other way.** Per-conversation sequences are dense, so
`max(seq) - min(seq)` versus `count(*)` is a meaningful anomaly check. A global column is sparse —
three messages in a conversation may sit at 100, 5000 and 9000 — so that check stops working. But the
race only ever bites *within* one conversation, so the check is per-conversation anyway, and sparsity
across conversations is irrelevant to it.

The composite problem — a monotonic id assigned at insert, visible at commit, a consumer that
persists its last-seen id, and a row permanently skipped — is **not a named, documented bug class**.
Each component is well documented; the composition is our own analysis and is recorded as such
rather than cited as established.

## Decision

### 1. Two columns: `seq bigint` as the primary key, `id uuid` unique for identity

```
seq  bigint  PRIMARY KEY   -- server-assigned, from a sequence; orders and paginates
id   uuid    NOT NULL UNIQUE  -- client-generated; identity, idempotency key, external reference
```

The dedupe constraint is identical either way, so the choice is purely about index behaviour. An
8-byte primary key that is already in insertion order means keyset pages scan the index without
touching the heap.

### 2. Keyset pagination only, in both directions, page size 50

```
backwards   WHERE conversation_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 50
forwards    WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC  LIMIT 50
```

`OFFSET` is never used. Under concurrent inserts, page three is not the same fifty rows it was a
second ago.

### 3. Serialise message inserts within a conversation

```sql
BEGIN;
  SELECT pg_advisory_xact_lock(<int64 derived from conversation_id>);
  INSERT INTO messages (id, conversation_id, author_id, body, created_at) VALUES (...);
  INSERT INTO outbox   (...) VALUES (...);
COMMIT;
```

The lock is transaction-scoped and released automatically at commit or rollback. It is invisible to
readers, it does not contend across conversations, and a single-message send touches exactly one
conversation — so there is no lock-ordering to get wrong and no deadlock.

### 4. The client reconciles against `COUNT(*)`

After catch-up completes, the client compares the number of messages it holds for a conversation
against the server's count.

## Consequences

- **The commit-inversion race is eliminated rather than mitigated.** Within a conversation, only one
  insert can be in flight at a time, so sequence order and commit order are the same order by
  construction. Across conversations inversions still occur and always did, but they are invisible:
  a client paging conversation B backwards never encounters conversation A's `seq`, so there is no
  gap in that history view. This is the entire reason the ticket framed the race as a live problem —
  the framing is right about the cause and wrong about the scope.
- **This is the documented answer, not an invention.** Debezium's PostgreSQL connector documents the
  same failure — "a consumer receives a notification of a row that was created but it cannot be read
  by a transaction" — and its resolution is not to derive the cursor from the row's own id. We cannot
  use a log position as Debezium does, so we remove the window instead.
- **Reconnect is one query, not one per conversation.** The lifecycle document recorded the
  per-conversation loop as a known limit; this decision deletes it.
- **Sends within one conversation serialise.** The ceiling is one in-flight send per conversation.
  At human message rates that is not a real constraint, and different conversations remain fully
  parallel — which is the only kind of parallelism a chat workload actually needs.
- **`COUNT(*)` reconciliation is exact and cheap, and it is the *only* reliable detector.** The
  natural anomaly check — comparing span against count — is **unsound**, because a sequence burns
  values on rollback, so a conversation's messages can legitimately be 100, 101, 102, **105**.
  PostgreSQL is explicit that sequences "cannot be used to obtain gapless sequences" and that changes
  "are immediately visible to all other transactions and are not rolled back" if the transaction
  aborts. Span exceeding count is the normal case, not the signal. A monitor built on it would either
  cry wolf forever or be muted within a week.
- **`created_at` is never a sort key.** `now()` is `transaction_timestamp()`, so every row in one
  transaction carries the same stamp, `(created_at, id)` degenerates to `id` with an extra column,
  and a transaction starting at T but committing at T+5s stamps its rows T — sorting them *below*
  rows a client loaded at T+2s. It is stored for display only.
- **Client timestamps are never a sort key.** Device clocks drift and are user-settable.
- **`uuidv7()` is not an ordering key here**, though for a narrower reason than the ticket gave. It is
  implemented in PostgreSQL 18 using RFC 9562 Method 3 — a 12-bit sub-millisecond fraction in
  `rand_a` — backed by a process-local `static int64 previous_ns`. The source says the guarantee is
  "at least SUBMS_MINIMAL_STEP greater than the previous returned timestamp **(on this backend)**".
  Across a connection pool it does not hold. On macOS and MSVC builds two bits of `rand_a` are
  XOR-mixed with CSPRNG output, so strict monotonicity fails *within* a backend too. Notably, the
  official documentation claims only that the value is "temporally sortable" and says nothing about
  monotonicity at all.

## What this does not decide

**Edit, delete, reactions, and forwarding are out of scope.** The map places Tier 2 rich messaging
beyond the destination, and this ticket asked for decisions on all four. Rather than designing
features nobody asked for, the schema records only the constraints they will impose — cheap now, a
migration later:

- a soft delete keeps its `seq` **occupied**, so a keyset cursor never skips a slot
- a hard delete must never cascade into `receipt` or `delivery`, which point at a position rather
  than a row
- an edit rewrites a body in place and never moves a row, changes its `seq`, or changes its `id`
- a reaction is not a message and gets no `seq`
- a forwarded message is a **new** message with a reference and a **new** `seq`, never a move

## A trap worth naming

**`.default('now')` in Drizzle, where `'now'` is a JavaScript string, emits `DEFAULT 'now'`** as a
quoted literal, and PostgreSQL folds it to a constant at DDL time — every row gets the migration's
timestamp. Both `.defaultNow()` and `.default(sql\`now()\`)` are safe and emit `DEFAULT now()`.

This was originally recorded against `TIMESTAMP 'now'`, which Drizzle does not emit. The hazard is
real; the mechanism was wrong, and the distinction is the difference between a rule you can follow
and one you cannot.

## What would reverse this

**The advisory lock is the fragile part.** It is a single line that silently restores the race if it
is ever dropped, refactored away, or moved outside the transaction that inserts the message. It
carries no comment of its own and no test — which is why the client-side `COUNT(*)` reconciliation
exists as an independent net, rather than as a nicety.

If per-conversation send throughput ever becomes a real constraint, the alternatives are a hold-back
watermark over in-flight allocations, or accepting a widened window. Both are strictly worse than the
status quo for a workload whose send rate is bounded by how fast people type.

**A global `seq` leaks volume.** Sequential ids reveal message counts and permit enumeration of ids
that exist, though reading anything still requires authorisation. If that ever matters, the fix is a
random offset on the sequence rather than a different ordering scheme.