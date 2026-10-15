/**
 * The outbox relay. ADR 0057.
 *
 * ── what this is ──────────────────────────────────────────────────────────────
 *
 * `outbox` shipped in stage 1 with a reader nobody had written. This is that reader:
 * a poller, because ADR 0018 forecloses `LISTEN`/`NOTIFY` ("no `LISTEN`/`NOTIFY` […]
 * anywhere in this design") and because stage 3 targets Neon, whose pooled endpoint
 * and scale-to-zero both destroy the dedicated session a `LISTEN` needs. A
 * notification-triggered relay here would be a relay that silently stops existing.
 *
 * One pass is one transaction:
 *
 *     BEGIN
 *       SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100
 *              FOR UPDATE SKIP LOCKED          ← claim
 *       per row:  sink.publish(frame)         ← the only non-database effect
 *                  UPDATE outbox SET published_at = now() WHERE id = $1
 *                 …or: SET attempts = attempts + 1, last_error = $2 WHERE id = $1
 *     COMMIT
 *
 * ── what is in the queue ─────────────────────────────────────────────────────
 *
 * **Not only messages.** The outbox is the fan-out channel for everything ephemeral
 * that a conversation owes its members: `message.created`, `receipt.advanced` (ADR
 * 0003: "one event per advance, exactly as the outbox already delivers everything
 * else"), and the delivery acks. Only the first has a `message_seq`, so **that column
 * is NULLABLE and this file treats it as such** — the claim is unchanged by that, and
 * the routing column is `conversation_id`, `NOT NULL` for all three.
 *
 * ── three properties, and where each one lives ────────────────────────────────
 *
 * **1. Nothing is broadcast from request handling** (ADR 0004, ADR 0057, and step 7
 * of `message-lifecycle.md`). This file is the only thing in the server that calls a
 * sink, and the send transaction writes a row and returns. The alternative —
 * commit, then call the broker — has a failure mode with no recovery: the message
 * exists, the transaction succeeded, the broadcast failed, and nobody ever hears
 * about it. The outbox removes that class of bug by making "committed" and "will be
 * delivered" the same atomic fact, and *this file is where that fact gets spent*.
 *
 * **2. Two relays cannot publish the same row.** `FOR UPDATE` is what makes it
 * correct: the second relay blocks on the first relay's rows, so no row is ever
 * published twice. `SKIP LOCKED` is what makes it *parallel*, and the two do
 * different jobs — conflating them is how relays get built wrong. Plain `FOR UPDATE`
 * is sufficient and would also serialise: two relays would run at one-relay
 * throughput, and if the first died holding locks the healthy one would WAIT on the
 * dead one instead of taking over, so the redundancy would be present and unusable.
 *
 * ⚠️ **What that claim rests on, and what it does not.** The statement is asserted
 * verbatim by `relay.test.ts`, which is a real test of a real property. The
 * *behaviour* — two relays, disjoint row sets — needs two concurrent transactions,
 * and PGlite serves one connection: the second transaction WAITS rather than racing,
 * so a test written that way hangs instead of failing. That half is recorded as
 * unverified, loudly, in the same way gate G1b is. **Do not describe the
 * two-relay property as proven.**
 *
 * **3. A relay killed mid-batch re-delivers the remainder of that batch** (up to
 * 100 frames). The claim, the publishes and the marks are one transaction, so a
 * process death before COMMIT leaves every row exactly as it was — unmarked, and
 * therefore back in the working set on the next poll. This is the property the outbox
 * exists for, and it is the reason the relay publishes the payload **verbatim**
 * rather than re-deriving it: a re-derived frame is a second derivation that can
 * drift from the one the send path validated.
 *
 * ── what is deliberately NOT here ─────────────────────────────────────────────
 *
 * **No exactly-once machinery.** Not a seen-set, not a dedupe table, not a
 * `published_at` guard that is not `IS NULL`, not an idempotency key on the sink
 * call. The delivery guarantee is at-least-once and it is deliberate; correctness
 * rests on the client upserting on the client id (ADR 0005, stage 3.G), not on this
 * loop filtering. See `sink.ts` for the full argument — it is the place most likely
 * to tempt somebody into "fixing" a duplicate, and the fix is the rejected design.
 *
 * **No `LISTEN`/`NOTIFY`** (ADR 0018), **no attempt cap** (ADR 0057: a cap converts
 * a two-hour broker outage into permanently undelivered frames, a strictly worse
 * failure than a temporarily hot table), and **no new dependency** — there is no
 * broker client here because there is no broker.
 */
