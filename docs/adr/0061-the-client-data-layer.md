# 0061. The client data layer: one table, one write path, one cursor

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Build the spine first" — the client half of the durable spine, gates G3 and G4
**Extends:** [0004](0004-message-durability.md), [0005](0005-message-ordering.md), [0010](0010-receipt-mechanics.md), [0060](0060-stored-state-is-narrow-and-derived-state-is-wide.md)
**Teaches:** [`docs/concepts/message-lifecycle.md`](../concepts/message-lifecycle.md)

## Context

Stage 3 proves the spine before any surface exists, and the client half of that
proof cannot be a component — there is no interface until stage 6. What can be
proved headlessly, with `fake-indexeddb`, is the data layer: the optimistic
send, the single receive write path, and the cursor reconciliation. Gate G3 is
the invariant that rots — a frame carrying your own message is the normal case,
not the edge case, and code that treats it as an insert duplicates the message
in the transcript, invisibly, until someone sends from two tabs. It is only
provable here.

`apps/web` therefore contains a data layer and nothing else. No interface, no
styles, no routes. The UI is stage 6's problem; this ADR is about what it will
stand on.

## Decision

Dexie owns message state. Five tables: `messages`, `drafts`, `receipts`,
`deliveries`, `cursor`, and `discrepancies` — each a different fact with a
different name, because two stores holding the same fact is two sources of
truth.

### The send queue is a query, not a table

`messages where state = 'queued'`. No second table, no promotion step: the
pending row *is* the send queue. Steps 3–5 of the send (write the row with
`seq: null`, clear the draft, empty the composer) are one Dexie transaction and
nothing between them awaits anything, because anything that awaits is a thing
the member waits for.

Per [0060](0060-stored-state-is-narrow-and-derived-state-is-wide.md) the stored
state is `queued | inFlight | failed`; `sent` is derived from `seq !== null`
and `delivered`/`read` from watermarks, never stored on the row. Unpositioned
rows sort after everything positioned, ordered among themselves by client
creation time — never a provisional position interpolated from client time,
which reads as a bug even when it is behaving correctly.

Retry is the composer's ladder — `1s → 2s → 5s → 10s → 30s → 60s`, capped,
±20% jitter — and it retries forever on retryable failures while never
converting a wait into a failure. A manual `Try again` reuses the same
idempotency key, which is precisely what makes it safe. The ladder's numbers
are judgment, recorded as such, in the standing of this repo's other
unverifiable numbers.

### There is exactly one receive write path, and that is structural

`MessageStore.applyReceived` serves the live socket frame, the catch-up page
row, and the send response. It assigns `seq` if and only if currently `null`,
upserts on the client id, never treats an update as an insert, and writes only
`seq` and `state` onto an existing row. Nothing replaces a conversation
wholesale.

"One function" as a convention rots the moment a second caller seems
convenient, so it is enforced as a property of the module graph instead:
`store-structure.test.ts` fails the build unless the write path has exactly
three call sites, unless `store.ts` is the only module importing Dexie, and
unless no module but the store assigns a position. A second write path is a
type error and a failing test, not a code-review question.

### The cursor advances only past rows that persisted

One cursor for the whole account — `seq` is a single global column, which is
the entire point of [0005](0005-message-ordering.md). The loop runs until a
short page. A refused row stops the cursor before it rather than moving it
past, because a frame that fails to write must not move the cursor or the gap
becomes silent and permanent. A brand-new browser has no cursor and `0` means
full catch-up; the per-conversation `COUNT(*)` reconciliation is what makes
that safe rather than merely expensive.

### Reconciliation on mismatch: refetch from the floor, then record

No document specified what the client does when the counts disagree, so this
ADR does: refetch that conversation's history from the **lowest `seq` it
holds**, write every row through the one receive path, and reconcile **once**
more. If it still disagrees, the client discards nothing, retries nothing on a
loop, and does not claim to be caught up — it records the discrepancy where a
human can see it (`discrepancies`, plus `console.error` until stage 6 renders
it) and leaves the messages it holds.

Each clause is a refusal. A silent refetch loop is a battery and bandwidth
drain; discarding is a lie; pretending to be caught up is worse than both. A
recovery that added nothing could not reach the gap, so the client is behind by
more than its floor rather than one row short of correct — and the row says
that.

### Watermarks are stored monotone, on both sides

`receipts` holds both positions with the server's `GREATEST` repeated locally;
`deliveries` holds one position the same way. `read` renders over
`sharedThrough`, never `readThrough` — the receipt frame carries both and the
private one must never gate a predicate another member observes (trap 14).
`delivered` renders over the stored delivery watermark, which is what the
`delivery.acked` server frame feeds.

## Consequences

- **The interface renders from the tables via `liveQuery`, never from component
  state.** Two tabs share one Dexie, so one send queue and one transcript —
  and a tab holding a copy in memory shows a ghost whose position has already
  moved. This ADR does not build that rendering; it makes it possible.
- **`fake-indexeddb` is a dependency because G3 is otherwise unprovable.**
  There is no other addition: no HTTP client library (`fetch` is enough), no
  state framework (the tables are the state). `dexie` is the client cache the
  decisions index already names.
- **The store's surface is closed.** `store-structure.test.ts` pins the exact
  public methods; a new capability arrives as a method on the store, reviewed
  against that list, or not at all.

## What would reverse this

**A second client platform with its own storage.** The Dexie schema is a
browser decision; a native client replays the same protocol against its own
store, and any divergence in the rules above — the no-op definition, the floor
direction, the discrepancy limit — becomes a platform that disagrees with this
one about what happened. That is when these rules graduate from "this store's
behaviour" to a shared specification with conformance tests.

**Outgrowing IndexedDB.** The cursor, the discrepancies and the watermarks are
small; the transcript is the only table that grows without bound, and a
conversation whose history exceeds what a browser should hold needs eviction —
which is a second source of truth about what this browser holds, and needs its
own ADR.
