# Stage 4 — reading and liveness

The operational plan for stage 4. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**. Read [`docs/decisions-index.md`](../decisions-index.md) first, then
ADR [0006](../adr/0006-presence.md) for why presence lives where it lives.

**State at the time of writing:** stage 3 is committed. The watermarks this stage is named for
already exist — `delivery` and `receipt` as monotonic upserts server-side (3.E), stored monotone
client-side (3.G), `Seen` derived over `shared_through` and never stored. What stage 4 adds is
**liveness**: presence and typing. Neither is durable, neither is on the write path, and neither
existed anywhere in the tree before this stage.

---

## The two gates

| Gate | Guarantee | Proved by |
|---|---|---|
| **P1** | Presence means "connected within the last 45 seconds" — alive refreshes it, silence lets it lapse, and a list paints from one `MGET`. | 4.A |
| **P2** | Typing never exceeds one event per 2 seconds per conversation, expires without a server round trip, is never persisted anywhere, and a stale frame discarded by its receiver can never render. | 4.B |

A gate is not done because the code runs; it is done because a named test fails when the
guarantee is broken — the same rule stage 3 kept.

### The environment, honestly

This machine has no Redis server, no Redis client module, no Centrifugo, and no socket of any
kind. ADR 0006 says presence is "a property of the connection", and there is no connection yet —
the socket arrives with the thin interface in stage 6 at the earliest, and Centrifugo with
stage 7. So stage 4 proves the **logic** and records the **wiring** as unwritten, exactly the way
stage 3 proved the relay against a recording sink:

- Presence is built against a small TTL-store interface. If the userland `redis-server` install
  currently running succeeds, the same tests run against real TTL expiry; if it fails, they run
  against a fake with a virtual clock, and the Redis backing is recorded as unwritten rather
  than faked-into-existence.
- Typing's throttle and expiry are client logic with no server round trip by design, so they are
  fully provable headlessly. Typing fan-out needs the socket and is recorded unwritten.
- A fake whose semantics drift from Redis is worse than no fake. The interface carries exactly
  the four operations presence needs (`SETEX`, `GET`, `MGET`, `DEL`) and nothing else, so the
  surface that could drift is four commands wide.

---

## Units

### 4.A — Presence

Per ADR 0006, verbatim where it matters:

- `presence:<userId>` with a **45-second TTL**, refreshed from **connection liveness** — the
  server observing a live connection, never a client-side JS timer. Browsers throttle timers in
  background tabs; WebSocket keepalives are protocol-level and are not throttled. A heartbeat
  that reports a background tab as offline is the worst possible failure for a green dot, and
  this unit exists to make it structurally impossible rather than carefully avoided.
- "Connected now" means connected within the last 45 seconds. The glossary says so; the code
  must not know any other definition.
- The interface reads with `MGET` (fifty conversations, one round trip) and subscribes to stay
  true. Subscription-only and batch-only are each wrong alone, and neither failure is visible
  until production — so both paths are built here, with the subscription half against the same
  stand-in discipline stage 3 used for the relay sink.
- **Last-seen is out of v1.** Declined in 0006 with the reasoning recorded. If a presence-adjacent
  timestamp appears anywhere in this unit — a `lastSeen`, a `seenAt`, an `onlineAt` — that is a
  bug, not a feature, and the glossary already bans the word from every schema.

**Done when:** P1 passes — killing the refresh lets the key lapse and the member reads offline;
refreshing keeps them online past any number of 45-second windows; one `MGET` paints a mixed
list correctly — and each is proved by breaking it (stop the refresh, shorten the TTL, drop a
key from the batch) and watching the test fail.

### 4.B — Typing

Per ADR 0006 and `presence-and-typing.md`:

- At most **one event every two seconds** per conversation, and only when the text actually
  changed. The throttle lives in `apps/web`, headless and fully tested — it needs no server and
  by design must not consult one.
- Expiry is on a **client timer** and is the client's own business: a typing indicator that
  needed a server round trip to disappear would linger through every partition.
- **Never persisted.** Not in Postgres, not in Dexie, not in Redis. `store-structure.test.ts`
  already fails the build for tables nobody declared; a typing write to any of them must fail
  the same way.
- **A stale frame is discarded by its receiver.** Frames carry a timestamp and a client
  identifier; a reconnect must never replay "X was typing" from before the partition. If typing
  were durable this would be a bug report; because it is not, it is a receiver rule, and it
  needs a test with an old frame, not a comment.
- Typing fan-out rides the socket, which does not exist. Recorded unwritten, with the frame
  shapes (which already exist in protocol) as the contract the socket will carry.

**Done when:** P2 passes — a burst of keystrokes emits once, unchanged text emits nothing, the
indicator clears without any server contact, nothing lands in any table, and a frame older
than its expiry is discarded — each proved by breaking it.

### 4.C — The watermark reconciliation

Stage 4 is named for reading as well as liveness, so before it closes, prove there is nothing
left of the reading half: every receipt and delivery behaviour the ADRs require exists
server-side (3.E), client-side (3.G), and on the wire (3.F2), and the only receipt triggers
not built are the ones that need an interface — advancing to the end on open, debounced
backward-scroll receipts — which belong to stage 6 and are recorded there, not here. If 4.C
finds a gap that does not need a UI, it becomes a unit; if it finds none, it says so and
closes the stage. A unit that concludes "nothing to build" is an honest result, not a skipped
one.

---

## Sequence

```
4.A ──▶ 4.B ──▶ 4.C ──▶ stage 5
```

4.A and 4.B touch disjoint files and may run in parallel once the Redis question is settled —
4.A's tests target a real server if the install succeeded and a fake if it did not, and that
determination has to happen before 4.A starts or its tests prove the wrong thing.

## Rules for every unit

- One commit per unit, and the commit lands with its tests green.
- No new dependency without an ADR saying why. The current leaning is a zero-dependency RESP
  client over `Bun` TCP for the four TTL commands, rather than `ioredis` — and if the command
  surface ever grows past TTL operations, that decision reverses and the ADR says so.
- Do not document a guarantee as proven when its gate has not run. The socket-dependent halves
  (presence subscription delivery, typing fan-out) are recorded unwritten, not proved.
- If a unit discovers that a decision is wrong, stop and write the ADR that changes it. Do not
  work around it in code.
