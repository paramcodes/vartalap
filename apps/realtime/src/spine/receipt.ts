/**
 * The `receipt` write path. **Gate G2.**
 *
 * Two writes live here and they are not the same write:
 *
 *   advanceReceipt   — moves the two positions
 *   setReceiptSharing — moves the flag, and NOTHING else
 *
 * They are separate because ADR 0022 makes sharing a privacy change with its own
 * transport and ADR 0059 says it does not ride the advance body. That is not a
 * routing detail: **`shared_through` has to be able to freeze while `read_through`
 * keeps moving, and a single write carrying both cannot express it** — whichever
 * order the fields are applied in, one of the two behaviours is lost.
 *
 * ── monotonicity, and why the SQL is spelled out ─────────────────────────────
 *
 * ADR 0010:
 *
 *     ON CONFLICT (conversation_id, user_id) DO UPDATE
 *     SET read_through   = GREATEST(receipt.read_through,   EXCLUDED.read_through),
 *         shared_through = GREATEST(receipt.shared_through, EXCLUDED.shared_through)
 *
 * `GREATEST` is the entire correctness story for out-of-order arrival: a send queue
 * flushing after a reload, a receipt landing before the message it references, two
 * tabs racing, a device clock jumping backwards. The plan calls the last of those
 * out explicitly, and it is worth being exact about what it means here — **a device
 * clock does not appear in this statement at all.** `read_through` is a server-
 * assigned `seq` the client reports back; nothing in the receipt path reads a wall
 * clock, so a clock that jumps backwards cannot move a watermark even in principle.
 * The clock-dependence ADR 0010 warns about is real for the message's
 * `client_created_at` (ADR 0005 forbids sorting on it for exactly this reason), and
 * this unit's answer is that the receipt path never touches it.
 *
 * **The client must send an ABSOLUTE position, never a delta.** The protocol says so
 * on the schema and the dependency is invisible: switch to deltas and this code
 * still runs and quietly stops working. `receipt.test.ts` asserts the stored value
 * after a LOWER position arrives, so the guarantee is tested as behaviour rather
 * than as a comment nobody reads.
 *
 * ── the freeze, and which column is the mechanism ────────────────────────────
 *
 * ADR 0058: **`shared_through` is the mechanism; `sharing` is a transport signal
 * about a permission.** So on every write:
 *
 *   read_through   — advances to the reported position. ALWAYS, whatever `sharing`
 *                    says, because it drives the member's own unread count and an
 *                    unread badge that stops working when someone reads privately
 *                    is a worse bug than the leak it avoids.
 *   shared_through — advances ONLY while the stored `sharing` is true. When it is
 *                    false it freezes at whatever value it already holds: not reset,
 *                    not held back by a server flag, not recomputed.
 *
 * Turning sharing back on therefore moves the FLAG and nothing else. The next
 * advance resumes from the frozen value, and the sender sees forward progress that
 * lags real time. No discontinuity, no gap.
 *
 * The branch reads `receipt.sharing` — the STORED column, not a field on this
 * request — because ADR 0059 settled that the flag does not ride the advance. That
 * is what makes this a settings path with its own transport rather than a field a
 * client sets opportunistically on the same breath as a position.
 *
 * ── the floor: `read_through >= shared_through` ─────────────────────────────────
 *
 * ADR 0010 names the invariant — "`read_through >= shared_through` holds at all
 * times — nobody reads what did not arrive" — and its stated mechanism is the upsert,
 * not a `CHECK`: "the invariant is about *how* a row is written, not what a single
 * row contains." So **no constraint is added here.** What is added is the half of the
 * mechanism the shipped statement never had: `GREATEST` alone keeps each column
 * monotonic, and two monotonic columns that are INDEPENDENT will eventually disagree
 * in the one order that matters.
 *
 * The order that matters is a client reporting `readThrough < sharedThrough`. Nothing
 * forbids it, nothing checks it, and the row it produced said the member had read
 * LESS than they had disclosed — which is what `Seen` is computed over, so a sender
 * reads a position the member never reached.
 *
 * **The floor is on `read_through`, not a cap on `shared_through`,** because
 * `shared_through` is the frozen column and ADR 0058 gives it its own branch.
 * Clamping the shared value would mean rewriting that `CASE` — moving the freeze,
 * which is the whole design — to defend a column nothing is wrong with. Flooring the
 * private one touches nothing: `read_through` still advances unconditionally, so the
 * unread count still works exactly as 0058 requires, and a client that reported the
 * impossible pair is handed the STORED value in the response and can correct itself.
 *
 * It repairs as well as prevents. A row already written with
 * `shared_through > read_through` — any row the path before this statement produced —
 * comes back into the invariant on the next advance, because the STORED
 * `shared_through` is itself a floor.
 */
