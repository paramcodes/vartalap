# Message ordering and pagination

How a transcript gets its order, how a page of it is fetched, and the one race that ordering cannot
fully solve — which turns out to be solvable by making it impossible.

Read this after [the message lifecycle](./message-lifecycle.md), which fixes that a server-assigned
position exists and that clients cannot influence it. This document fixes what that position *is*.

The decisions are recorded in [`docs/adr/0005`](../adr/0005-message-ordering.md).

---

## Two columns, one of them the primary key

```
seq  bigint  PRIMARY KEY       -- server-assigned; orders and paginates
id   uuid    NOT NULL UNIQUE   -- client-generated; identity and idempotency key
```

The message lifecycle established that the client's UUIDv7 is the message's identity and its
idempotency key. It did not say what sorts the transcript. Those are different jobs and the answer is
a second column.

`seq` is the primary key rather than `id` because it is an 8-byte key already in insertion order,
so a keyset page scans the index without touching the heap. The dedupe constraint is identical either
way — `UNIQUE (id)` dedupes just as well as a primary key — so this is purely about index behaviour.
It also has a pleasant side effect: a `bigint` row id tells you nothing, which makes an `EXPLAIN`
easier to read.

**`seq` is global, not per-conversation.** An earlier draft of the lifecycle document said
per-conversation. That was wrong, and the reason is worth recording because the per-conversation
version looks tidier:

Positions only compare within a conversation, so per-conversation sequences mean there is no total
order across conversations and therefore **no global cursor**. Catching up after a reconnect would
need one query per conversation. A global `seq` *is* the cursor, and reconnect becomes one query.

---

## What is never a sort key

**`created_at`.** `now()` returns `transaction_timestamp()` — the time the transaction *started*. So
every row written in one transaction carries an identical stamp, which makes `(created_at, id)`
degenerate into `id` with an extra column in the index. Worse, a transaction that begins at T and
commits at T+5s stamps all of its rows T, so a client that loaded history at T+2s sees those rows
sorted *below* ones it already holds. It is stored for display and never for order.

**Client timestamps.** Device clocks drift, and users can set them. A member whose clock is an hour
fast would reorder their own messages.

**`uuidv7()`.** It exists in PostgreSQL 18 and looks ideal — time-ordered, no round trip. But its
ordering guarantee is narrower than it appears. The implementation uses RFC 9562's Method 3, storing
a 12-bit sub-millisecond fraction in `rand_a`, backed by a process-local `static int64 previous_ns`.
The source comment states the guarantee holds "on this backend" — and across a connection pool it
does not. On macOS and MSVC builds, two bits of `rand_a` are XOR-mixed with random output, so strict
monotonicity fails even within one backend. The official documentation claims only that the value is
"temporally sortable" and says nothing about monotonicity at all.

The UUID is still the right *identity*. It is simply not the *order*.

**`OFFSET`.** Under concurrent inserts, page three is not the same fifty rows it was a second ago.

---

## Pagination: keyset, both directions

```
backwards   WHERE conversation_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 50
forwards    WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC  LIMIT 50
```

The client keeps a cursor per conversation, in Dexie, so it survives a reload. Both directions are
keyset because both are real: backwards is history, and forwards is what a member scrolled up in the
middle of a conversation needs in order to reach the present without reloading everything.

Fifty rows is roughly a screen and a half of a busy conversation. The exact number matters less than
it being a constant.

---

## The commit-inversion race

A sequence allocates at **insert**. A row becomes visible at **commit**. So a transaction can take
`seq = 100` and stall while another takes `101` and commits. A client sees 101, has never seen 100,
and paging backwards from 101 skips 100 — not temporarily, **permanently**, because its cursor has
moved past a row that did not exist yet.

PostgreSQL documents both halves. Sequences are not gapless — `nextval` "is not reclaimed for re-use
if the calling transaction later aborts" — and a query "sees only data committed before the query
began". Kafka's consumer documentation describes the identical consumer-side hazard: if a committed
offset gets ahead of the consumed position, it "results in missing records".

Debezium's PostgreSQL connector hits the same failure and says so directly:

