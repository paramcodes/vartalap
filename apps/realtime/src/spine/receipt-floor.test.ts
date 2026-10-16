/**
 * The floor: `read_through >= shared_through`, kept in the upsert.
 *
 *     bun run test
 *
 * ── the gap this file exists for ───────────────────────────────────────────────
 *
 * ADR 0010 states the invariant — "`read_through >= shared_through` holds at all times
 * — nobody reads what did not arrive" — and states the mechanism in the next breath:
 * "Monotonicity lives in the upsert." `GREATEST` was there, and `GREATEST` alone keeps
 * each column monotonic and keeps them **independent**. Two independent monotonic
 * columns drift apart in the one direction the invariant forbids, and the only way a
 * client produces that direction is to say so: an advance reporting
 * `readThrough < sharedThrough`.
 *
 * Nothing forbade it and nothing checked it, so the row it produced said the member had
 * read LESS than they had disclosed — and `Seen` is computed over `shared_through`. The
 * sender would be reading a position the member never reached.
 *
 * ── the ruling, and why it is a floor on the private column ────────────────────
 *
 * `read_through` is floored at `shared_through`, in the upsert. Not a `CHECK` — ADR
 * 0010 line 68 is explicit that the invariant is about *how a row is written*, and
 * stage 3 dropped `receipt_shared_le_read` for exactly that reason. And not a cap on
 * `shared_through`, because `shared_through` is the FROZEN column: ADR 0058 gave it its
 * own `CASE` branch, and clamping the shared value would mean moving the freeze — the
 * whole design — to defend a column nothing is wrong with.
 *
 * **The disclosure is never altered.** `shared_through` is stored exactly as reported.
 * The private column is the one that gets corrected, so the unread count keeps working
 * exactly as ADR 0058 requires and the privacy column keeps its own rule.
 *
 * ── what this file proves ──────────────────────────────────────────────────────
 *
 *   - the statement carries the floor, spelled out, beside ADR 0058's untouched branch;
 *   - a first advance that reports `readThrough < sharedThrough` stores a row in the
 *     invariant, and the client is handed the STORED value back;
 *   - a row that already violates the invariant — the kind the path before this
 *     statement produced — is REPAIRED by the next advance, not merely prevented;
 *   - the freeze still freezes: sharing off then on behaves exactly as ADR 0058
 *     requires, with the floor in place.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  receiptAdvanceRequest,
  receiptSharingRequest,
  sendMessageRequest,
  type ConversationId,
  type Seq,
  type UserId,
} from '@vartalap/protocol';
import { advanceReceipt, setReceiptSharing, type ReceiptAdvanceOutcome } from './receipt.ts';
import { sendMessage } from './send.ts';
import { captureSql, directConversationBetweenTwo, newMessageId } from './fixture.ts';

const INSERT_RECEIPT = /^insert into "receipt"/;

/**
 * Every test here gets this, because Bun's default is 5 s and PGlite serves ONE
 * connection: a `TRUNCATE` plus a few send transactions queues behind whatever else is
 * talking to the test database. A timeout that fires for that reason reads as a broken
 * receipt path, and a flaky assertion in this suite is how a real failure stops being
 * read.
 */
const SLOW = 30_000;

beforeEach(async () => {
  await testDb.reset();
});

/** Narrowing helpers, so a failed expectation names what it was looking at. */
function advanced(outcome: ReceiptAdvanceOutcome): {
  readonly readThrough: Seq;
  readonly sharedThrough: Seq;
} {
  if (outcome.kind !== 'advanced') throw new Error(`expected an advance, got ${outcome.kind}`);
  return outcome.receipt;
}

