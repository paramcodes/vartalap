/**
 * The `delivery` write path. Its own module, and the separation is ADR 0010's
 * instruction rather than a file-naming preference:
 *
 * > Receipts are two write paths now. Both monotonic, same key, same transaction.
 * > The `delivery` table has one. **A builder who assumes "the receipt table" is
 * > singular will get this wrong.**
 *
 * So: `receipt.ts` has two functions because a Receipt has two positions, this file
 * has one because delivery has one, and neither file imports the other. A reader
 * looking for "where does a watermark get written" finds two answers that differ,
 * and has to know which table they are in.
 *
 * ── what delivery is, and is not ──────────────────────────────────────────────
 *
 * Delivery is the fact that a frame ARRIVED and was persisted. It is not reading,
 * which is opening a conversation (`GLOSSARY.md` defines a Receipt as how far
 * someone has *read*, and overloading one table with both would corrupt that
 * definition). So this table carries **no `sharing` column and no flag of any kind**:
 * delivery is not a disclosure about the member. ADR 0010 lists this table as the one
 * that "never carries a sharing flag", and ADR 0010's whole argument about a boolean
 * does not apply here — there is nothing to hide.
 *
 * ── any one device is enough ────────────────────────────────────────────────
 *
 * The acknowledgement carries **no device identity**, and none is added. ADR 0004:
 * making delivery per-device "is not a schema change — it is unfixable by
 * construction, since a powered-off device may never acknowledge". "She has it
 * somewhere" is the fact a sender wants.
 *
 * ── monotonicity, same mechanism ─────────────────────────────────────────────
 *
 * The same `GREATEST` as the receipt path, for the same reason and with the same
 * dependency: the client states an ABSOLUTE position, and a delta would make this
 * statement quietly stop working. The difference is that there is no second column
 * and therefore no branch — one `GREATEST` is the whole file.
 */
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { db, delivery, outbox } from '@vartalap/database';
import {
  conversationId as conversationIdScalar,
  deliveryAckResponse,
  seqFromBigInt,
  serverFrame,
  userId as userIdScalar,
  type DeliveryAckRequest,
  type DeliveryAckResponse,
  type Seq,
} from '@vartalap/protocol';
import { isCurrentMember } from './membership.ts';
import { storedPosition } from './position.ts';

export type DeliveryAckOutcome =
  | { readonly kind: 'acknowledged'; readonly delivery: DeliveryAckResponse }
  | { readonly kind: 'notAMember' };

/**
 * A `Seq` the column can hold, or a loud failure rather than a rounded one.
 *
 * The same rule as the receipt path and for the same reason, over one shared
 * implementation: this is a property of the COLUMN TYPE (`bigint(…, { mode:
 * 'number' })`), not of a write path, so it is decided once in `position.ts` and the
 * two files stay otherwise independent — which is what ADR 0010's "two write paths"
 * sentence asks for.
 */
function position(value: Seq): number {
  const stored = storedPosition(value);
  if (stored === null) {
    throw new RangeError(`position ${value} cannot be stored exactly and must not be rounded`);
  }
  return stored;
}

/**
 * Record that a frame arrived at this member's client and was persisted there.
 *
 * Membership first, same predicate and same reason as everywhere else: a delivery
 * watermark for a conversation the caller is not in says "this person has received
 * position N", which is a statement about somebody's reading life in a conversation
 * they were never shown.
 */
export async function acknowledgeDelivery(command: {
  readonly userId: string;
  readonly request: DeliveryAckRequest;
}): Promise<DeliveryAckOutcome> {
  const { userId, request } = command;

  if (!(await isCurrentMember(request.conversationId, userId))) return { kind: 'notAMember' };

  // Same atomicity as the receipt path: the watermark and its broadcast commit
  // together. A stored ack nobody is told about leaves the sender rendering
  // "Sending" forever; a broadcast ack nobody stored is a frame a catch-up cannot
  // reproduce.
  const row = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ deliveredThrough: delivery.deliveredThrough })
      .from(delivery)
      .where(
        and(eq(delivery.conversationId, request.conversationId), eq(delivery.userId, userId)),
      );

    const [upserted] = await tx
    .insert(delivery)
    .values({
      conversationId: request.conversationId,
      userId,
      deliveredThrough: position(request.deliveredThrough),
    })
    .onConflictDoUpdate({
      target: [delivery.conversationId, delivery.userId],
      set: {
        // The same line as the receipt path, one column, no branch. It absorbs the
        // reload, the duplicate, the second tab and the device whose clock moved
        // backwards, and it is the entire mechanism.
        deliveredThrough: drizzleSql`GREATEST(${delivery.deliveredThrough}, EXCLUDED.delivered_through)`,
        updatedAt: drizzleSql`now()`,
      },
    })
    .returning({
      conversationId: delivery.conversationId,
      userId: delivery.userId,
      deliveredThrough: delivery.deliveredThrough,
    });

    if (upserted === undefined) throw new Error('the delivery upsert returned no row');

    // A no-op ack writes no outbox row. Delivery acks arrive per frame per device,
    // so the common case — a second tab, a retried frame — re-reports a position
    // the row already holds; writing a frame for each would fill the outbox with
    // noise the relay must publish. The definition is the stored row not moving,
    // and the frame carries the STORED position for the same reason the receipt
    // frame does.
    const moved = before === undefined || upserted.deliveredThrough !== before.deliveredThrough;
    if (moved) {
      const frame = serverFrame.parse({
        type: 'delivery.acked',
        conversationId: conversationIdScalar.parse(upserted.conversationId),
        userId: userIdScalar.parse(upserted.userId),
        seq: seqFromBigInt(BigInt(upserted.deliveredThrough)),
      });
      await tx.insert(outbox).values({
        messageSeq: null,
        conversationId: upserted.conversationId,
        payload: frame,
      });
    }

    return upserted;
  });

  return {
    kind: 'acknowledged',
    delivery: deliveryAckResponse.parse({
      conversationId: conversationIdScalar.parse(row.conversationId),
      userId: userIdScalar.parse(row.userId),
      deliveredThrough: seqFromBigInt(BigInt(row.deliveredThrough)),
    }),
  };
}