> Because logical decoding replication slots publish changes during commit — and not post commit —
> undesirable side-effects can occur… a DebeziumEngine consumer receives a notification of a row that
> was created but it cannot be read by a transaction.

Its resolution is not to derive a cursor from the row's own id, but from a log position assigned at
commit. **We cannot use a log position**, so we remove the window instead.

### The observation that makes it simple

**Inversion only hurts when both messages are in the same conversation.** If `seq=100` is in
conversation A and `seq=101` is in conversation B, then a client paging conversation B backwards never
encounters 100 at all — there is no gap in that history view. The cross-conversation case is harmless
by construction and always has been.

Which means the harmful case is exactly: *two inserts into one conversation, in flight at the same
time.* Serialise that and the race ceases to exist.

```sql
BEGIN;
  SELECT pg_advisory_xact_lock(<int64 derived from conversation_id>);
  INSERT INTO message (id, conversation_id, author_id, body, client_created_at) VALUES (...);
  INSERT INTO outbox   (...) VALUES (...);
COMMIT;
```

The tables are **singular**: `message` and `conversation`, not `messages` and `conversations`. That
is what the migration creates and therefore what the code runs against. Prose written before it
landed says `messages.seq`, and that SQL does not parse.

The insert supplies `client_created_at` explicitly because the table has **two** timestamps and only
one of them can be defaulted by the server:

| column | whose clock | why it is never a sort key |
|---|---|---|
| `client_created_at` | the **client's**, sent with the request | device clocks drift and users set them |
| `created_at` | the **server's**, `DEFAULT now()` | `now()` is `transaction_timestamp()`, so it is degenerate within a transaction — [above](#what-is-never-a-sort-key) |

`client_created_at` is `NOT NULL` with no default. A send that supplies only `created_at` violates it,
the insert fails, and the failure takes the outbox row down with it — the one guarantee
[0004](../adr/0004-message-durability.md) exists to provide.

The lock is transaction-scoped, so it releases itself at commit or rollback with nothing to remember.
Readers do not see it and do not contend with it. Different conversations never collide. And a single
message send touches exactly one conversation, so there is no lock-ordering to get wrong and no
deadlock to reason about.

The cost is one in-flight send per conversation. At the rate humans type, that is not a constraint,
and different conversations remain entirely parallel — the only kind of parallelism a chat workload
has ever needed.

### The net under the net

The advisory lock is one line of SQL carrying the entire guarantee, which makes it the kind of thing
a well-meaning refactor deletes without knowing what it was for. So the client checks independently:

> After catch-up completes, compare the number of messages held for a conversation against the
> server's `COUNT(*)`.

One missing row is invisible until two numbers disagree, and neither number depends on how densely
the sequence is packed.

**Do not** try to detect this by comparing `max(seq) - min(seq)` against `count(*)`. That check looks
obvious and is **unsound**: a rolled-back transaction burns its sequence value, so a conversation's
messages can legitimately be 100, 101, 102, **105**. Span exceeding count is the normal case, not a
signal. A monitor built on it either cries wolf forever or is muted inside a week.

---

## Constraints recorded for features that are not in v1

Edit, delete, reactions, and forwarding are Tier 2 and beyond this effort's destination. They are
listed here only because the schema must not paint itself into a corner for free:

- a soft delete keeps its `seq` **occupied**, so a keyset cursor never skips a slot
- a hard delete must never cascade into `receipt` or `delivery` — both point at a position, not a row
- an edit rewrites a body in place and never moves a row, changes its `seq`, or changes its `id`
- a reaction is not a message and gets no `seq`
- a forwarded message is a **new** message with a reference and a **new** `seq`, never a move

None of that designs a feature. Each line is cheaper now than as a migration.

---

## One trap in the ORM

**`.default('now')`, where `'now'` is a JavaScript string, emits `DEFAULT 'now'` as a quoted
literal** — and PostgreSQL folds it to a constant at DDL time, so every row receives the migration's
timestamp. Both `.defaultNow()` and `.default(sql\`now()\`)` are safe and emit `DEFAULT now()`.

The distinction is the whole point: one of these looks like a function call and is not, and the
failure is invisible until every row in a table shares a timestamp.