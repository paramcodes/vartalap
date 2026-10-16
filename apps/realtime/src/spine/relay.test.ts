/**
 * The outbox relay — ADR 0057 — and the property it exists for.
 *
 *     bun run test
 *     TEST_DATABASE_URL=postgres://… bun run test      # and the concurrency half runs
 *
 * ── what is proved here, and what is not ──────────────────────────────────────
 *
 * Proved here, on PGlite, against real rows:
 *
 *   - the claim statement is ADR 0057's, `FOR UPDATE SKIP LOCKED` included;
 *   - each row is marked on its OWN statement, so a refused frame is not marked
 *     published by the batch around it;
 *   - a relay killed mid-batch re-delivers the whole batch, because a publish is not
 *     a durable fact until the transaction that recorded it commits;
 *   - a row is never published twice across two sequential polls, and a row already
 *     published is never claimed;
 *   - a refusal increments `attempts`, records `last_error`, and leaves
 *     `published_at` NULL — and the next poll delivers it;
 *   - H-18's purge, with the 24 hours anchored on `created_at`.
 *
 * **NOT proved here: that two concurrent relays get disjoint rows.** That needs two
 * open transactions, and PGlite serves one connection — the second one WAITS rather
 * than racing, so a test written that way HANGS rather than fails. It is at the
 * bottom of this file, skipping loudly. **A relay exclusivity claim that has never
 * run is not a pass**, in exactly the terms gate G1b uses.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { db, sql, testDb } from '@vartalap/database/test-harness';
import { sendMessageRequest, type ServerFrame } from '@vartalap/protocol';
import {
  deliverBatch,
  purgeOutbox,
  relayOnce,
  RELAY_BATCH_SIZE,
  startRelay,
} from './relay.ts';
import { recordingSink, type PublishSink, type SinkContext } from './sink.ts';
import { sendMessage } from './send.ts';
import { captureSql, directConversationBetweenTwo, newMessageId, queriesOf } from './fixture.ts';

const IS_SINGLE_CONNECTION = testDb.kind === 'pglite';

beforeEach(async () => {
  await testDb.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reading the rows back, the way an operator would
// ═══════════════════════════════════════════════════════════════════════════════

interface OutboxState {
  /** `bigserial`, so postgres.js hands it back as text. */
  readonly id: string;
  readonly messageSeq: string;
  readonly publishedAt: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  /** The `jsonb` exactly as it sits in the table. */
  readonly payload: unknown;
}

/**
 * `timestamptz` formatted IN SQL, not parsed here.
 *
 * postgres.js installs no parser for it, so `new Date(text)` in a test is guessing
 * at the session's timezone — and a guess passes on one machine.
 */
