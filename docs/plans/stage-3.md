# Stage 3 — the durable spine

The operational plan for stage 3. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**. Read [`docs/decisions-index.md`](../decisions-index.md) first, then
ADR [0054](../adr/0054-build-the-spine-first.md) for why this stage exists.

**State at the time of writing:** stages 1 and 2 are committed. `apps/` does not exist. There is no
server, no test harness, and no send or read path. Stage 3 starts from zero lines of server code.

---

## The four gates

ADR 0054 names the four things in this stage worth testing hardest. They are the definition of done.
A gate is **not** done because the code runs; it is done because a named test fails when the
guarantee is broken.

| Gate | Guarantee | Proved by |
|---|---|---|
| **G1** | Within a conversation, commit order equals `seq` order. No inversions. | 3.C |
| **G2** | A receipt or delivery watermark never regresses, under any arrival order. | 3.E |
| **G3** | Live frame, catch-up row, and own-echo all write through one function, and none can duplicate or overwrite a position. | 3.G |
| **G4** | A permanently skipped message row is detected by `COUNT(*)` and recovered. | 3.D (server half), 3.G (client half) |

### G1 is proved in two layers, and the reason is the machine

ADR 0005 says the advisory lock "carries no comment of its own **and no test** — which is why the
client-side `COUNT(*)` reconciliation exists as an independent net." That test does not exist yet,
and on this machine it cannot be proved the obvious way.

This machine has **no Postgres server binary, no Docker, no podman, and no root**. `psql` and
`postgresql-libs` are installed; the server is not. The only available database is PGlite — Postgres
compiled to WASM — served over a single connection by `scripts/db-local.ts`. PGlite cannot host two
genuinely concurrent transactions, so a race cannot fire there, and a test that "passes" on PGlite
has proved nothing about concurrency.

So G1 is two tests, and the distinction is recorded rather than blurred:

- **G1a — runs everywhere.** Asserts the send path *issues* `pg_advisory_xact_lock` with the
  documented derivation, inside the transaction that inserts the message, before the insert.
  Proved by intercepting the SQL the client emits and asserting statement order and transaction
  boundaries. This is a real test of a real property; it cannot tell you the lock was not dropped.
- **G1b — requires real Postgres.** Fires genuinely concurrent sends into one conversation and
  asserts no inversion. Skips loudly — and is recorded as an open gap — when `DATABASE_URL` points
  at PGlite. It runs the moment a real server is available, including Neon.

**A G1b that has never run is not a pass.** It is recorded as unverified, in the same way the
decisions index already carries unverified claims. Nothing in stage 3 may describe the ordering
guarantee as proven while G1b is unrun.

---

## Units

Each unit ends in a committed, runnable, verifiable state. Nothing is stacked on unverified work.

### 3.A — Foundation

The harness everything else is proved with. Blocking.

- `bun:test` wired up: a `test` script per package, a DB fixture that uses an existing
  `DATABASE_URL` when one is set and boots PGlite otherwise, and truncates between tests.
- One `.env` at the repo root, loaded by every entrypoint. `@vartalap/database` throws at import
  without `DATABASE_URL` and nothing currently loads `.env`.
- `apps/realtime`: a thin `Bun.serve` shell with the Better Auth handler mounted and a
  `requireSession` that turns a cookie into a user id. No framework — six routes do not need one.

**Done when:** an unauthenticated request to a protected route is `401`, an authenticated one
returns the right user id, and `bun test` runs green on a trivial assertion.

### 3.B — Reconciliation

The shipped schema and protocol contradict the ADRs in about a dozen places, and stage 3 is the
first code to touch those tables. Fixing it now is cheap; fixing it after a send path exists is a
migration on live data. Blocking on 3.C, 3.D, 3.E.

Schema, via migration:

- Drop `receipt_shared_le_read`. ADR 0010 forbids it: the invariant is about how a row is written.
- Add `outbox.attempts` and `outbox.last_error`, so "failed" is distinguishable from "never
  attempted" and the 24-hour purge rule is expressible.
- `outbox.message_seq` FK from `ON DELETE CASCADE` to `ON DELETE NO ACTION`. A hard delete must not
  silently drop an undelivered send — the same rule 0004 states for watermarks.

Protocol:

- `sendMessageRequest` gains `conversationId`, matching every other payload in the file.
- An error envelope, so `409` and Postgres codes have a shape.
- Client-side `messageState` split: stored states are narrower than rendered states.
- `catchUpQuery` / `catchUpPage` — the global reconnect cursor has no schema today.
- Request bodies for receipt advance and delivery ack.

