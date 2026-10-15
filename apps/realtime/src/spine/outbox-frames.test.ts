/**
 * The outbox carries more than messages, and the relay says so out loud.
 *
 *     bun run test
 *
 * ── the gap this file exists for ───────────────────────────────────────────────
 *
 * `outbox.message_seq` was `NOT NULL REFERENCES message(seq)`, so the table could
 * hold exactly one kind of frame. ADR 0003 says receipt updates "arrive as ephemeral
 * deltas — one event per advance, **exactly as the outbox already delivers
 * everything else**", and ADR 0011 says "the outbox row is the only thing fan-out and
 * push share". Neither was expressible: a receipt advance and a delivery ack have no
 * message `seq`, so they wrote no outbox row and broadcast nothing.
 *
 * The column is nullable now and `conversation_id` — already `NOT NULL` — routes every
 * frame, because `message.created`, `receipt.advanced` and the delivery acks all fan
 * out to a conversation's current members.
 *
 * ── what is proved here ────────────────────────────────────────────────────────
 *
 *   - a row with a NULL `message_seq` is CLAIMED, published verbatim, and marked —
 *     the whole relay path, with no special case anywhere in it;
 *   - the sink is told `messageSeq: null` rather than a number it could route on;
 *   - a mixed batch of message frames and receipt frames relays in `id` order,
 *     together, because the outbox is a queue and not a transcript;
 *   - the emitted claim is still ADR 0057's statement — `message_seq` is still in the
 *     SELECT list, and nothing filters on it;
 *   - **`message.created` with a NULL `message_seq` is refused by the database.**
 *     Nullable is a promise, and this is the half that keeps it.
 *
 * ⚠️ **This file writes `outbox` rows directly in SOME tests, and that is the honest
 * scope of those tests.** The fix this file proves is to the TABLE and to the
 * READER: a nullable `message_seq`, the CHECK that keeps the promise, and a relay
 * that claims and publishes null-position rows with no special case. The tests that
 * hand-build a row prove exactly that and nothing more.
 *
 * The write paths have since caught up: `advanceReceipt` and `acknowledgeDelivery`
 * write their own outbox rows in the same transaction as the watermark upsert, and
 * the end-to-end tests below prove the relay carries THOSE frames. A no-op advance
 * — a re-report `GREATEST` refused — writes nothing, which is what keeps duplicate
 * frame arrivals from filling the outbox with noise.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  deliveryAckRequest,
  receiptAdvanceRequest,
  sendMessageRequest,
  serverFrame,
  type ConversationId,
  type Seq,
  type ServerFrame,
  type UserId,
} from '@vartalap/protocol';
import { relayOnce, RELAY_BATCH_SIZE } from './relay.ts';
import { recordingSink } from './sink.ts';
import { sendMessage } from './send.ts';
import { acknowledgeDelivery } from './delivery.ts';
import { advanceReceipt } from './receipt.ts';
import {
  captureSql,
  directConversationBetweenTwo,
  newMessageId,
  queriesOf,
} from './fixture.ts';

/** The constraint's name, so a failure says which rule refused the write. */
const MESSAGE_CREATED_RULE = 'outbox_message_created_needs_message_seq';

/**
 * Every test here gets this, because Bun's default is 5 s and PGlite serves ONE
 * connection: a `TRUNCATE` plus a handful of send transactions queues behind whatever
 * else is talking to the test database. A timeout that fires for that reason reads as a
 * broken relay, and a flaky assertion in this suite is how a real failure stops being
 * read. The same reasoning, and the same number, as `relay.test.ts`'s loop test.
 */
const SLOW = 30_000;

beforeEach(async () => {
  await testDb.reset();
});

interface OutboxRow {
  readonly id: string;
  /** `bigserial` hands back text; **NULL for every frame that is not about a message**. */
  readonly messageSeq: string | null;
  readonly type: string | null;
}

/** Every outbox row, oldest id first — which is send order (ADR 0057). */
function outboxRows(): Promise<OutboxRow[]> {
  return sql<OutboxRow[]>`
    SELECT id, message_seq::text AS "messageSeq", payload->>'type' AS type
    FROM outbox ORDER BY id`;
}

/** Write an outbox row with NO `message_seq` — what a receipt or delivery frame is. */
async function writeFrameWithoutAMessage(
  conversationId: ConversationId,
  frame: ServerFrame,
): Promise<void> {
  await sql`
    INSERT INTO outbox (conversation_id, payload)
    VALUES (${conversationId}, ${JSON.stringify(frame)}::jsonb)`;
}