import { and, eq, sql as drizzleSql } from 'drizzle-orm';
import { db, outbox, receipt } from '@vartalap/database';
import {
  conversationId as conversationIdScalar,
  receiptAdvanceResponse,
  receiptSharingResponse,
  seqFromBigInt,
  serverFrame,
  userId as userIdScalar,
  type ReceiptAdvanceRequest,
  type ReceiptAdvanceResponse,
  type ReceiptSharingRequest,
  type ReceiptSharingResponse,
  type Seq,
} from '@vartalap/protocol';
import { isCurrentMember } from './membership.ts';
import { storedPosition } from './position.ts';

/** What `advanceReceipt` can answer. A refusal writes nothing at all. */
export type ReceiptAdvanceOutcome =
  | { readonly kind: 'advanced'; readonly receipt: ReceiptAdvanceResponse }
  | { readonly kind: 'notAMember' };

/** What `setReceiptSharing` can answer. Same predicate, same answer. */
export type ReceiptSharingOutcome =
  | { readonly kind: 'sharingSet'; readonly receipt: ReceiptSharingResponse }
  | { readonly kind: 'notAMember' };

/**
 * A `Seq` the column can hold, or a loud failure rather than a rounded one.
 *
 * The arithmetic is `storedPosition`'s and its reason is in `position.ts`; the only
 * thing decided here is that a value which survived the protocol's `Seq` pattern and
 * still cannot be stored is **not** quietly rounded. The route turns the same case
 * into a `400` naming the field, so this throw is for a caller that skipped the
 * boundary — and it throws rather than returns a wrong number because a wrong
 * watermark is indistinguishable from a right one afterwards.
 */
function position(value: Seq): number {
  const stored = storedPosition(value);
  if (stored === null) {
    throw new RangeError(`position ${value} cannot be stored exactly and must not be rounded`);
  }
  return stored;
}

/**
 * Advance the member's two positions.
 *
 * Membership is checked BEFORE the statement, and for the same reason the send path
 * checks it first: a refusal that leaves nothing behind is one a client can retry
 * when it is added to the conversation. The refusal itself is a privacy boundary —
 * a row written here for a stranger says "this person has read to position N" about
 * a conversation they were never shown. ADR 0007: one predicate, one place.
 *
 * **A member may always advance their own `read_through`**, sharing off or not.
 * Reading privately has to keep working, or the unread count breaks — which is the
 * entire reason the two columns exist rather than one.
 *
 * The response carries the STORED positions, never the reported ones. After `GREATEST`
 * refuses a lower value they differ, and a client that keeps its own idea of where it
 * got to — rather than what the server accepted — renders every later `Seen` wrong.
 */
