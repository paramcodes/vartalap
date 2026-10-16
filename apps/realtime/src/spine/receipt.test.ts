/**
 * The receipt and delivery write paths, and **gate G2**.
 *
 * G2 is "a receipt or delivery watermark never regresses, under any arrival order".
 * Unlike G1 it needs no concurrency to be honest: the arrivals this file fires are
 * sequential, and the guarantee is about what happens when they are — which is
 * exactly the guarantee a `send` queue flushing after a reload, a second tab, or a
 * duplicate frame produces on a real machine, and exactly the case that does NOT
 * need two open transactions. So it runs everywhere, on PGlite, and it is
 * deterministic rather than probabilistic — the opposite of G1b, which skips.
 *
 * ── the three things this file has to be true about ───────────────────────────
 *
 * 1. **A lower position is refused.** `GREATEST` is the whole mechanism (ADR 0010),
 *    and it only exists because the client sends an ABSOLUTE position. The test
 *    asserts the STORED value after a lower one arrives, so it fails if `GREATEST`
 *    ever becomes a plain assignment.
 * 2. **`shared_through` freezes while sharing is off,** and re-enabling moves the
 *    flag without moving a position (ADR 0058). This is the privacy test, and it is
 *    the reason the second column exists.
 * 3. **A stranger's watermark is refused.** The one security case here: a receipt for
 *    a conversation the caller is not in is a disclosure about somebody's reading.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  deliveryAckRequest,
  receiptAdvanceRequest,
  receiptSharingRequest,
  sendMessageRequest,
  type DeliveryAckRequest,
  type ReceiptAdvanceRequest,
  type Seq,
} from '@vartalap/protocol';
import { acknowledgeDelivery, type DeliveryAckOutcome } from './delivery.ts';
import { sendMessage } from './send.ts';
import { advanceReceipt, setReceiptSharing, type ReceiptAdvanceOutcome } from './receipt.ts';
import {
  captureSql,
  directConversationBetweenTwo,
  insertUser,
  newMessageId,
} from './fixture.ts';

const INSERT_RECEIPT = /^insert into "receipt"/;
const INSERT_DELIVERY = /^insert into "delivery"/;
const MEMBERSHIP = /^select "conversation_id" from "member"/;

beforeEach(async () => {
  await testDb.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fixtures. Real messages, real positions — no invented numbers.
// ═══════════════════════════════════════════════════════════════════════════════

/** A conversation with `count` real messages in it, and their positions. */
async function withTranscript(count: number): Promise<Awaited<ReturnType<typeof directConversationBetweenTwo>> & {
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

/** The stored `receipt` row, read straight from the table. */
async function storedReceipt(conversationId: string, userId: string): Promise<{
  read_through: string;
  shared_through: string;
  sharing: boolean;
} | null> {
  const rows = await sql<{ read_through: string; shared_through: string; sharing: boolean }[]>`
    SELECT read_through::text AS read_through, shared_through::text AS shared_through, sharing
    FROM receipt WHERE conversation_id = ${conversationId} AND user_id = ${userId}`;
  return rows[0] ?? null;
}

async function storedDelivery(conversationId: string, userId: string): Promise<string | null> {
  const rows = await sql<{ delivered_through: string }[]>`
    SELECT delivered_through::text AS delivered_through FROM delivery
    WHERE conversation_id = ${conversationId} AND user_id = ${userId}`;
  return rows[0]?.delivered_through ?? null;
}

/** Narrowing helpers, so a failed expectation names what it was looking at. */
function advanced(outcome: ReceiptAdvanceOutcome): {
  readThrough: Seq;
  sharedThrough: Seq;
} {
  if (outcome.kind !== 'advanced') throw new Error(`expected an advance, got ${outcome.kind}`);
  return outcome.receipt;
}

function acknowledged(outcome: DeliveryAckOutcome): Seq {
  if (outcome.kind !== 'acknowledged') throw new Error(`expected an ack, got ${outcome.kind}`);
  return outcome.delivery.deliveredThrough;
}

const advance = (
  userId: string,
  conversationId: string,
  readThrough: Seq,
  sharedThrough: Seq,
): Promise<ReceiptAdvanceOutcome> =>
  advanceReceipt({
    userId,
    request: receiptAdvanceRequest.parse({ conversationId, readThrough, sharedThrough }),
  });

const ack = (userId: string, conversationId: string, deliveredThrough: Seq): Promise<DeliveryAckOutcome> =>
  acknowledgeDelivery({
    userId,
    request: deliveryAckRequest.parse({ conversationId, deliveredThrough }),
  });

const setSharing = (userId: string, conversationId: string, sharing: boolean): Promise<unknown> =>
  setReceiptSharing({
    userId,
    request: receiptSharingRequest.parse({ conversationId, sharing }),
  });

/** The statements of one call, so a test can assert on the SQL rather than trust it. */
async function statementsOf(run: () => Promise<unknown>) {
  const { statements } = await captureSql(sql, run);
  return statements;
}

// ═══════════════════════════════════════════════════════════════════════════════
// G2 — monotonicity
// ═══════════════════════════════════════════════════════════════════════════════

describe('G2: a watermark never regresses, under any arrival order', () => {
  test('a LOWER position is refused, not applied — which is the only reason absolute positions work', async () => {
    // The mechanism, as behaviour rather than as SQL text. ADR 0010: the client sends
    // an ABSOLUTE position and `GREATEST` absorbs whatever order they arrive in. If
    // the statement were a plain assignment this row would go BACKWARDS and "Seen"
    // would flicker off at random — the failure the whole watermark model exists to
    // prevent.
    const { conversationId, peerId, positions } = await withTranscript(3);
    const [first, , last] = positions as [Seq, Seq, Seq];

    advanced(await advance(peerId, conversationId, last, last));
    // The send queue flushing after a reload, the second tab, the duplicate frame.
    advanced(await advance(peerId, conversationId, first, first));

    const stored = await storedReceipt(conversationId, peerId);
    expect(stored).not.toBeNull();
    expect(stored!.read_through).toBe(last);
    expect(stored!.shared_through).toBe(last);
  });

  test('the answer is the STORED position, so a refused client is told it was refused', async () => {
    // A client that keeps its own idea of where it got to — rather than what the
    // server accepted — renders every later `Seen` wrong, and there is no other place
    // it learns the difference. The response is therefore read back out of the row,
    // not echoed from the request.
    const { conversationId, peerId, positions } = await withTranscript(2);
    const [first, last] = positions as [Seq, Seq];

    advanced(await advance(peerId, conversationId, last, last));
    const refused = advanced(await advance(peerId, conversationId, first, first));

    expect(String(refused.readThrough)).toBe(last);
    expect(String(refused.sharedThrough)).toBe(last);
    expect(String(refused.readThrough)).not.toBe(first);
  });

  test('the same position twice changes nothing, and leaves exactly one row', async () => {
    const { conversationId, peerId, positions } = await withTranscript(1);
    const position = positions[0]!;

    advanced(await advance(peerId, conversationId, position, position));
    advanced(await advance(peerId, conversationId, position, position));
    advanced(await advance(peerId, conversationId, position, position));

    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM receipt`;
    expect(rows[0]!.n).toBe('1');
    expect((await storedReceipt(conversationId, peerId))!.read_through).toBe(position);
  });

  test('three advances flushing newest-first — a reload — leave the row at the newest', async () => {
    // The reload case ADR 0010 names, fired literally: the queue holds three pending
    // advances and flushes them backwards. Sequential, so it runs on PGlite — and it
    // is the same interleaving a race produces, minus the race.
    const { conversationId, peerId, positions } = await withTranscript(3);
    const [first, second, last] = positions as [Seq, Seq, Seq];

    for (const position of [last, second, first]) {
      advanced(await advance(peerId, conversationId, position, position));
    }

    const stored = await storedReceipt(conversationId, peerId);
    expect(stored!.read_through).toBe(last);
    expect(stored!.shared_through).toBe(last);
    expect(last > second && second > first).toBe(true);
  });

  test('a device clock jumping backwards changes nothing, because no clock is read at all', async () => {
    // Stated precisely, because the plan asks for it and the loose version of the
    // claim is not true of the system as a whole. `message.client_created_at` IS a
    // client clock and IS stored — ADR 0005 forbids sorting on it for exactly that
    // reason. Nothing on either watermark path reads a wall clock: a position is a
    // server-assigned `seq` the client reports back. So a clock that moves an hour
    // into the past cannot move a watermark, and this asserts it through the one
    // mechanism that could: a position that looks like it came from the past.
    const { conversationId, peerId, positions } = await withTranscript(2);
    const [first, last] = positions as [Seq, Seq];

    advanced(await advance(peerId, conversationId, last, last));
    advanced(await advance(peerId, conversationId, first, first));

    expect((await storedReceipt(conversationId, peerId))!.read_through).toBe(last);
  });

  test('the shipped statement IS `GREATEST`, on both columns — the mechanism, not a comment', async () => {
    // The parallel to G1a: assert the statement rather than trust the behaviour alone.
    // An implementation could pass the out-of-order test by rejecting a lower value in
    // application code and leave the upsert as a plain assignment, which would then
    // regress under the one interleaving this file cannot fire — two writers at once.
    const { conversationId, peerId, positions } = await withTranscript(1);
    const statements = await statementsOf(() => advance(peerId, conversationId, positions[0]!, positions[0]!));

    const upsert = statements.find((statement) => INSERT_RECEIPT.test(statement.query));
    expect(upsert, 'the receipt upsert was never issued').toBeDefined();

    const query = upsert!.query;
    expect(query).toContain('on conflict ("conversation_id","user_id") do update');
    expect(query).toContain('GREATEST("receipt"."read_through", EXCLUDED.read_through)');
    // The freeze, spelled out. `CASE WHEN "receipt"."sharing"` reads the STORED
    // signal — ADR 0059 settled that the flag does not ride the advance body, so
    // there is nothing in the request that could stand in for it.
    expect(query).toContain('CASE WHEN "receipt"."sharing"');
    expect(query).toContain(
      'GREATEST("receipt"."shared_through", EXCLUDED.shared_through) ELSE "receipt"."shared_through" END',
    );

    // And `sharing` is written as `default`, on BOTH halves. An advance physically
    // cannot turn sharing back on: the column takes its default on insert and the
    // conflict clause never mentions it. That is ADR 0058's disclosure button
    // closed at the statement rather than at the code that builds it.
    expect(query).toContain('values ($1, $2, $3, $4, default, default)');
    expect(query).not.toContain('"sharing" =');
  });

  test('the membership read happens before the upsert, and a refusal writes nothing', async () => {
    const { conversationId, positions } = await withTranscript(1);
    const stranger = await insertUser();

    const statements = await statementsOf(() => advance(stranger, conversationId, positions[0]!, positions[0]!));
    expect(statements.some((statement) => INSERT_RECEIPT.test(statement.query))).toBe(false);

    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM receipt`;
    expect(rows[0]!.n).toBe('0');
    expect(statements.findIndex((statement) => MEMBERSHIP.test(statement.query))).toBeGreaterThanOrEqual(0);
  });

  test('delivery is the same mechanism on its own table, with no branch', async () => {
    const { conversationId, peerId, positions } = await withTranscript(3);
    const [first, , last] = positions as [Seq, Seq, Seq];

    expect(String(acknowledged(await ack(peerId, conversationId, last)))).toBe(last);

    // The second answer is the STORED position, not the requested one: the ack was
    // accepted, and the watermark did not move. A client that assumed its own number
    // was stored renders `Delivered` on messages that never reached it.
    expect(String(acknowledged(await ack(peerId, conversationId, first)))).toBe(last);
    expect(await storedDelivery(conversationId, peerId)).toBe(last);

    const statements = await statementsOf(() => ack(peerId, conversationId, first));
    const upsert = statements.find((statement) => INSERT_DELIVERY.test(statement.query));
    expect(upsert, 'the delivery upsert was never issued').toBeDefined();
    expect(upsert!.query).toContain('GREATEST("delivery"."delivered_through", EXCLUDED.delivered_through)');
    // One column and no flag: delivery is the fact a frame arrived, not a disclosure
    // about the member, so there is nothing here for a boolean to switch (ADR 0010).
    expect(upsert!.query).not.toContain('sharing');
    // Any ONE device acknowledging is enough, and the statement says so by carrying
    // no device column at all (ADR 0004).
    expect(upsert!.query).not.toContain('device');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The freeze — ADR 0058
// ═══════════════════════════════════════════════════════════════════════════════

describe('shared_through freezes while sharing is off, and resumes from the frozen value', () => {
  /**
   * Priya reads one message with sharing on, turns it off, reads the rest in private,
   * and turns it back on. The peer is the one who sent them, so there is something to
   * read — a receipt with no messages under it would pass for the wrong reason.
   */
  async function hidAThirdOfTheConversation() {
    const transcript = await withTranscript(3);
    const [first, second, last] = transcript.positions as [Seq, Seq, Seq];

    advanced(await advance(transcript.peerId, transcript.conversationId, first, first));
    await setSharing(transcript.peerId, transcript.conversationId, false);
    const hidden = advanced(await advance(transcript.peerId, transcript.conversationId, last, last));

    return { ...transcript, first, second, last, hidden };
  }

  test('reading privately still works: read_through advances, shared_through does not', async () => {
    // The unread-count half of ADR 0058, and it is load-bearing: `read_through` has to
    // keep moving or the member's own badge breaks, which is a worse bug than the
    // leak it avoids.
    const { conversationId, peerId, last, hidden } = await hidAThirdOfTheConversation();

    const stored = await storedReceipt(conversationId, peerId);
    expect(stored!.read_through).toBe(last);

    // And the whole point: the position they reached privately is NOT what everyone
    // else can see. This is the assertion the gate exists for.
    expect(stored!.shared_through).not.toBe(last);
    expect(String(hidden.sharedThrough)).toBe(stored!.shared_through);
    // …and it is frozen exactly where sharing was turned off, not at zero: a member
    // who hides the last two messages has still disclosed the first one.
    expect(BigInt(stored!.shared_through)).toBeLessThan(BigInt(last));
  });

  test('turning sharing back on moves the FLAG and nothing else — no discontinuity, no leak', async () => {
    // ADR 0058's first named failure, asserted at the moment it would happen. A
    // re-enable that synced `shared_through = read_through` broadcasts the entire gap
    // the member spent hiding, immediately, to everyone — the privacy control
    // inverted into a disclosure button. So the flag moves and BOTH positions are
    // exactly where they were before the call.
    const { conversationId, peerId, last, hidden } = await hidAThirdOfTheConversation();
    const before = await storedReceipt(conversationId, peerId);

    await setSharing(peerId, conversationId, true);

    const after = await storedReceipt(conversationId, peerId);
    expect(after!.sharing).toBe(true);
    expect(after!.read_through).toBe(before!.read_through);
    expect(after!.shared_through).toBe(before!.shared_through);
    expect(after!.shared_through).toBe(String(hidden.sharedThrough));
    // Still behind, still not the hidden position.
    expect(after!.shared_through).not.toBe(last);
  });

  test('the next advance after re-enabling resumes FORWARD, and never below the frozen value', async () => {
    const { conversationId, peerId, positions } = await withTranscript(4);
    const [first, second, third, last] = positions as [Seq, Seq, Seq, Seq];

    advanced(await advance(peerId, conversationId, second, second));
    await setSharing(peerId, conversationId, false);

    // Read two more messages in private. `read_through` runs ahead; the shared one
    // does not.
    advanced(await advance(peerId, conversationId, last, last));
    const frozen = (await storedReceipt(conversationId, peerId))!.shared_through;
    expect(frozen).toBe(second);
    expect(third < last && second < third && first < second).toBe(true);

    await setSharing(peerId, conversationId, true);
    // Still frozen: the re-enable itself disclosed nothing (asserted properly in the
    // test above, and repeated here so this test's story stands on its own).
    expect((await storedReceipt(conversationId, peerId))!.shared_through).toBe(second);

    // The next advance moves it forward, because a client said so. `GREATEST` is
    // still in force, so it moved up and never down.
    const resumed = advanced(await advance(peerId, conversationId, last, last));
    expect(String(resumed.sharedThrough)).toBe(last);
    expect(BigInt(String(resumed.sharedThrough))).toBeGreaterThan(BigInt(second));
  });

  test('sharing turned off BEFORE anything was read creates the row, so the first advance is already frozen', async () => {
    // The ordering a real client produces: the member opens Settings, turns sharing
    // off, and only then opens the conversation. If the settings write did not create
    // the row, the first advance would INSERT one at the column default — sharing on
    // — and disclose everything the control was supposed to hide, in one request.
    const { conversationId, peerId, positions } = await withTranscript(1);
    const position = positions[0]!;

    await setSharing(peerId, conversationId, false);
    const stored = await storedReceipt(conversationId, peerId);
    expect(stored).not.toBeNull();
    expect(stored!.sharing).toBe(false);
    // `0` is a real position — it sits before the first message — not a null.
    expect(stored!.shared_through).toBe('0');

    const advancedWhileHidden = advanced(await advance(peerId, conversationId, position, position));
    expect(String(advancedWhileHidden.readThrough)).toBe(position);
    expect(String(advancedWhileHidden.sharedThrough)).toBe('0');
  });

  test('the two positions advance on different clocks, in one row', async () => {
    // `read_through` ahead of `shared_through` is the NORMAL state while sharing is
    // off, and it is why the two columns are columns in one row rather than two rows
    // (ADR 0010): they describe the same act of reading on two clocks.
    const { conversationId, peerId, last } = await hidAThirdOfTheConversation();
    const stored = await storedReceipt(conversationId, peerId);
    expect(BigInt(stored!.read_through)).toBeGreaterThan(BigInt(stored!.shared_through));
    expect(stored!.read_through).toBe(last);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Two write paths, not one — ADR 0010
// ═══════════════════════════════════════════════════════════════════════════════

describe('two write paths, and one table is not the other', () => {
  test('advancing a receipt writes no delivery row, and an ack writes no receipt row', async () => {
    const { conversationId, peerId, positions } = await withTranscript(1);
    const position = positions[0]!;

    advanced(await advance(peerId, conversationId, position, position));
    const delivery = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM delivery`;
    expect(delivery[0]!.n).toBe('0');

    acknowledged(await ack(peerId, conversationId, position));

    // Delivery has its own row now, and it did not disturb the receipt: two tables,
    // two facts, neither derived from the other.
    expect(await storedDelivery(conversationId, peerId)).toBe(position);
    const receipt = await storedReceipt(conversationId, peerId);
    expect(receipt!.read_through).toBe(position);
    expect(receipt!.sharing).toBe(true);
  });

  test('the two tables hold different columns — delivery carries no sharing flag', async () => {
    // ADR 0010: delivery "never carries a sharing flag: delivery is the fact that a
    // frame arrived, not a disclosure about the member". A flag on this table would
    // be a disclosure about delivery, which nobody asked for and which has no
    // privacy story at all.
    const columns = async (table: string): Promise<string[]> => {
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`;
      return rows.map((row) => row.column_name);
    };

    expect(await columns('delivery')).toEqual([
      'conversation_id',
      'user_id',
      'delivered_through',
      'updated_at',
    ]);
    expect(await columns('receipt')).toEqual([
      'conversation_id',
      'user_id',
      'read_through',
      'shared_through',
      'sharing',
      'updated_at',
    ]);
  });

  test('neither watermark table has a foreign key to `message` — a position is not a row', async () => {
    // ADR 0004 and ADR 0003: an FK with `ON DELETE CASCADE` would make deleting a
    // message delete the watermark pointing at it and un-see everything behind it.
    // Edit and delete are on the roadmap, so this is a constraint on the future.
    const rows = await sql<{ table_name: string; foreign_table: string }[]>`
      SELECT tc.table_name, ccu.table_name AS foreign_table
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name IN ('receipt', 'delivery')
        AND ccu.table_name = 'message'`;
    expect(rows).toHaveLength(0);
  });

  test('there is no `seen` column, because `Seen` is computed per render and never stored', async () => {
    // ADR 0003 / 0010 / 0060, and `GLOSSARY.md`'s avoid list. The temptation is
    // concrete: both positions are already stored, and a boolean saying whether the
    // sender's predicate is satisfied is one column away — and it would be a SECOND
    // SOURCE OF TRUTH that disagrees with `shared_through` the moment either is
    // wrong. The predicate is computed on the client, over `shared_through`, with
    // three exclusions this schema cannot express.
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%seen%'`;
    expect(rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The security case
// ═══════════════════════════════════════════════════════════════════════════════

describe('a watermark for a conversation the caller is not in', () => {
  test('a stranger cannot advance a receipt, and NOTHING is written', async () => {
    // The gate's security case. Two other members have a conversation; a third user
    // has never been in it. A row written here would say "this person has read up to
    // position N" about a conversation they cannot see — the definition of a privacy
    // leak, and the reason the membership check runs before the statement at all.
    const { conversationId, authorId, positions } = await withTranscript(2);
    const stranger = await insertUser('Stranger');

    const outcome = await advance(stranger, conversationId, positions[1]!, positions[1]!);

    expect(outcome).toEqual({ kind: 'notAMember' });
    expect(await storedReceipt(conversationId, stranger)).toBeNull();
    // Not "their row": no row anywhere for that user, in that conversation or any.
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM receipt WHERE user_id = ${stranger}`;
    expect(rows[0]!.n).toBe('0');
    // And the members' own rows are untouched — a refusal is not a write.
    expect(await storedReceipt(conversationId, authorId)).toBeNull();
  });

  test('a stranger cannot acknowledge delivery, and nothing is written', async () => {
    const { conversationId, positions } = await withTranscript(2);
    const stranger = await insertUser('Stranger');

    const outcome = await ack(stranger, conversationId, positions[1]!);

    expect(outcome).toEqual({ kind: 'notAMember' });
    const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM delivery`;
    expect(rows[0]!.n).toBe('0');
  });

  test('a stranger cannot turn sharing off for a conversation they are not in', async () => {
    // The settings write is the same predicate, not a weaker one: it is a POST the
    // author alone ever sees (ADR 0022), so a stranger reaching it would be a stranger
    // editing somebody else's privacy setting — the one write here that would be a
    // disclosure rather than a leak of one.
    const { conversationId, peerId, positions } = await withTranscript(1);
    const position = positions[0]!;
    advanced(await advance(peerId, conversationId, position, position));
    const before = await storedReceipt(conversationId, peerId);
    const stranger = await insertUser('Stranger');

    const outcome = await setSharing(stranger, conversationId, false);

    expect(outcome).toEqual({ kind: 'notAMember' });
    expect(await storedReceipt(conversationId, stranger)).toBeNull();
    // The member's own row is untouched, position and flag both.
    expect(await storedReceipt(conversationId, peerId)).toEqual(before);
  });

  test('a FORMER member cannot advance, and their existing receipt is left exactly where it was', async () => {
    // `left_at IS NULL` is half the predicate. A Former member remains a row and
    // remains a member for history — their receipt survives and a rejoin inherits
    // it — and none of that makes them somebody whose watermark moves. The refusal
    // must also leave the existing row ALONE: a rejected write that zeroed the row
    // would be a worse failure than the one it prevented.
    const { conversationId, peerId, positions } = await withTranscript(2);
    const [first, last] = positions as [Seq, Seq];

    advanced(await advance(peerId, conversationId, first, first));
    await sql`UPDATE member SET left_at = now() WHERE user_id = ${peerId}`;

    expect(await advance(peerId, conversationId, last, last)).toEqual({ kind: 'notAMember' });
    expect(await ack(peerId, conversationId, last)).toEqual({ kind: 'notAMember' });

    const stored = await storedReceipt(conversationId, peerId);
    expect(stored!.read_through).toBe(first);
    expect(stored!.shared_through).toBe(first);
    // The receipt SURVIVES the member leaving — that is the glossary's promise and
    // the reason a rejoin inherits a stale receipt rather than a zeroed one.
    expect(stored).not.toBeNull();
  });

  test('one member may never write another member\'s watermark', async () => {
    // The key is `(conversation_id, user_id)` and the user id comes from the
    // SESSION, never the body — so a request cannot aim at somebody else's row even
    // if it wanted to. Asserted through the stored row, not the request.
    const { conversationId, authorId, peerId, positions } = await withTranscript(1);
    const position = positions[0]!;

    advanced(await advance(authorId, conversationId, position, position));

    const mine = await storedReceipt(conversationId, authorId);
    const theirs = await storedReceipt(conversationId, peerId);
    expect(mine!.read_through).toBe(position);
    expect(theirs).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A position the column cannot hold
// ═══════════════════════════════════════════════════════════════════════════════

describe('a position the database cannot store exactly', () => {
  test('it is refused rather than rounded', async () => {
    // `Number('9007199254740993')` is `9007199254740992`, with no error. A watermark
    // stored one position behind where the member read renders as a message that
    // refuses to turn blue, forever, and nothing afterwards can tell it from a right
    // one. The route answers `400`; here the write path throws rather than rounding,
    // because a caller that skipped the boundary deserves a loud failure.
    const { conversationId, peerId } = await withTranscript(1);
    const unrounded = '9007199254740993';

    expect(() =>
      advanceReceipt({
        userId: peerId,
        request: {
          conversationId,
          readThrough: receiptAdvanceRequest.shape.readThrough.parse(unrounded),
          sharedThrough: receiptAdvanceRequest.shape.readThrough.parse('1'),
        },
      }),
    ).toThrow(RangeError);

    expect(await storedReceipt(conversationId, peerId)).toBeNull();
  });
});