/**
 * A `receipt.advanced` frame, built through the protocol's own schema rather than as a
 * literal — so the thing under test is the frame the relay will actually be handed, and
 * a change to `serverFrame` fails here rather than quietly diverging.
 */
function receiptFrame(conversationId: ConversationId, userId: UserId, position: Seq): ServerFrame {
  return serverFrame.parse({
    type: 'receipt.advanced',
    conversationId,
    userId,
    readThrough: position,
    sharedThrough: position,
  });
}

async function transcriptWithPositions(
  count: number,
): Promise<Awaited<ReturnType<typeof directConversationBetweenTwo>> & {
  readonly positions: readonly Seq[];
}> {
  const direct = await directConversationBetweenTwo();
  const positions: Seq[] = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = await sendMessage({
      authorId: direct.authorId,
      request: sendMessageRequest.parse({
        conversationId: direct.conversationId,
        id: newMessageId(),
        body: `message ${index}`,
        attachments: [],
      }),
    });
    if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
    if (outcome.message.seq === null) throw new Error('a committed message has no position');
    positions.push(outcome.message.seq);
  }
  return { ...direct, positions };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A row with no message behind it, claimed and published like any other
// ═══════════════════════════════════════════════════════════════════════════════

describe('an outbox row with no message behind it', () => {
  test('is claimed, published verbatim, and marked — no special case anywhere', async () => {
    const { conversationId, peerId } = await transcriptWithPositions(0);
    const position = '7' as Seq;
    await writeFrameWithoutAMessage(conversationId, receiptFrame(conversationId, peerId, position));

    const stored = await outboxRows();
    expect(stored).toHaveLength(1);
    // **Null, asserted from the table rather than from the code's opinion.** Everything
    // below is a consequence of this row being routable at all.
    expect(stored[0]!.messageSeq).toBeNull();
    expect(stored[0]!.type).toBe('receipt.advanced');

    const sink = recordingSink();
    const pass = await relayOnce(sink);

    expect(pass.claimed).toBe(1);
    expect(pass.published).toHaveLength(1);
    expect(pass.failed).toEqual([]);

    // Verbatim, against the frame written above — ADR 0057's "publishes `payload`
    // verbatim", which a relay that re-derived the frame would fail.
    expect(sink.calls[0]!.frame).toEqual(receiptFrame(conversationId, peerId, position));

    // And the row is done, so it leaves the working set — the `UPDATE` names its id and
    // sets `published_at`, which is the same one-row-per-row path a message takes.
    const marked = await sql<{ published: boolean; attempts: number }[]>`
      SELECT published_at IS NOT NULL AS published, attempts FROM outbox`;
    expect(marked[0]!.published).toBe(true);
    expect(marked[0]!.attempts).toBe(0);
    expect((await relayOnce(recordingSink())).claimed).toBe(0);
  }, SLOW);

  test('a receipt advance writes its own outbox row, in the same transaction', async () => {
    // The gap this file used to name: the advance wrote the watermark and broadcast
    // nothing. Now the row and its frame commit together, and the relay carries the
    // frame the path wrote rather than one the test hand-built.
    const { conversationId, peerId, positions } = await transcriptWithPositions(2);
    const [first, last] = positions as [Seq, Seq];

    const outcome = await advanceReceipt({
      userId: peerId,
      request: receiptAdvanceRequest.parse({ conversationId, readThrough: last, sharedThrough: last }),
    });
    if (outcome.kind !== 'advanced') throw new Error(`expected an advance, got ${outcome.kind}`);

    const stored = await outboxRows();
    expect(stored.map((row) => row.type)).toEqual([
      'message.created',
      'message.created',
      'receipt.advanced',
    ]);
    expect(stored.map((row) => row.messageSeq === null)).toEqual([false, false, true]);

    const sink = recordingSink();
    expect((await relayOnce(sink)).claimed).toBe(3);
    const advanceCall = sink.calls.find((call) => call.frame.type === 'receipt.advanced');
    expect(advanceCall).toBeDefined();
    expect(advanceCall!.frame).toEqual(receiptFrame(conversationId, peerId, last));
    expect(advanceCall!.context.messageSeq).toBeNull();

    // A re-report of the same position moves nothing and writes nothing. Without
    // the no-op rule every duplicate advance — a second tab, a retried frame —
    // would manufacture a broadcast for a watermark that did not change.
    const repeat = await advanceReceipt({
      userId: peerId,
      request: receiptAdvanceRequest.parse({ conversationId, readThrough: last, sharedThrough: last }),
    });
    if (repeat.kind !== 'advanced') throw new Error(`expected an advance, got ${repeat.kind}`);
    expect(await outboxRows()).toHaveLength(3);

    // And a LOWER re-report is refused by `GREATEST` and likewise writes nothing —
    // while the frame that DID move still carries the stored position, not the
    // refused one.
    const lower = await advanceReceipt({
      userId: peerId,
      request: receiptAdvanceRequest.parse({ conversationId, readThrough: first, sharedThrough: first }),
    });
    if (lower.kind !== 'advanced') throw new Error(`expected an advance, got ${lower.kind}`);
    expect(String(lower.receipt.readThrough)).toBe(last);
    expect(await outboxRows()).toHaveLength(3);
    expect(first).not.toBe(last);
  }, SLOW);

  test('the sink is told `messageSeq: null`, not a number it could route on', async () => {
    // The point of the type change. Defaulting it to `0` would hand the sink a position
    // that never existed, and `0` is a REAL position — it sits before the first message
    // — so nothing downstream could tell it from a legitimate one.
    const { conversationId, peerId, positions } = await transcriptWithPositions(1);
    await writeFrameWithoutAMessage(conversationId, receiptFrame(conversationId, peerId, positions[0]!));

    const sink = recordingSink();
    await relayOnce(sink);

    // Two calls — the transcript's message frame and the receipt frame — and the
    // assertion selects the RECEIPT one rather than assuming it is the only one.
    // `messageSeq: null` is a property of the frame that has no message behind it,
    // not of the batch.
    expect(sink.calls).toHaveLength(2);
    const receiptCall = sink.calls.find((call) => call.frame.type === 'receipt.advanced');
    expect(receiptCall).toBeDefined();
    expect(receiptCall!.context.messageSeq).toBeNull();
    // The routing column is NOT NULL for every frame type, and it is all the sink needs
    // to route. That is the whole reason nullability is safe here.
    expect(receiptCall!.context.conversationId).toBe(conversationId);
    expect(typeof receiptCall!.context.outboxId).toBe('number');
  }, SLOW);

  test('a mixed batch relays in `id` order, and a receipt frame does not displace a message', async () => {
    // `ORDER BY id` is still the right order with a nullable position. The outbox is a
    // queue: a receipt frame cannot be reordered relative to a `message.created` by
    // moving it later in the queue, because the client's own watermark upsert is
    // monotonic per (conversation, member) and the message frame carries its position.
    const { conversationId, peerId, positions } = await transcriptWithPositions(2);
    const [first] = positions as [Seq, Seq];

    await writeFrameWithoutAMessage(conversationId, receiptFrame(conversationId, peerId, first));
    await sendMessage({
      authorId: peerId,
      request: sendMessageRequest.parse({
        conversationId,
        id: newMessageId(),
        body: 'after the receipt frame',
        attachments: [],
      }),
    });

    const stored = await outboxRows();
    expect(stored.map((row) => row.type)).toEqual([
      'message.created',
      'message.created',
      'receipt.advanced',
      'message.created',
    ]);
    expect(stored.map((row) => row.messageSeq === null)).toEqual([false, false, true, false]);

    const sink = recordingSink();
    const pass = await relayOnce(sink);

    expect(pass.claimed).toBe(4);
    expect(pass.published).toHaveLength(4);
    // Send order — the bigserial the send transaction allocated.
    expect(sink.calls.map((call) => call.context.outboxId)).toEqual(stored.map((row) => Number(row.id)));
    expect(sink.calls.map((call) => call.context.messageSeq === null)).toEqual([false, false, true, false]);
    expect(sink.frames.map((frame) => frame.type)).toEqual([
      'message.created',
      'message.created',
      'receipt.advanced',
      'message.created',
    ]);
  }, SLOW);

  test('a delivery ack is the same frame with no position, and it writes one row', async () => {
    // Same mechanism, same null. The ack's own table moved — one `GREATEST`, no
    // `sharing` — and the write path now carries its own broadcast: the outbox row
    // is written in the SAME transaction as the watermark upsert, so the two commit
    // together or neither does.
    const { conversationId, peerId, positions } = await transcriptWithPositions(2);
    const [first, last] = positions as [Seq, Seq];

    for (const deliveredThrough of [last, first]) {
      const outcome = await acknowledgeDelivery({
        userId: peerId,
        request: deliveryAckRequest.parse({ conversationId, deliveredThrough }),
      });
      if (outcome.kind !== 'acknowledged') throw new Error(`expected an ack, got ${outcome.kind}`);
      expect(String(outcome.delivery.deliveredThrough)).toBe(last);
    }
    const delivered = await sql<{ delivered_through: string }[]>`
      SELECT delivered_through::text AS delivered_through FROM delivery`;
    expect(delivered[0]!.delivered_through).toBe(last);

    // The FIRST ack moved the watermark and wrote the frame's outbox row. The
    // SECOND ack re-reported a lower position `GREATEST` refused — a no-op — and a
    // no-op writes nothing, or every duplicate frame arrival would fill the outbox
    // with noise the relay must publish.
    const stored = await outboxRows();
    expect(stored.map((row) => row.type)).toEqual([
      'message.created',
      'message.created',
      'delivery.acked',
    ]);
    expect(stored.map((row) => row.messageSeq === null)).toEqual([false, false, true]);

    // Carried end to end: the frame says whose delivery moved and to where, the
    // context says there is no message behind it, and the conversation routes it.
    const sink = recordingSink();
    expect((await relayOnce(sink)).claimed).toBe(3);
    const ackCall = sink.calls.find((call) => call.frame.type === 'delivery.acked');
    expect(ackCall).toBeDefined();
    expect(ackCall!.frame).toEqual(
      serverFrame.parse({ type: 'delivery.acked', conversationId, userId: peerId, seq: last }),
    );
    expect(ackCall!.context.messageSeq).toBeNull();
    expect(ackCall!.context.conversationId).toBe(conversationId);
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADR 0057's statement, and the one thing that changed in it
// ═══════════════════════════════════════════════════════════════════════════════

describe('the claim is still ADR 0057\'s statement', () => {
  test('it SELECTS `message_seq` and filters on nothing else', async () => {
    const { conversationId, peerId, positions } = await transcriptWithPositions(1);
    await writeFrameWithoutAMessage(conversationId, receiptFrame(conversationId, peerId, positions[0]!));

    const { statements } = await captureSql(sql, () => relayOnce(recordingSink()));
    const queries = queriesOf(statements);
    const claim = statements.find(
      (statement) => /from "outbox"/.test(statement.query) && /for update/i.test(statement.query),
    );
    expect(
      claim,
      `no FOR UPDATE claim was emitted. Statements were:\n${queries.join('\n')}`,
    ).toBeDefined();

    const text = claim!.query;
    // The column is still in the projection — ADR 0057's listing verbatim, and dropping
    // it would take the sink's context with it.
    expect(text).toContain('"message_seq"');
    // …and NOTHING filters on it. `WHERE message_seq IS NOT NULL` is the one plausible
    // "fix" for a nullable column, and it would silently convert at-least-once into
    // at-most-once for every non-message frame: a receipt nobody is sent is a hole no
    // client can detect, which is the exact failure ADR 0057 rejected.
    expect(text).not.toMatch(/"message_seq"\s+is\s+not\s+null/);
    expect(text).not.toMatch(/"message_seq"\s+is\s+null/);
    // The working set is still "unpublished rows, oldest first", full stop.
    expect(text).toContain('"published_at" is null');
    expect(text).toMatch(/order by "outbox"\."id"/);
    expect(text).toContain('for update skip locked');
    // Inside the transaction that marks the rows.
    expect(queries.indexOf('begin')).toBeLessThan(queries.indexOf(text));
    expect(queries).toContain('commit');
  }, SLOW);

  test('the batch limit counts frames with no position', async () => {
    // `LIMIT 100` over ROWS, not over messages. A relay that took the limit against
    // positions would starve forever on a conversation whose frames have none.
    expect(RELAY_BATCH_SIZE).toBe(100);
    const { conversationId, peerId } = await transcriptWithPositions(0);
    for (const position of ['1', '2', '3'] as Seq[]) {
      await writeFrameWithoutAMessage(conversationId, receiptFrame(conversationId, peerId, position));
    }

    const claimed: number[] = [];
    const sink = recordingSink();
    for (let pass = 0; pass < 2; pass += 1) {
      claimed.push((await relayOnce(sink, { batchSize: 2 })).claimed);
    }
    expect(claimed).toEqual([2, 1]);
    expect(sink.count).toBe(3);
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The promise a nullable column makes, and the database keeps it
// ═══════════════════════════════════════════════════════════════════════════════

describe('`message.created` without a position', () => {
  test('is refused by the database, not merely unlikely', async () => {
    // The failure this prevents is silent and expensive: the relay would broadcast a
    // `message.created` whose `SinkContext.messageSeq` is null, a client would have a
    // frame it cannot place, and the row would be marked `published_at` — so the
    // outbox would have recorded a delivery of a frame nobody could use.
    const { conversationId } = await transcriptWithPositions(1);

    // Named in the failure message, because "expected a rejection" without the rule is
    // the assertion nobody fixes.
    //
    // try/catch, not `expect(...).rejects`. A postgres.js `Query` is a lazy thenable,
    // not a native promise, and Bun's `rejects` handed the raw query never settles —
    // the test hangs for its whole timeout instead of failing. The IIFE wrap is the
    // other honest form (see `test-harness.test.ts`); here the refusal's identity is
    // the assertion, so the catch reads the code and the constraint name directly.
    let code: unknown;
    let message = '';
    try {
      await sql`
        INSERT INTO outbox (conversation_id, payload)
        VALUES (${conversationId}, ${JSON.stringify({
          type: 'message.created',
          conversationId,
          message: {
            id: newMessageId(),
            conversationId,
            authorId: '00000000-0000-4000-8000-000000000000',
            body: 'a message frame with no position',
            seq: '1',
            createdAt: new Date().toISOString(),
            clientCreatedAt: new Date().toISOString(),
            attachments: [],
          },
        })}::jsonb)`;
    } catch (error) {
      code = (error as { code?: unknown }).code;
      message = (error as Error).message;
    }
    expect(code).toBe('23514');
    expect(message).toContain(MESSAGE_CREATED_RULE);

    // The refused insert added nothing. The one row is the transcript's own
    // `message.created` — `transcriptWithPositions(1)` sends a real message first,
    // and its outbox row is the reason the count is one rather than zero.
    expect(await outboxRows()).toHaveLength(1);
  }, SLOW);

  test('a frame that IS about a message still writes, with its position', async () => {
    // The constraint has to leave the send path alone, or 3.C is broken. Driven through
    // the real send path rather than a hand-written insert, so this is a statement about
    // the production writer.
    const { positions } = await transcriptWithPositions(1);
    const stored = await outboxRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.messageSeq).toBe(positions[0]!);
    expect(stored[0]!.type).toBe('message.created');
  }, SLOW);

  test('every other frame type writes with a NULL position', async () => {
    // The permissive half, asserted rather than assumed. A CHECK written as
    // `message_seq IS NOT NULL` would satisfy the test above and fail this one.
    const { conversationId, peerId, positions } = await transcriptWithPositions(1);
    const position = positions[0]!;
    for (const frame of [
      receiptFrame(conversationId, peerId, position),
      serverFrame.parse({ type: 'typing.started', conversationId, userId: peerId, at: 0 }),
      serverFrame.parse({ type: 'typing.stopped', conversationId, userId: peerId }),
    ]) {
      await writeFrameWithoutAMessage(conversationId, frame);
    }
    expect((await outboxRows()).map((row) => row.messageSeq === null)).toEqual([false, true, true, true]);
  }, SLOW);

  test('a payload with no `type` is left to the relay, which reports it as a failure', async () => {
    // `payload->>'type' <> 'message.created'` is NULL for a missing key, and a CHECK
    // passes on NULL. Deliberate: the more useful answer is the relay recording a failed
    // attempt with the parse error in `last_error` — loud and diagnosable — where a
    // constraint would have refused a write by a writer that could not have known what
    // it was doing.
    const { conversationId } = await transcriptWithPositions(0);
    await sql`
      INSERT INTO outbox (conversation_id, payload)
      VALUES (${conversationId}, ${JSON.stringify({ conversationId })}::jsonb)`;

    const sink = recordingSink();
    const pass = await relayOnce(sink);

    expect(pass.failed).toHaveLength(1);
    expect(sink.count).toBe(0);
    const row = await sql<{ last_error: string; attempts: number; published: boolean }[]>`
      SELECT last_error, attempts, published_at IS NOT NULL AS published FROM outbox`;
    expect(row[0]!.attempts).toBe(1);
    expect(row[0]!.published).toBe(false);
    expect(row[0]!.last_error).toBeTruthy();
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// What the column IS now — read back out of the catalog
// ═══════════════════════════════════════════════════════════════════════════════

describe('the column itself', () => {
  test('`message_seq` is NULLABLE, and the foreign key is still there', async () => {
    const column = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'message_seq'`;
    expect(column).toHaveLength(1);
    expect(column[0]!.is_nullable).toBe('YES');

    // Nullable is NOT "unconstrained". A row that carries a position still cannot name a
    // message that does not exist, and it is still `ON DELETE NO ACTION` — 0006's reason,
    // which is that a cascade would delete an undelivered send.
    const fk = await sql<{ delete_rule: string }[]>`
      SELECT rc.delete_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'outbox'
        AND ccu.table_name = 'message'`;
    expect(fk).toHaveLength(1);
    expect(fk[0]!.delete_rule).toBe('NO ACTION');
  }, SLOW);

  test('`conversation_id` is still NOT NULL — it is the routing column for every frame', async () => {
    // If this ever became nullable the whole argument for tolerating a null
    // `message_seq` collapses: there would be nothing left to route on.
    const column = await sql<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'conversation_id'`;
    expect(column).toHaveLength(1);
    expect(column[0]!.is_nullable).toBe('NO');

    let error: unknown;
    try {
      await sql`
        INSERT INTO outbox (conversation_id, payload)
        VALUES (NULL, ${JSON.stringify({ type: 'typing.stopped' })}::jsonb)`;
      error = new Error('NOT REFUSED');
    } catch (caught) {
      error = caught;
    }
    // try/catch for the same reason as the CHECK test above: a raw postgres.js
    // `Query` handed to `expect(...).rejects` never settles in Bun.
    expect(error).toMatchObject({ code: '23502' });
    expect((error as Error).message).toContain('conversation_id');
  }, SLOW);

  test('the check constraint exists under its own name, and says what it means', async () => {
    const constraints = await sql<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'outbox'::regclass AND contype = 'c'`;
    const rule = constraints.find((row) => row.conname === MESSAGE_CREATED_RULE);
    expect(
      rule,
      `no CHECK named ${MESSAGE_CREATED_RULE}. Constraints were:\n${JSON.stringify(constraints)}`,
    ).toBeDefined();
    // Asserted as SQL because the RULE is the claim. A CHECK written as
    // `message_seq IS NOT NULL` would pass every behavioural test in the section above
    // except this one, and would break the outbox for every non-message frame.
    //
    // Two separate `toContain`s rather than one regex: `pg_get_constraintdef` adds a
    // closing paren and an explicit `::text` cast around each operand, so the shape of
    // the printed SQL is the database's business and not the assertion's.
    expect(rule!.definition).toContain('message_seq IS NOT NULL');
    expect(rule!.definition).toContain("<> 'message.created'");
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The write paths broadcast — asserted, so nobody later assumes otherwise
// ═══════════════════════════════════════════════════════════════════════════════

describe('the receipt and delivery write paths broadcast', () => {
  test('an advance and an ack each write exactly one frame row', async () => {
    // This block used to assert the opposite — that the paths wrote nothing — and
    // that was a scope statement for a table that could not carry the rows. The
    // column is nullable now, ADR 0003 says receipt updates arrive "exactly as the
    // outbox already delivers everything else", and the paths write their frames in
    // the same transaction as the watermark. What this asserts is the shape of that:
    // one row per moved watermark, carrying the STORED position, routable by
    // `conversation_id`.
    const { conversationId, peerId, positions } = await transcriptWithPositions(1);
    const position = positions[0]!;

    const advanced = await advanceReceipt({
      userId: peerId,
      request: receiptAdvanceRequest.parse({ conversationId, readThrough: position, sharedThrough: position }),
    });
    expect(advanced.kind).toBe('advanced');
    const acknowledged = await acknowledgeDelivery({
      userId: peerId,
      request: deliveryAckRequest.parse({ conversationId, deliveredThrough: position }),
    });
    expect(acknowledged.kind).toBe('acknowledged');

    const stored = await outboxRows();
    expect(stored.map((row) => row.type)).toEqual([
      'message.created',
      'receipt.advanced',
      'delivery.acked',
    ]);
    expect(stored.map((row) => row.messageSeq === null)).toEqual([false, true, true]);
  }, SLOW);
});