Docs, because the repo's convention is that an ADR is binding and code must not contradict it:

- ADR 0003: `Seen` is computed over `shared_through`, not `read_through`.
- ADR 0004: fix the `read_through >= delivered_through` typo and the stale "positions are
  server-assigned per conversation".
- `message-receipts.md`: the DDL is nullable and omits `updated_at`; the shipped table is right.
- SQL in 0005 and `message-ordering.md`: `messages` → `message`, `conversations` → `conversation`.

New ADRs, for the things this stage must decide and the docs leave open:

- the advisory lock's `int64` derivation, which every document leaves as a placeholder
- the relay's execution model, which no document states
- the send endpoint's shape
- `receipt.sharing` as a transport signal rather than the mechanism

**Done when:** `bun run db:setup` migrates an existing database cleanly, `bun run typecheck` passes,
every test still passes, and `docs/decisions-index.md` lists the new ADRs.

### 3.C — The send path

Gate G1.

- The lock, the derivation, and the transaction: lock → insert message → insert outbox → update
  `conversation.last_seq` → commit. One transaction. Commit before responding.
- Dedupe: `23505` on `message_id_key` is re-read and returned as `deduplicated: true`.
- `409` when the same key arrives with different content.
- The minimum needed to have something to send into: a direct conversation and its members. **This
  is not stage 5.** Stage 5 is blocks, leaving, and rejoining. Stage 3 needs a fixture.

**Done when:** G1a and G1b exist and pass or skip loudly; dedupe returns the original row with its
position; `409` fires only on a content mismatch; nothing is broadcast from request handling.

### 3.D — History and catch-up

Gate G4, server half.

- Keyset pagination in both directions, page size 50, no `OFFSET` anywhere.
- `historyPage` with `latestSeq` and `totalCount` — the reconciliation net.
- The global catch-up query, scoped to the member's conversations, keyed on the account cursor.

**Done when:** backward and forward pages are correct under concurrent inserts, a short page
terminates the loop, and `totalCount` is the conversation's `COUNT(*)`.

### 3.E — Receipts and delivery

Gate G2.

- `GREATEST` in the upsert. Absolute positions from the client, never deltas.
- `shared_through` freezes while `sharing` is off and resumes from the frozen value.

**Done when:** out-of-order and duplicated acks never regress a watermark; a device clock jumping
backwards changes nothing; sharing off then on reveals no gap.

### 3.F — The outbox relay

- Polling, `FOR UPDATE SKIP LOCKED` in batches, so two relays cannot double-publish.
- A pluggable sink. Centrifugo is not installed and is not stage 3; the sink is an interface with a
  recording implementation, which is what makes the relay testable at all.
- `published_at` on success, `attempts` and `last_error` on failure, purge on success.

**Done when:** nothing is broadcast from request handling; a relay killed mid-batch re-delivers;
a duplicate publish is harmless because the client upserts on the client id.

### 3.G — The client data layer

Gates G3 and G4, client half.

- `apps/web` containing a data layer and nothing else. No interface until stage 6 — but the
  invariant is only provable here, with `fake-indexeddb`, and it is the invariant that rots.
- Optimistic send: the Dexie row is written with `seq: null` **before any network call**, and the
  send queue is `messages where state = 'queued'` — a query, not a second table.
- **One** receive write path, used by live frames, catch-up rows, and own-echo.
- The catch-up loop and the cursor, advancing only past rows that persisted.
- `COUNT(*)` reconciliation after catch-up, and a recovery for the mismatch case that no document
  specifies.

**Done when:** G3 and G4 pass; an own-echo does not duplicate a row; a position already set is
never overwritten; a deliberately skipped row is detected and recovered.

---

## Sequence

```
3.A ──▶ 3.B ──▶ 3.C ──┬──▶ 3.D ──┐
                      ├──▶ 3.E ──┼──▶ integration pass ──▶ stage 4
                      ├──▶ 3.F ──┤
                      └──▶ 3.G ──┘
```

3.C carries the test fixture that 3.D, 3.E, 3.F, and 3.G all need, so it goes first. After it, the
four remaining units touch disjoint files and can run in parallel.

## Rules for every unit

- One commit per unit, and the commit lands with its tests green.
- No new dependency without an ADR saying why. The bias is deletion.
- Do not document a guarantee as proven when its gate has not run.
- If a unit discovers that a decision is wrong, stop and write the ADR that changes it. Do not
  work around it in code.