import { and, eq, gt, isNotNull, isNull, lt, sql as drizzleSql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { db, outbox, schema } from '@vartalap/database';
import { serverFrame } from '@vartalap/protocol';
import type { PublishSink, SinkContext } from './sink.ts';

/**
 * ADR 0057's transaction handle.
 *
 * Named rather than inlined so `deliverBatch` can be handed a transaction the CALLER
 * owns. That is what makes the "killed mid-batch" property testable without killing
 * a process: a test runs `deliverBatch` inside a transaction it then throws away,
 * and the rollback is the same event a dropped connection produces.
 */
export type OutboxTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * **100**, and ADR 0057 says in as many words that this number is judgment rather
 * than measurement — the same standing caveat ADR 0010 gives the receipt throttle.
 * Its three-sided reasoning, restated because a number with no reasoning gets
 * "tidied" within a year:
 *
 * - **Too small** (say 10) and a busy conversation keeps the relay permanently at the
 *   front of the table doing ten round trips per pass. The lock is held for the whole
 *   batch, so a small batch is many short transactions instead of few long ones.
 * - **Too large** and one batch holds row locks on thousands of rows while the sink
 *   is called sequentially, so the tail is locked long after it stopped being useful.
 *   Under at-least-once a crash re-delivers everything after the crash point, so a
 *   big batch makes that re-delivery proportionally bigger.
 * - **100** is one round trip per hundred messages at human send rates, a crash
 *   mid-batch loses at most 100 frames rather than a thousand, and the lock hold is
 *   seconds.
 *
 * If those three numbers ever disagree, the measurement wins.
 */
export const RELAY_BATCH_SIZE = 100;

/**
 * How often the loop polls. **Not decided by ADR 0057**, which says only "loop on a
 * short interval" — so this one is a choice made here rather than a decision
 * inherited, and it is the same reasoning as the batch size: a pass that claims
 * nothing is one index probe, so a short interval is cheap, while the cost of a long
 * one is latency every live frame carries. One second is the floor that latency
 * justifies at one user. Revisit it with a send rate, the way H-23 replaces the
 * rate-limiter numbers.
 */
export const POLL_INTERVAL_MS = 1_000;

/**
 * H-18's retention window, and ADR 0057's three-case rule that rests on it:
 *
 *     published                          → deleted on success
 *     unpublished, attempts > 0          → deleted 24 h after created_at
 *     unpublished, attempts = 0          → a fresh send; never purge on age alone
 *
 * **The 24 hours run from `created_at`, not from the last attempt**, and that is the
 * load-bearing choice. Anchoring on the last attempt would need a last-attempt
 * timestamp the schema does not have, and — worse — it would let a permanently
 * failing row be retried forever and never purged, which is the unbounded growth
 * this rule exists to close. Anchoring on `created_at` bounds the table
 * unconditionally.
 *
 * **What it costs, and why that is survivable:** a row that keeps failing for 24
 * hours is never broadcast. The outbox is a latency optimisation layered over a
 * durable record — the message is in `message`, and the client's catch-up query (3.D)
 * and `COUNT(*)` reconciliation (3.G, gate G4) both fetch it. Purging degrades a
 * live frame into a catch-up row. It never deletes a message.
 */
export const FAILED_ROW_RETENTION_HOURS = 24;

/** One row's outcome, in the order the batch happened. */
export interface RelayFailure {
  /** `outbox.id` — the row that is still in the working set. */
  readonly outboxId: number;
  /** The sink's own words. Also what landed in `last_error`. */
  readonly error: string;
}

/** What one poll did. Returned so a caller can log it without a second query. */
export interface RelayPass {
  /** Rows the claim locked. */
  readonly claimed: number;
  /** `outbox.id`s whose sink call returned. */
  readonly published: readonly number[];
  /** Rows whose sink call threw. Unmarked, retried on the next pass. */
  readonly failed: readonly RelayFailure[];
}

export interface RelayOptions {
  /** Defaults to {@link RELAY_BATCH_SIZE}. Overridden in tests to keep them short. */
  readonly batchSize?: number;
}

/**
 * `last_error` is the sink's message, which is the only diagnostic a permanently
 * broken row ever gets (ADR 0057) — so it is stored, not logged and dropped. An
 * `Error` gives its `message`; anything else is stringified rather than dropped,
 * because a sink that rejects with a bare string would otherwise leave the row
 * indistinguishable from one that was never attempted.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ADR 0057's claim, verbatim:
 *
 *     SELECT id, message_seq, conversation_id, payload
 *       FROM outbox
 *      WHERE published_at IS NULL
 *      ORDER BY id
 *      LIMIT 100
 *        FOR UPDATE SKIP LOCKED;
 *
 * `ORDER BY id` rather than `created_at` because `id` is the bigserial the send
 * transaction allocated, so the order rows are claimed in is send order. The frames
 * leave in the order the messages were written, which is the order they are ordered
 * in everywhere else.
 *
 * **`published_at IS NULL` and nothing else.** Not `attempts < 5`, not
 * `created_at > now() - …`: a row with no attempt cap and a failed attempt is still
 * a row that must be delivered, and the purge — not the claim — is where age and
 * attempts are read.
 *
 * ⚠️ **`message_seq` is selected and it is NULLABLE, and the WHERE clause does not
 * mention it.** The outbox carries receipt advances and delivery acks as well as
 * messages (ADR 0003: "exactly as the outbox already delivers everything else"; ADR
 * 0011: "the outbox row is the only thing fan-out and push share"), and neither has a
 * message position. The claim therefore returns `null` for those rows and publishes
 * them anyway — a frame with no position is still a frame somebody is owed, and
 * filtering it out would be at-most-once with extra steps.
 *
 * **`ORDER BY id` is still the right order with a nullable position.** The outbox is
 * a queue, not a transcript: it says *what happened next*, and every frame in it is
 * independent of the others. A receipt frame cannot be reordered relative to a
 * `message.created` by moving it later in the queue, because the client's own
 * watermark upsert (stage 3.G) is monotonic per (conversation, member) and the message
 * frame carries its own position.
 *
 * This is the one place the emitted SQL had to stop matching the ADR's listing, and it
 * does not: the listing above is still the statement this issues, `message_seq`
 * included. What changed is the column's nullability, not the claim.
 */
function claimBatch(tx: OutboxTransaction, batchSize: number) {
  return tx
    .select({
      id: outbox.id,
      messageSeq: outbox.messageSeq,
      conversationId: outbox.conversationId,
      payload: outbox.payload,
    })
    .from(outbox)
    .where(isNull(outbox.publishedAt))
    .orderBy(outbox.id)
    .limit(batchSize)
    // Correctness AND parallelism, and they are not the same clause. Dropping
    // `skipLocked` here still produces a correct relay at one-relay throughput.
    .for('update', { skipLocked: true });
}

/**
 * The row is done. One statement, one id.
 *
 * **Per row, never per batch.** A single `UPDATE … WHERE id = ANY($1)` over the
 * claimed ids is the exact bug this file's shape exists to prevent: the sink
 * publishes them one at a time and one of them can fail, so marking the whole set
 * turns a single refusal into a silent hole — the frame nobody ever receives, on a
 * row that now says it was published. `attempts` and `last_error` are left alone:
 * they are history, and a published row that had failed three times before it
 * succeeded should say so until the purge deletes it.
 */
function markPublished(tx: OutboxTransaction, id: number) {
  return tx.update(outbox).set({ publishedAt: drizzleSql`now()` }).where(eq(outbox.id, id));
}

/**
 * The row is still owed. `published_at` stays NULL — **that is the whole failure
 * path**, because NULL is what the claim reads, so the row returns to the working set
 * on the next pass. Nothing is marked done here, and no attempt cap is applied.
 */
function markFailed(tx: OutboxTransaction, id: number, error: string) {
  return tx
    .update(outbox)
    .set({ attempts: drizzleSql`${outbox.attempts} + 1`, lastError: error })
    .where(eq(outbox.id, id));
}

/**
 * Claim a batch, publish it, and record each row's outcome — **inside the
 * transaction the caller owns.**
 *
 * Split out from {@link relayOnce} for one reason: it makes the transaction boundary
 * observable from a test. A relay killed mid-batch is, from the database's point of
 * view, a batch whose COMMIT never happened, and that is reproducible without killing
 * anything — run this inside a transaction, then throw.
 *
 * ── why a refused row does not abandon the batch ──────────────────────────────
 *
 * A sink call that throws is **one frame the sink did not take**, not a reason to
 * abandon the other ninety-nine and roll the whole transaction back. Recording the
 * refusal and continuing means a single poison payload costs its own retry and
 * nothing else; the alternative makes every row behind it wait for it, which is how
 * one undeliverable frame becomes a stalled conversation.
 *
 * The cost is real and is the batch-size argument's other side: the rows published
 * before the refusal are marked, so a kill later still re-delivers only what the
 * sink refused *and* what came after the next commit. Under at-least-once that is a
 * duplicate count, not a loss — see the header.
 *
 * **Only sink failures are caught.** A failure of `markPublished` or `markFailed` is
 * a database failure, and it propagates: it rolls the whole batch back, which
 * re-delivers it, which is correct. Swallowing it into "this row failed" would turn
 * a broken database into a quiet one that quietly does nothing.
 */
export async function deliverBatch(
  tx: OutboxTransaction,
  sink: PublishSink,
  options: RelayOptions = {},
): Promise<RelayPass> {
  const rows = await claimBatch(tx, options.batchSize ?? RELAY_BATCH_SIZE);

  const published: number[] = [];
  const failed: RelayFailure[] = [];

  for (const row of rows) {
    // `messageSeq` is handed over exactly as the row holds it, including `null`. It is
    // NOT defaulted, not skipped, and not a reason to treat the row as unpublishable:
    // `conversation_id` is what routes the frame, it is `NOT NULL` for every frame
    // type, and a null `message_seq` means this row publishes a receipt or a delivery
    // frame rather than a message. Defaulting it to `0` would hand the sink a position
    // that never existed, and `0` is a real position — it sits before the first
    // message.
    const context: SinkContext = {
      outboxId: row.id,
      messageSeq: row.messageSeq,
      conversationId: row.conversationId,
    };

    let failure: string | null = null;
    try {
      // Parsed, not re-derived. `payload` IS the frame — one object, validated by
      // the send path before it was written — and this parse is a check that what
      // the row holds still satisfies `packages/protocol`, not a second
      // construction. It is inside the `try` on purpose: a row whose payload no
      // longer parses is a frame that must NOT be broadcast, and recording it as a
      // failed attempt with the parse error in `last_error` is a loud, diagnosable
      // state. Letting it throw would roll back the batch and re-publish the other
      // ninety-nine on every pass, forever, with nothing in the database to show why.
      await sink.publish(serverFrame.parse(row.payload), context);
    } catch (error) {
      failure = describeError(error);
    }

    if (failure === null) {
      await markPublished(tx, row.id);
      published.push(row.id);
    } else {
      await markFailed(tx, row.id, failure);
      failed.push({ outboxId: row.id, error: failure });
    }
  }
  return { claimed: rows.length, published, failed };
}

/**
 * One poll: claim, publish, mark, commit.
 *
 * **A function, not a daemon.** Nothing here loops, schedules, or keeps a handle —
 * the loop is {@link startRelay}, and a test calls this one directly. A relay whose
 * lifetime is a side effect of importing it is a relay a test cannot stop, and a
 * stopped-at-exit timer is a relay that silently stops relaying.
 */
export function relayOnce(sink: PublishSink, options: RelayOptions = {}): Promise<RelayPass> {
  return db.transaction((tx) => deliverBatch(tx, sink, options));
}

/** What a {@link purgeOutbox} pass collected. */
export interface PurgeResult {
  /** Published rows deleted. */
  readonly published: number;
  /** Unpublished, attempted, and older than the window. */
  readonly expiredFailures: number;
}

/**
 * The outbox purge. H-18, as expressible by ADR 0057's three-case rule.
 *
 * **Separate from {@link relayOnce} on purpose.** "Deleted on success" and "set
 * `published_at` on success" are two different statements and they mean different
 * things: the first is retention policy, the second is the durable record of a
 * delivery that happened. A relay that deleted inline would make `published_at` a
 * column nothing ever sets — and it would delete the evidence H-17's outbox-lag
 * metric and any post-mortem need, at exactly the moment somebody wants to read it.
 * So the relay marks, and the purge collects: a row published at 12:00 is deleted by
 * the next purge pass, and a relay that dies between the two costs one duplicate-free
 * row of delay and nothing else.
 *
 * The two deletes are the rule's first two lines. The third — an unpublished row
 * with `attempts = 0` is a fresh send and is never purged on age — is enforced by the
 * `gt(outbox.attempts, 0)` below, and is the reason this function cannot be written
 * as "delete everything unpublished and old".
 *
 * ⚠️ **Both deletes are unbounded.** At a hundred rows a day this is a non-event; at
 * a hundred thousand it is a table-wide lock taken in one transaction. When the
 * volume arrives, batch it — and do it with `SKIP LOCKED` like the relay, for the
 * same reason.
 */
export function purgeOutbox(): Promise<PurgeResult> {
  return db.transaction(async (tx) => {
    const published = await tx
      .delete(outbox)
      .where(isNotNull(outbox.publishedAt))
      .returning({ id: outbox.id });

    const expiredFailures = await tx
      .delete(outbox)
      .where(
        and(
          isNull(outbox.publishedAt),
          // A row the relay has never touched is a fresh send, not a failure. This
          // is the clause that makes H-17's outbox-lag metric queryable too: the
          // two rules read the same column for the same reason.
          gt(outbox.attempts, 0),
          // The server's clock, not this process's — and the window anchored on
          // `created_at`, which is ADR 0057's load-bearing choice. Purging from the
          // last attempt instead would let a permanently failing row be retried
          // forever and never deleted, which is the unbounded growth H-18 exists to
          // close.
          lt(
            outbox.createdAt,
            drizzleSql`now() - (${FAILED_ROW_RETENTION_HOURS} * interval '1 hour')`,
          ),
        ),
      )
      .returning({ id: outbox.id });

    return { published: published.length, expiredFailures: expiredFailures.length };
  });
}

export interface RelayHandle {
  /**
   * Stop after the current pass. Synchronous on purpose: a shutdown that has to be
   * awaited is a shutdown that can hang, and the pass already in flight finishes on
   * its own transaction either way.
   */
  stop(): void;
}

export interface StartRelayOptions extends RelayOptions {
  readonly intervalMs?: number;
  /** Called with each pass's result. Errors are swallowed unless `onError` is set. */
  readonly onPass?: (pass: RelayPass) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * The loop ADR 0057 asks for: "loop on a short interval".
 *
 * **It is here so the relay is a relay and not just a function**, and it is
 * deliberately small — a timer and a stopped flag. It adds no scheduling policy, no
 * adaptive interval, no jitter and no backoff, because each of those is a decision
 * nobody has made: a jittered poll exists to stop a fleet of relays stampeding a
 * database on resume, which is a real concern and a real ADR, and neither is this.
 *
 * **The first pass is deferred by a tick** so `startRelay` returns before it touches
 * the database. A caller that starts a relay and immediately asserts on it gets a
 * race, and a race that passes on a fast machine is a test that lies on a slow one.
 *
 * A thrown pass is reported and the loop continues. The alternative — stop on the
 * first error — turns one transient database blip into a relay that stays down until
 * somebody notices, which is the failure ADR 0004 exists to make impossible.
 */
export function startRelay(sink: PublishSink, options: StartRelayOptions = {}): RelayHandle {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pass = async (): Promise<void> => {
    if (stopped) return;
    try {
      options.onPass?.(await relayOnce(sink, options));
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) timer = setTimeout(() => void pass(), intervalMs);
  };

  timer = setTimeout(() => void pass(), 0);

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