export async function advanceReceipt(command: {
  readonly userId: string;
  readonly request: ReceiptAdvanceRequest;
}): Promise<ReceiptAdvanceOutcome> {
  const { userId, request } = command;

  if (!(await isCurrentMember(request.conversationId, userId))) return { kind: 'notAMember' };

  // The floor, computed ONCE and applied to the INSERT branch below. The conflict
  // branch cannot use these two numbers — it has to read the STORED row through
  // `GREATEST` — but the rule is the same one, so the arithmetic is stated once here
  // rather than in two shapes.
  //
  // The ruling: `read_through` is floored at `shared_through`. `shared_through` can
  // never legitimately exceed `read_through`, so a pair that says otherwise is a client
  // reporting that it has already disclosed a position it has not read to — and the
  // honest row is one where its own read position is at least what it disclosed. That
  // keeps the DISCLOSURE (`shared_through`) exactly as reported, which is the half with
  // a privacy rule attached, and corrects only the private half.
  const sharedThrough = position(request.sharedThrough);
  const readThrough = Math.max(position(request.readThrough), sharedThrough);

  // The watermark and its broadcast commit together, or neither does — the same
  // persist-before-acknowledge the send path keeps, because a stored advance nobody
  // is told about is a `Seen` that never renders, and a broadcast advance nobody
  // stored is a frame a catch-up cannot reproduce.
  const row = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ readThrough: receipt.readThrough, sharedThrough: receipt.sharedThrough })
      .from(receipt)
      .where(
        and(eq(receipt.conversationId, request.conversationId), eq(receipt.userId, userId)),
      );

    const [upserted] = await tx
    .insert(receipt)
    .values({
      conversationId: request.conversationId,
      userId,
      readThrough,
      sharedThrough,
      // `sharing` is deliberately ABSENT from these values. The column defaults to
      // `true`, which is the permissive reading (ADR 0058): a receipt that never
      // advances is indistinguishable from a member who has read nothing, and the
      // schema would be storing that second lie. Naming the column here would also
      // let an advance turn sharing back on, which is the disclosure button ADR 0058
      // exists to prevent.
    })
    .onConflictDoUpdate({
      target: [receipt.conversationId, receipt.userId],
      set: {
        // Unconditional. Always advances, whatever `sharing` says.
        //
        // Three inputs, and the third is the floor. `GREATEST` alone made the two
        // columns independent, and independent monotonic columns drift apart in the
        // one direction ADR 0010 forbids — a client reporting
        // `readThrough < sharedThrough`, or a row written before this line existed.
        // Flooring on the STORED `shared_through` is what repairs both, and it is the
        // right side to floor on because the stored shared value is at most the stored
        // read value whenever the row is already well-formed — so on a healthy row the
        // floor never fires and `GREATEST` behaves exactly as ADR 0010 wrote it.
        readThrough: drizzleSql`GREATEST(GREATEST(${receipt.readThrough}, EXCLUDED.read_through), ${receipt.sharedThrough})`,
        // The branch, UNTOUCHED. This is ADR 0058's design: `shared_through` moves
        // only while the stored signal permits it, and holds its value otherwise.
        // Reading `sharing` as the mechanism — so that turning it off freezes nothing —
        // is the failure that turns a privacy control into a disclosure button on
        // re-enable, and the floor above was written so this line never has to change.
        //
        // Every `SET` expression here reads the PRE-update row, so the floor's
        // `receipt.shared_through` and this `CASE`'s `receipt.shared_through` are the
        // same value. The branch may only raise that value or keep it, so it cannot
        // land above the new read position either.
        sharedThrough: drizzleSql`CASE WHEN ${receipt.sharing} THEN GREATEST(${receipt.sharedThrough}, EXCLUDED.shared_through) ELSE ${receipt.sharedThrough} END`,
        // Bookkeeping, and nothing on the message path reads it. Stamped on every
        // accepted write, including one `GREATEST` refused, because the row WAS
        // written — the alternative is a `CASE` nobody asked for guarding a field
        // with no reader.
        updatedAt: drizzleSql`now()`,
      },
    })
    .returning({
      conversationId: receipt.conversationId,
      userId: receipt.userId,
      readThrough: receipt.readThrough,
      sharedThrough: receipt.sharedThrough,
    });

    if (upserted === undefined) throw new Error('the receipt upsert returned no row');

    // A no-op advance writes no outbox row, and the definition of no-op is that
    // the STORED row did not move. An advance that re-reports a position the row
    // already holds says nothing no consumer doesn't already know; writing a frame
    // for it would fill the outbox with duplicates the relay is then obliged to
    // publish, and at-least-once tolerates a duplicate it did not manufacture.
    //
    // The frame carries the STORED positions, never the reported ones: after
    // `GREATEST` refuses a lower value they differ, and broadcasting the refused
    // value would tell every other member a position the watermark does not hold.
    const moved =
      before === undefined ||
      upserted.readThrough !== before.readThrough ||
      upserted.sharedThrough !== before.sharedThrough;
    if (moved) {
      const frame = serverFrame.parse({
        type: 'receipt.advanced',
        conversationId: conversationIdScalar.parse(upserted.conversationId),
        userId: userIdScalar.parse(upserted.userId),
        readThrough: seqFromBigInt(BigInt(upserted.readThrough)),
        sharedThrough: seqFromBigInt(BigInt(upserted.sharedThrough)),
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
    kind: 'advanced',
    receipt: receiptAdvanceResponse.parse({
      conversationId: conversationIdScalar.parse(row.conversationId),
      userId: userIdScalar.parse(row.userId),
      readThrough: seqFromBigInt(BigInt(row.readThrough)),
      sharedThrough: seqFromBigInt(BigInt(row.sharedThrough)),
    }),
  };
}

/**
 * Turn sharing on or off for this conversation. **The settings path, not an advance.**
 *
 * ⚠️ **This statement touches `sharing` and `updated_at`. It does not touch
 * `read_through` or `shared_through`, and that is the whole reason it is a separate
 * function.** ADR 0058's first named failure is a re-enable that syncs
 * `shared_through = read_through` — `read_through` has been advancing the whole time
 * (it must, or the unread badge breaks), so that one line broadcasts the entire gap
 * the member spent hiding, immediately, to everyone. A `set` clause that mentioned
 * either position would be that line.
 *
 * The row is created if it does not exist, because a member may turn sharing off
 * before they have ever advanced anything — and the row then has to exist with
 * `sharing = false` BEFORE the first advance arrives, or that first advance would
 * insert a row at the column default and share everything the control was supposed
 * to hide. The positions take their `DEFAULT 0`, which is a real position (it sits
 * before the first message), not a null.
 *
 * Per-conversation and never global (ADR 0022): a global switch invites a user to
 * believe it hides a read in one conversation, which is false.
 */
export async function setReceiptSharing(command: {
  readonly userId: string;
  readonly request: ReceiptSharingRequest;
}): Promise<ReceiptSharingOutcome> {
  const { userId, request } = command;

  if (!(await isCurrentMember(request.conversationId, userId))) return { kind: 'notAMember' };

  const [row] = await db
    .insert(receipt)
    .values({
      conversationId: request.conversationId,
      userId,
      sharing: request.sharing,
      // `read_through` and `shared_through` are ABSENT and take `DEFAULT 0`. See above:
      // a row created by this write must not carry a position this write never agreed to.
    })
    .onConflictDoUpdate({
      target: [receipt.conversationId, receipt.userId],
      set: {
        // The flag, and only the flag.
        sharing: drizzleSql`EXCLUDED.sharing`,
        updatedAt: drizzleSql`now()`,
      },
    })
    .returning({
      conversationId: receipt.conversationId,
      userId: receipt.userId,
      sharing: receipt.sharing,
    });

  if (row === undefined) throw new Error('the sharing upsert returned no row');

  return {
    kind: 'sharingSet',
    receipt: receiptSharingResponse.parse({
      conversationId: conversationIdScalar.parse(row.conversationId),
      userId: userIdScalar.parse(row.userId),
      sharing: row.sharing,
    }),
  };
}

/**
 * Deliberately absent: a `readReceipt` helper.
 *
 * The advance answers with the stored row, the sharing write answers with the flag,
 * and a test reads the table directly — which is the only reader that wants raw
 * columns. A convenience read that nothing calls is a second place for the wire shape
 * of a watermark to be decided, and there is already one.
 */