async function transcript(
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

const advance = (
  userId: UserId,
  conversationId: ConversationId,
  readThrough: Seq,
  sharedThrough: Seq,
): Promise<ReceiptAdvanceOutcome> =>
  advanceReceipt({
    userId,
    request: receiptAdvanceRequest.parse({ conversationId, readThrough, sharedThrough }),
  });

/** The row, read straight from the table. The invariant is a claim about THIS. */
async function stored(conversationId: ConversationId, userId: UserId): Promise<{
  read_through: string;
  shared_through: string;
  sharing: boolean;
} | null> {
  const rows = await sql<{ read_through: string; shared_through: string; sharing: boolean }[]>`
    SELECT read_through::text AS read_through, shared_through::text AS shared_through, sharing
    FROM receipt WHERE conversation_id = ${conversationId} AND user_id = ${userId}`;
  return rows[0] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The statement
// ═══════════════════════════════════════════════════════════════════════════════

describe('the shipped upsert', () => {
  test('carries the floor, beside a `sharing` branch that is still ADR 0058\'s', async () => {
    // The parallel to G1a: assert the statement, not only the behaviour. An
    // implementation could satisfy the behaviour below by flooring in application code
    // and leave the upsert alone — which would then be wrong under the one
    // interleaving this file cannot fire, two writers at once.
    const { conversationId, peerId, positions } = await transcript(1);
    const { statements } = await captureSql(sql, () =>
      advance(peerId, conversationId, positions[0]!, positions[0]!),
    );

    const upsert = statements.find((statement) => INSERT_RECEIPT.test(statement.query));
    expect(upsert, 'the receipt upsert was never issued').toBeDefined();
    const query = upsert!.query;

    // The floor: three inputs, and the third is the STORED shared position.
    expect(query).toContain(
      'GREATEST(GREATEST("receipt"."read_through", EXCLUDED.read_through), "receipt"."shared_through")',
    );
    // Order matters, and the second `GREATEST` is what makes the branch safe: every
    // `SET` expression reads the PRE-update row, so this is the same `shared_through`
    // the `CASE` below reads and the branch may only raise it or hold it.
    expect(query.indexOf('GREATEST(GREATEST(')).toBeLessThan(query.indexOf('CASE WHEN "receipt"."sharing"'));

    // **ADR 0058's branch, character for character.** The floor was added beside this
    // line precisely so this line never has to change; if it ever does, the freeze moved.
    expect(query).toContain('CASE WHEN "receipt"."sharing"');
    expect(query).toContain(
      'GREATEST("receipt"."shared_through", EXCLUDED.shared_through) ELSE "receipt"."shared_through" END',
    );

    // And an advance still cannot turn sharing back on — the disclosure button stays
    // closed at the statement rather than at the code that builds it.
    expect(query).toContain('values ($1, $2, $3, $4, default, default)');
    expect(query).not.toContain('"sharing" =');
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The gap: a client that reports readThrough < sharedThrough
// ═══════════════════════════════════════════════════════════════════════════════

describe('an advance that reports `readThrough < sharedThrough`', () => {
  test('on a first advance, stores a row in the invariant', async () => {
    const { conversationId, peerId } = await transcript(2);
    const first = '3' as Seq;
    const beyond = '9' as Seq;

    const outcome = advanced(await advance(peerId, conversationId, first, beyond));

    const row = await stored(conversationId, peerId);
    expect(row).not.toBeNull();
    // The floor, read back out of the table rather than inferred from the response.
    expect(BigInt(row!.read_through)).toBeGreaterThanOrEqual(BigInt(row!.shared_through));
    // The DISCLOSURE is exactly what was reported — never corrected, never capped. It is
    // the column with a privacy rule attached, and this change does not touch it.
    expect(row!.shared_through).toBe(beyond);
    // …so the private position was raised to match what the member already disclosed.
    expect(row!.read_through).toBe(beyond);
    expect(String(outcome.readThrough)).toBe(beyond);
    expect(String(outcome.sharedThrough)).toBe(beyond);
  }, SLOW);

  test('answers with the STORED value, so a client can correct itself', async () => {
    // The response echoes the row, never the request — the same rule as everywhere
    // else, and the only thing a buggy client has that could tell it what the server
    // actually accepted.
    const { conversationId, peerId } = await transcript(1);
    const outcome = advanced(await advance(peerId, conversationId, '2' as Seq, '6' as Seq));

    expect(String(outcome.readThrough)).not.toBe('2');
    expect(String(outcome.sharedThrough)).toBe('6');
    expect((await stored(conversationId, peerId))!.read_through).toBe(String(outcome.readThrough));
  }, SLOW);

  test('never lowers a position, and never lowers the disclosure', async () => {
    // Monotonicity is still the whole mechanism: `GREATEST` first, floor last. A floor
    // that could reduce `read_through` would break the unread count for a reason that has
    // nothing to do with this invariant.
    const { conversationId, peerId, positions } = await transcript(3);
    const [first, , last] = positions as [Seq, Seq, Seq];

    advanced(await advance(peerId, conversationId, last, last));
    // Now the impossible pair, arriving on a row that is already ahead.
    const outcome = advanced(await advance(peerId, conversationId, first, '0' as Seq));

    expect(String(outcome.readThrough)).toBe(last);
    expect(String(outcome.sharedThrough)).toBe(last);
    expect(await stored(conversationId, peerId)).toEqual({
      read_through: last,
      shared_through: last,
      sharing: true,
    });
  }, SLOW);

  test('repairs a row that already broke the invariant, rather than only preventing one', async () => {
    // ⚠️ **This is the half that matters for existing data.** Nothing enforced the
    // invariant, so rows written by the path before this statement existed can hold
    // `shared_through > read_through`. The floor is on the STORED `shared_through`, so
    // the next advance brings the row back — with no backfill, no repair script and no
    // constraint to disable.
    const { conversationId, peerId, positions } = await transcript(2);
    const position = positions[1]!;

    advanced(await advance(peerId, conversationId, position, position));
    // Corrupt the row the way a `readThrough < sharedThrough` advance used to.
    await sql`
      UPDATE receipt SET read_through = 1, shared_through = ${position}
       WHERE conversation_id = ${conversationId} AND user_id = ${peerId}`;
    expect(await stored(conversationId, peerId)).toEqual({
      read_through: '1',
      shared_through: position,
      sharing: true,
    });

    // An entirely ordinary advance — both columns at a lower, legal position.
    const outcome = advanced(await advance(peerId, conversationId, '2' as Seq, '2' as Seq));

    expect(String(outcome.readThrough)).toBe(position);
    const row = await stored(conversationId, peerId);
    expect(BigInt(row!.read_through)).toBeGreaterThanOrEqual(BigInt(row!.shared_through));
    // The disclosure did not move — `GREATEST` still holds it, and sharing is on so the
    // branch allowed it as far as the client asked and no further.
    expect(row!.shared_through).toBe(position);
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The floor must not disturb ADR 0058
// ═══════════════════════════════════════════════════════════════════════════════

describe('the freeze, with the floor in place', () => {
  /**
   * Read one message with sharing on, turn it off, read the rest in private — the
   * scenario ADR 0058 exists for, fired with the floor present.
   */
  async function hidTwoThirds() {
    const { conversationId, peerId, positions } = await transcript(3);
    const [first, second, last] = positions as [Seq, Seq, Seq];

    advanced(await advance(peerId, conversationId, first, first));
    await setReceiptSharing({
      userId: peerId,
      request: receiptSharingRequest.parse({ conversationId, sharing: false }),
    });
    const hidden = advanced(await advance(peerId, conversationId, last, last));
    return { conversationId, peerId, first, second, last, hidden };
  }

  test('read_through runs ahead, shared_through stays frozen exactly where it was', async () => {
    // The unread-count half of ADR 0058, and the reason the floor is on the private
    // column rather than a cap on the shared one: reading privately has to keep working.
    const { conversationId, peerId, first, second, last, hidden } = await hidTwoThirds();
    const row = await stored(conversationId, peerId);

    expect(row!.read_through).toBe(last);
    expect(row!.shared_through).toBe(first);
    expect(BigInt(row!.shared_through)).toBeLessThan(BigInt(last));
    expect(BigInt(row!.shared_through)).toBeGreaterThan(0n);
    expect(second < last && first < second).toBe(true);
    expect(String(hidden.sharedThrough)).toBe(first);
    // The invariant holds, and holds with room to spare — which is the NORMAL state
    // while sharing is off, and is why a CHECK would have been wrong here.
    expect(BigInt(row!.read_through)).toBeGreaterThan(BigInt(row!.shared_through));
  }, SLOW);

  test('turning sharing back on moves the flag and nothing else, then resumes forward', async () => {
    // ADR 0058's first named failure, asserted with the floor present: a re-enable that
    // synced `shared_through = read_through` would broadcast the whole hidden gap.
    const { conversationId, peerId, last } = await hidTwoThirds();
    const before = await stored(conversationId, peerId);

    await setReceiptSharing({
      userId: peerId,
      request: receiptSharingRequest.parse({ conversationId, sharing: true }),
    });
    const afterEnable = await stored(conversationId, peerId);
    expect(afterEnable!.sharing).toBe(true);
    expect(afterEnable!.read_through).toBe(before!.read_through);
    expect(afterEnable!.shared_through).toBe(before!.shared_through);
    expect(afterEnable!.shared_through).not.toBe(last);

    // The next advance resumes FORWARD from the frozen value, because a client said so.
    const resumed = advanced(await advance(peerId, conversationId, last, last));
    expect(String(resumed.sharedThrough)).toBe(last);
    expect(String(resumed.readThrough)).toBe(last);
  }, SLOW);

  test('the impossible pair while sharing is off leaves the freeze exactly where it was', async () => {
    // `GREATEST` alone: the client says `1` and `1`, and both columns are already at or
    // above that, so neither moves. The floor's third input is the FROZEN value, which
    // is below `read_through` here, so the floor does not fire either — and must not,
    // because firing would mean raising a position nobody reported.
    const { conversationId, peerId, last } = await hidTwoThirds();
    const before = await stored(conversationId, peerId);

    const outcome = advanced(await advance(peerId, conversationId, '1' as Seq, '1' as Seq));

    expect(await stored(conversationId, peerId)).toEqual(before);
    expect(String(outcome.readThrough)).toBe(before!.read_through);
    expect(String(outcome.sharedThrough)).toBe(before!.shared_through);
    expect(BigInt(before!.shared_through)).toBeLessThan(BigInt(last));
  }, SLOW);

  test('the floor and the freeze read the SAME stored value, and the floor cannot move the freeze', async () => {
    // The one interaction that could plausibly go wrong. The floor's third input is
    // `receipt.shared_through`, and ADR 0058's `CASE` reads the same column. They see the
    // PRE-update row, so the floor can raise the private column to the frozen value —
    // and the `CASE` must still refuse to move the shared one, because sharing is off.
    //
    // The stored row has to be CORRUPTED to get there: with the invariant holding,
    // `read_through` is already at or above `shared_through` and the floor is a no-op.
    const { conversationId, peerId, last } = await hidTwoThirds();
    const frozen = (await stored(conversationId, peerId))!.shared_through;
    await sql`
      UPDATE receipt SET read_through = 1
       WHERE conversation_id = ${conversationId} AND user_id = ${peerId}`;

    const outcome = advanced(await advance(peerId, conversationId, '1' as Seq, '1' as Seq));
    const row = await stored(conversationId, peerId);

    // The private column was RAISED to the disclosed position — not lowered to the 1 the
    // client asked for, which is what `GREATEST` alone would have left it at.
    expect(row!.read_through).toBe(frozen);
    expect(String(outcome.readThrough)).toBe(frozen);
    // The disclosure did not move: sharing is off, and the floor is not a second way to
    // raise `shared_through`.
    expect(row!.shared_through).toBe(frozen);
    expect(String(outcome.sharedThrough)).toBe(frozen);
    expect(BigInt(row!.read_through)).toBeGreaterThanOrEqual(BigInt(row!.shared_through));
    // Still behind the real position, so nothing leaked.
    expect(BigInt(frozen)).toBeLessThan(BigInt(last));
  }, SLOW);

  test('a first advance with sharing already off creates the row in the invariant', async () => {
    // The ordering a real client produces: turn sharing off, THEN open the conversation.
    // `setReceiptSharing` creates the row at `0`/`0`, and the floor has nothing to fire
    // on — so this is the plain path, with the constraint's absence being the point.
    const { conversationId, peerId, positions } = await transcript(1);
    const position = positions[0]!;

    await setReceiptSharing({
      userId: peerId,
      request: receiptSharingRequest.parse({ conversationId, sharing: false }),
    });
    const outcome = advanced(await advance(peerId, conversationId, position, position));

    expect(String(outcome.readThrough)).toBe(position);
    expect(String(outcome.sharedThrough)).toBe('0');
    expect(await stored(conversationId, peerId)).toEqual({
      read_through: position,
      shared_through: '0',
      sharing: false,
    });
  }, SLOW);
});

// ═══════════════════════════════════════════════════════════════════════════════
// There is still no CHECK — stated, so this change is not read as reopening 0010
// ═══════════════════════════════════════════════════════════════════════════════

describe('`receipt` still carries no CHECK constraint', () => {
  test('the invariant is enforced by the write, not by the schema', async () => {
    // Migration 0006 dropped `receipt_shared_le_read` because ADR 0010 line 68 says the
    // invariant is about *how* a row is written. A `CHECK` would also have been wrong
    // for a concrete reason this schema makes visible: `read_through` running AHEAD of
    // `shared_through` is the NORMAL state while sharing is off, and a backfill or a
    // repair would need `SET CONSTRAINTS` to exist at all.
    //
    // And the row below proves the second half of that: the database ACCEPTS the
    // violating row, and the upsert is what keeps it from being produced.
    const { conversationId, peerId, positions } = await transcript(1);
    await sql`
      INSERT INTO receipt (conversation_id, user_id, read_through, shared_through)
      VALUES (${conversationId}, ${peerId}, 1, ${positions[0]!})`;

    const corrupt = await stored(conversationId, peerId);
    expect(corrupt).toEqual({ read_through: '1', shared_through: positions[0]!, sharing: true });

    // So the floor is the ONLY thing standing between that row and the invariant, which
    // is exactly why it is in the upsert and why this file exists.
    advanced(await advance(peerId, conversationId, '2' as Seq, '2' as Seq));
    const repaired = await stored(conversationId, peerId);
    expect(BigInt(repaired!.read_through)).toBeGreaterThanOrEqual(BigInt(repaired!.shared_through));
  }, SLOW);
});