const PUBLISHED_AT_ISO = `to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Every outbox row, oldest id first — which is send order. */
function outboxRows(): Promise<OutboxState[]> {
  return sql<OutboxState[]>`
    SELECT id,
           message_seq::text AS "messageSeq",
           ${sql.unsafe(PUBLISHED_AT_ISO)} AS "publishedAt",
           attempts,
           last_error AS "lastError",
           payload
    FROM outbox
    ORDER BY id`;
}

/** N committed sends, through the real send path, each with its outbox row. */
async function seed(count: number): Promise<{ sent: readonly { id: string; seq: string }[] }> {
  const direct = await directConversationBetweenTwo();
  const sent: { id: string; seq: string }[] = [];

  for (let index = 0; index < count; index += 1) {
    const outcome = await sendMessage({
      authorId: direct.authorId,
      request: sendMessageRequest.parse({
        conversationId: direct.conversationId,
        id: newMessageId(),
        body: `body-${index}`,
        attachments: [],
      }),
    });
    if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
    if (outcome.message.seq === null) throw new Error('a committed message has no position');
    sent.push({ id: outcome.message.id, seq: outcome.message.seq });
  }

  return { sent };
}

/** The message id on a `message.created` frame — the client's idempotency key. */
function messageIdOf(frame: ServerFrame): string {
  if (frame.type !== 'message.created') throw new Error(`unexpected frame: ${frame.type}`);
  return frame.message.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The happy path, read back out of the database
// ═══════════════════════════════════════════════════════════════════════════════

describe('a poll', () => {
  test('publishes the frame the send path stored — the same object, in send order', async () => {
    const { sent } = await seed(3);
    const stored = await outboxRows();
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.publishedAt)).toEqual([null, null, null]);
    expect(stored.map((row) => row.attempts)).toEqual([0, 0, 0]);
    expect(stored.map((row) => row.lastError)).toEqual([null, null, null]);

    const sink = recordingSink();
    const pass = await relayOnce(sink);

    expect(pass.claimed).toBe(3);
    expect(pass.failed).toEqual([]);
    expect(pass.published).toHaveLength(3);

    // **Verbatim.** Compared against the `jsonb` read back out of the table, NOT
    // against a frame built here — a relay that re-derived the payload would satisfy
    // the second comparison and fail this one, which is the entire point of ADR
    // 0057's "publishes `payload` verbatim".
    //
    // Widened to `unknown[]` rather than cast: `outbox.payload` is `jsonb`, so the
    // stored side is `unknown` and `toEqual` is contravariant in its expected value.
    // The widening is what says "these are compared as opaque values", which is the
    // claim — a cast would say the types had already been reconciled.
    const received: unknown[] = [...sink.frames];
    expect(received).toEqual(stored.map((row) => row.payload));

    // `ORDER BY id` is the bigserial the send transaction allocated, so the frames
    // leave in send order.
    expect(sink.frames.map(messageIdOf)).toEqual(sent.map((message) => message.id));

    const after = await outboxRows();
    expect(after.map((row) => row.publishedAt === null)).toEqual([false, false, false]);
    // A row the sink accepted has no failure to record.
    expect(after.map((row) => row.attempts)).toEqual([0, 0, 0]);
    expect(after.map((row) => row.lastError)).toEqual([null, null, null]);
  });

  test('the claim is ADR 0057\'s statement — `FOR UPDATE SKIP LOCKED` included', async () => {
    await seed(2);

    const { statements } = await captureSql(sql, () => relayOnce(recordingSink()));
    const queries = queriesOf(statements);
    const claim = statements.find(
      (statement) => /from "outbox"/.test(statement.query) && /for update/i.test(statement.query),
    );

    // Named in the failure message, because "no claim was found" without the SQL is
    // the assertion that never gets fixed.
    expect(
      claim,
      `no FOR UPDATE claim was emitted. Statements were:\n${queries.join('\n')}`,
    ).toBeDefined();

    const text = claim!.query;
    expect(text).toContain('"published_at" is null');
    expect(text).toMatch(/order by "outbox"\."id"/);
    expect(text).toMatch(/limit/i);
    expect(text).toContain('for update skip locked');
    // `SKIP LOCKED` and not the other one: `NOWAIT` would turn a busy relay into a
    // failed relay rather than a relay that takes the next hundred rows.
    expect(text).not.toContain('nowait');

    // The claim is inside the transaction that marks the rows, or the locks it took
    // would be released before anything was published.
    expect(queries.indexOf('begin')).toBeGreaterThanOrEqual(0);
    expect(queries.indexOf('begin')).toBeLessThan(queries.indexOf(text));
    expect(queries).toContain('commit');
  });

  test('each row is marked on its own statement, naming one id', async () => {
    // **The bug this exists to catch.** `UPDATE … WHERE id = ANY($1)` over the
    // claimed ids is one round trip instead of a hundred, and it turns the sink's
    // one refusal into a silent hole: the frame nobody receives, on a row that now
    // claims it was published. Nothing about the schema prevents it, so it is
    // asserted here.
    await seed(3);

    const { statements } = await captureSql(sql, () => relayOnce(recordingSink()));
    const marks = statements.filter((statement) => /^update "outbox"/.test(statement.query));

    expect(marks).toHaveLength(3);
    expect(marks.map((mark) => mark.query)).toEqual([
      expect.stringContaining('where "outbox"."id" = $1'),
      expect.stringContaining('where "outbox"."id" = $1'),
      expect.stringContaining('where "outbox"."id" = $1'),
    ]);
    for (const mark of marks) {
      expect(mark.query).not.toMatch(/\bany\s*\(/i);
      expect(mark.query).toContain('"published_at"');
      expect(mark.query).not.toContain('"attempts"');
    }
    // Three distinct rows, and nothing else touched.
    const ids = marks.map((mark) => String(mark.parameters[0]));
    expect(new Set(ids).size).toBe(3);
  });

  test('never publishes a row whose `published_at` is already set', async () => {
    await seed(3);
    const rows = await outboxRows();
    // A distinctive past stamp, so "unchanged" is checkable exactly rather than by
    // comparing two reads that both say "roughly now".
    const ALREADY = '2001-02-03T04:05:06.000Z';
    await sql`UPDATE outbox SET published_at = ${ALREADY}::timestamptz WHERE id = ${rows[1]!.id}`;

    const sink = recordingSink();
    const pass = await relayOnce(sink);

    expect(pass.claimed).toBe(2);
    expect(sink.count).toBe(2);
    expect(sink.calls.map((call) => call.context.outboxId)).not.toContain(Number(rows[1]!.id));

    // And it was not touched at all — not re-marked, not counted as an attempt.
    const after = await outboxRows();
    expect(after[1]!.publishedAt).toBe(ALREADY);
    expect(after[1]!.attempts).toBe(0);
    expect(after[1]!.lastError).toBe(null);
    expect(after[0]!.publishedAt).not.toBeNull();
    expect(after[2]!.publishedAt).not.toBeNull();
  });

  test('publishes a row at most once across two sequential polls', async () => {
    const { sent } = await seed(2);
    const sink = recordingSink();

    const first = await relayOnce(sink);
    const second = await relayOnce(sink);

    expect(first.claimed).toBe(2);
    expect(first.published).toHaveLength(2);
    // Nothing left to do. `published_at IS NULL` is the whole working set.
    expect(second.claimed).toBe(0);
    expect(second.published).toEqual([]);
    expect(second.failed).toEqual([]);

    expect(sink.count).toBe(2);
    expect(sink.frames.map(messageIdOf)).toEqual(sent.map((message) => message.id));
  });

  test('takes one batch per poll and leaves the rest for the next one', async () => {
    // ADR 0057's 100 is a judgment number, and the only way it stays honest is if the
    // limit is actually a limit.
    expect(RELAY_BATCH_SIZE).toBe(100);
    await seed(5);

    const sink = recordingSink();
    const claimed: number[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      claimed.push((await relayOnce(sink, { batchSize: 2 })).claimed);
    }

    expect(claimed).toEqual([2, 2, 1, 0]);
    expect(sink.count).toBe(5);
    expect(new Set(sink.frames.map(messageIdOf)).size).toBe(5);
  });

  test(
    'the loop polls on an interval, and stops when told to',
    async () => {
      // `startRelay` exists so the relay is a relay and not just a function.
      //
      // **Event-driven, not a spin loop**, and given a real budget: PGlite serves one
      // connection, so every pass queues behind whatever else is talking to the test
      // database. A busy-wait with a five-second deadline fails for a reason that has
      // nothing to do with the relay, and a flaky test in this suite is how a real
      // failure stops being read.
      await seed(2);
      const sink = recordingSink();

      let done: () => void = () => {};
      const delivered = new Promise<void>((resolve) => {
        done = resolve;
      });

      const relay = startRelay(sink, {
        intervalMs: 5,
        batchSize: 1,
        onPass: () => {
          if (sink.count >= 2) done();
        },
        // Without this the loop swallows its own failures and this test reads as a
        // hang rather than as a broken relay.
        onError: (error) => {
          throw error;
        },
      });

      await delivered;
      relay.stop();

      // Long enough for a pass already in flight to finish and try to reschedule. It
      // must not — and a relay left running would publish rows the NEXT test seeded.
      await Bun.sleep(50);

      expect(sink.count).toBe(2);
      const after = await outboxRows();
      expect(after.every((row) => row.publishedAt !== null)).toBe(true);
    },
    // Generous, because the database is shared and single-connection.
    30_000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// A relay killed mid-batch — the property the outbox exists for
// ═══════════════════════════════════════════════════════════════════════════════

describe('a relay killed mid-batch', () => {
  test('re-delivers the whole batch, because nothing was committed', async () => {
    const { sent } = await seed(3);
    const sink = recordingSink();

    // The batch IS published — the sink sees all three frames — and then the relay
    // dies before COMMIT.
    //
    // **What is simulated, and what is not.** A real SIGKILL is not raised here, and
    // nothing in this test depends on raising one: from the database's side a kill
    // IS "the transaction ended without committing", which is exactly what throwing
    // does. What the test establishes is the property the relay relies on — that
    // `published_at` is only durable if the transaction that wrote it committed, and
    // that the sink is the only effect outside that transaction.
    const killed = db.transaction(async (tx) => {
      const pass = await deliverBatch(tx, sink);
      // Asserted inside, so a failure here is the assertion and not a generic throw.
      expect(pass.claimed).toBe(3);
      expect(pass.published).toHaveLength(3);
      throw new Error('the relay was killed');
    });
    await expect(killed).rejects.toThrow('the relay was killed');

    // The sink really was called. This is not a transactional side effect, which is
    // precisely why the guarantee is at-least-once and not exactly-once: the relay
    // genuinely cannot know whether the frames went out.
    expect(sink.count).toBe(3);

    // Nothing survived. Not a mark, not an attempt, not an error — the batch's writes
    // went with the transaction that never committed.
    const stranded = await outboxRows();
    expect(stranded.map((row) => row.publishedAt)).toEqual([null, null, null]);
    expect(stranded.map((row) => row.attempts)).toEqual([0, 0, 0]);
    expect(stranded.map((row) => row.lastError)).toEqual([null, null, null]);

    // The next poll finds every one of them again. **Delivered rather than stranded**
    // is the whole claim: a row whose send was published but not recorded must be
    // retried, not forgotten.
    const pass = await relayOnce(sink);
    expect(pass.claimed).toBe(3);
    expect(pass.published).toHaveLength(3);
    expect(pass.failed).toEqual([]);
    expect(sink.count).toBe(6);

    const after = await outboxRows();
    expect(after.every((row) => row.publishedAt !== null)).toBe(true);

    // Six frames, three messages. **A duplicate is free**: `message.id` is the
    // client's UUIDv7 and the client upserts on it (ADR 0005, stage 3.G), so this is
    // the price ADR 0057 chose rather than a defect. No exactly-once machinery here
    // would close the gap anyway — a relay killed after the sink accepted cannot know
    // whether it published.
    expect(new Set(sink.frames.map(messageIdOf))).toEqual(new Set(sent.map((message) => message.id)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A sink that refuses part of a batch — the failure path
// ═══════════════════════════════════════════════════════════════════════════════

const REFUSAL = 'centrifugo: connection refused';

/**
 * A recording sink that throws for the rows `refuse` selects.
 *
 * Written HERE rather than exported from `sink.ts` on purpose: a permanently-failing
 * sink is a test's decision. Shipping one in `src/` would be a testing affordance
 * wearing a production label, and it would make the `PublishSink` contract look
 * broader than "one method, throwing means not accepted".
 */
function refusing(
  recorder: PublishSink,
  refuse: (context: SinkContext) => boolean,
): PublishSink {
  return {
    async publish(frame, context) {
      if (refuse(context)) throw new Error(REFUSAL);
      await recorder.publish(frame, context);
    },
  };
}

describe('a sink that refuses part of a batch', () => {
  test('marks the frames it refused and only those', async () => {
    await seed(5);
    const rows = await outboxRows();
    const recorder = recordingSink();
    const refused = new Set([Number(rows[1]!.id), Number(rows[3]!.id)]);

    const pass = await relayOnce(refusing(recorder, (context) => refused.has(context.outboxId)));

    // The batch was NOT abandoned at the first refusal — a refused frame costs its
    // own retry and nothing behind it.
    expect(pass.claimed).toBe(5);
    expect(pass.published).toHaveLength(3);
    expect(pass.failed.map((failure) => failure.outboxId)).toEqual([...refused].sort((a, b) => a - b));
    expect(pass.failed.map((failure) => failure.error)).toEqual([REFUSAL, REFUSAL]);

    // **Read back from the database**, not from the pass result — the pass result is
    // the relay's opinion of what it did; the row is the truth.
    const after = await outboxRows();
    expect(after.map((row) => row.publishedAt === null)).toEqual([false, true, false, true, false]);
    expect(after.map((row) => row.attempts)).toEqual([0, 1, 0, 1, 0]);
    expect(after.map((row) => row.lastError)).toEqual([null, REFUSAL, null, REFUSAL, null]);
  });

  test('a refused row is delivered by the next poll', async () => {
    await seed(3);
    const recorder = recordingSink();
    const refused = Number((await outboxRows())[1]!.id);

    await relayOnce(refusing(recorder, (context) => context.outboxId === refused));
    expect(recorder.count).toBe(2);

    // The sink recovers. The row that failed is back in the working set, because
    // `published_at` is still NULL — which is the whole failure path.
    const pass = await relayOnce(recorder);

    expect(pass.published).toEqual([refused]);
    expect(pass.failed).toEqual([]);
    expect(recorder.count).toBe(3);

    const after = await outboxRows();
    expect(after.every((row) => row.publishedAt !== null)).toBe(true);
    // `attempts` and `last_error` are a RECORD of what happened, not a gate. ADR 0057:
    // "attempts counts and last_error records; neither gates." Nothing resets them on
    // success either — a published row that failed once before it succeeded should
    // still say so until the purge deletes it.
    expect(after[1]!.attempts).toBe(1);
    expect(after[1]!.lastError).toBe(REFUSAL);
  });

  test('there is no attempt cap: the third refusal is still attempted', async () => {
    // A cap would convert a two-hour broker outage into permanently undelivered
    // frames, which ADR 0057 calls "a strictly worse failure than a temporarily hot
    // table". So the counter climbs and the relay keeps going.
    await seed(1);
    const recorder = recordingSink();
    const broken = refusing(recorder, () => true);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pass = await relayOnce(broken);
      expect(pass.claimed).toBe(1);
      expect(pass.published).toEqual([]);
      const rows = await outboxRows();
      expect(rows[0]!.attempts).toBe(attempt);
      expect(rows[0]!.publishedAt).toBeNull();
      expect(rows[0]!.lastError).toBe(REFUSAL);
    }

    expect(recorder.count).toBe(0);
  });

  test('a payload the protocol no longer accepts is a failed attempt, not a broadcast', async () => {
    // The parse is INSIDE the failure path on purpose. A row whose `jsonb` no longer
    // satisfies `packages/protocol` must not be published — and must not be allowed
    // to roll the batch back either, which would re-publish the other ninety-nine on
    // every pass forever with nothing in the database to say why.
    await seed(2);
    const rows = await outboxRows();
    await sql`UPDATE outbox SET payload = ${JSON.stringify({ type: 'not.a.frame' })}::jsonb WHERE id = ${rows[0]!.id}`;

    const recorder = recordingSink();
    const pass = await relayOnce(recorder);

    expect(pass.published).toHaveLength(1);
    expect(pass.failed.map((failure) => failure.outboxId)).toEqual([Number(rows[0]!.id)]);

    const after = await outboxRows();
    expect(after[0]!.publishedAt).toBeNull();
    expect(after[0]!.attempts).toBe(1);
    expect(after[0]!.lastError).toBeTruthy();
    // The good one still went out.
    expect(after[1]!.publishedAt).not.toBeNull();
    expect(recorder.count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// H-18's purge, and the anchor that makes it expressible
// ═══════════════════════════════════════════════════════════════════════════════

describe('the purge', () => {
  test('deletes a published row and keeps a never-attempted one at any age', async () => {
    await seed(2);
    const rows = await outboxRows();

    // Published → deleted on success: the row has done its job.
    await sql`UPDATE outbox SET published_at = now() WHERE id = ${rows[0]!.id}`;
    // Never attempted, and thirty days old. Under `published_at IS NULL` alone this
    // is indistinguishable from a failure; `attempts = 0` is what the migration
    // added so "fresh send" and "failed" are two values.
    await sql`UPDATE outbox SET created_at = now() - interval '720 hours' WHERE id = ${rows[1]!.id}`;

    const result = await purgeOutbox();

    expect(result).toEqual({ published: 1, expiredFailures: 0 });
    const after = await outboxRows();
    expect(after.map((row) => row.id)).toEqual([rows[1]!.id]);
    expect(after[0]!.attempts).toBe(0);
  });

  test('24 hours run from `created_at`, not from the last attempt', async () => {
    // The load-bearing choice in ADR 0057. Both rows are attempted by the SAME poll,
    // one millisecond apart. Only one of them is old. If the window were anchored on
    // the last attempt they would both live forever, which is the unbounded growth
    // H-18 exists to close.
    await seed(2);
    const recorder = recordingSink();
    const broken = refusing(recorder, () => true);
    await relayOnce(broken);

    const attempted = await outboxRows();
    expect(attempted.map((row) => row.attempts)).toEqual([1, 1]);
    expect(attempted.map((row) => row.lastError)).toEqual([REFUSAL, REFUSAL]);

    // Age one of them past the window and leave the other alone.
    await sql`UPDATE outbox SET created_at = now() - interval '25 hours' WHERE id = ${attempted[0]!.id}`;

    const result = await purgeOutbox();
    expect(result).toEqual({ published: 0, expiredFailures: 1 });

    const after = await outboxRows();
    expect(after.map((row) => row.id)).toEqual([attempted[1]!.id]);
    // The survivor is a failure too — just a recent one.
    expect(after[0]!.publishedAt).toBeNull();
    expect(after[0]!.attempts).toBe(1);

    // ⚠️ And the cost ADR 0057 names: a row purged here is never broadcast. That is
    // survivable because the outbox is a latency optimisation over a durable record
    // — the message is still in `message`, and the client's catch-up (3.D) and
    // `COUNT(*)` reconciliation (3.G) both fetch it. Purging degrades a live frame
    // into a catch-up row; it never deletes a message.
    const messages = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM message`;
    expect(messages[0]!.n).toBe('2');
  });

  test('a failed row inside the window survives, and a published one never blocks the sweep', async () => {
    await seed(3);
    const rows = await outboxRows();
    await sql`
      UPDATE outbox
         SET attempts = 2,
             last_error = 'timeout',
             created_at = now() - interval '23 hours'
       WHERE id IN (${rows[0]!.id}, ${rows[1]!.id})`;
    // Published, and old — the "deleted on success" case does not care about age.
    await sql`UPDATE outbox SET published_at = now() - interval '48 hours' WHERE id = ${rows[2]!.id}`;

    const result = await purgeOutbox();

    expect(result).toEqual({ published: 1, expiredFailures: 0 });
    const after = await outboxRows();
    expect(after.map((row) => row.id)).toEqual([rows[0]!.id, rows[1]!.id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The half that cannot run on this machine
// ═══════════════════════════════════════════════════════════════════════════════

const RELAY_EXCLUSIVITY_UNVERIFIED = [
  '',
  '════════════════════════════════════════════════════════════════════',
  '  THE TWO-RELAY PROPERTY HAS NEVER RUN. Relay exclusivity is UNVERIFIED.',
  '',
  '  ADR 0057: "FOR UPDATE is what makes it correct. SKIP LOCKED is what',
  '  makes it parallel." This machine has only PGlite, which serves one',
  '  connection: a second transaction WAITS rather than racing, so a test',
  '  written naively hangs instead of failing, and a test that somehow',
  '  finishes has proved nothing.',
  '',
  '  What DOES run here is the statement itself: relay.test.ts asserts the',
  '  emitted claim is ADR 0057\'s, "for update skip locked" included. That is',
  '  a real test of a real property; it cannot tell you the lock was not',
  '  dropped.',
  '',
  '  Set TEST_DATABASE_URL at a real server and the test below runs.',
  '  Until then, do not describe relay exclusivity as proven.',
  '════════════════════════════════════════════════════════════════════',
  '',
].join('\n');

test.skipIf(IS_SINGLE_CONNECTION)(
  `REQUIRES REAL POSTGRES, HAS NEVER RUN HERE (target is ${testDb.kind}): two concurrent relays get DISJOINT rows, and no row is published twice`,
  async () => {
    await seed(6);
    const sink = recordingSink();

    // **First: prove the two really were concurrent.** Without this the test is
    // vacuous on any target that serialises transactions — the two relays would run
    // one after the other, their row sets would be trivially disjoint, and the
    // assertion below would pass having proved nothing.
    //
    // That is not hypothetical, and this file hit it: point `TEST_DATABASE_URL` at a
    // PGlite and `testDb.kind` reports `postgres`, so the `skipIf` above does not
    // fire and the test passes without a single pair of transactions ever being in
    // flight together. `kind` says what the HARNESS booted, not what the URL points
    // at, so it cannot be the only guard — the overlap is measured, not assumed.
    const spans: { from: number; to: number }[] = [];
    const relayOver = (index: number) =>
      db.transaction(async (tx) => {
        const from = performance.now();
        const pass = await deliverBatch(tx, sink);
        spans[index] = { from, to: performance.now() };
        return pass;
      });

    const [first, second] = await Promise.all([relayOver(0), relayOver(1)]);

    const a = spans[0]!;
    const b = spans[1]!;
    expect(
      a.to > b.from && b.to > a.from,
      `the two relays did NOT overlap: relay A ran ${a.from.toFixed(1)}-${a.to.toFixed(1)}ms and relay B ran ${b.from.toFixed(1)}-${b.to.toFixed(1)}ms. ` +
        `This target serialises transactions, so relay exclusivity is UNVERIFIED here and this result means nothing.`,
    ).toBe(true);

    const published = [...first.published, ...second.published];
    expect(new Set(published).size, 'a row was published by both relays').toBe(published.length);
    expect(published).toHaveLength(6);
    expect(sink.count).toBe(6);

    const after = await outboxRows();
    expect(after.every((row) => row.publishedAt !== null)).toBe(true);
  },
  30_000,
);

// A skip that cannot be mistaken for a pass: the name above is what the runner
// prints, and this says the same thing in the output body. It runs ONLY where the
// guarantee is unrun.
test.skipIf(!IS_SINGLE_CONNECTION)(
  'the two-relay property has never run here — relay exclusivity is UNVERIFIED',
  () => {
    console.warn(RELAY_EXCLUSIVITY_UNVERIFIED);
    expect(testDb.kind).toBe('pglite');
  },
);
