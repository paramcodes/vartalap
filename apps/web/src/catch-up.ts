/**
 * Reconnect: the catch-up loop, the cursor, and `COUNT(*)` reconciliation.
 * **Gate G4, client half.**
 *
 * ── why there is ONE cursor ────────────────────────────────────────────────
 *
 * `seq` is a **single global column** (ADR 0005). Positions therefore compare
 * across conversations, so there is a total order over everything this member can
 * see, so one cursor covers the whole account and reconnect is one query rather
 * than one per conversation. A per-conversation cursor is the design ADR 0005
 * replaced; `catchUpQuery` has no `conversationId` field precisely so it cannot
 * come back, and this file never writes one per conversation.
 *
 * ── why the cursor advances only past rows that PERSISTED ──────────────────
 *
 * `message-lifecycle.md` §10, verbatim: *"A frame that fails to write must not
 * move it, or the gap becomes silent and permanent."*
 *
 * That is a stronger statement than "advance past the last row on the page". The
 * page is ordered by `seq` ascending, so the only correct rule is **the longest
 * contiguous PREFIX of rows that all persisted**. Advancing past a page whose
 * fifth row was refused would swallow rows six to ten — which were written, so
 * nobody would notice, and the fifth, which was not.
 *
 * `MessageStore.applyReceived` returns an outcome rather than throwing precisely
 * so this loop can stop at the refusal rather than at the end of the page.
 *
 * ── reconciliation, and what it is for ─────────────────────────────────────
 *
 * The advisory lock in `apps/realtime/src/spine/send.ts` is one line of SQL
 * carrying the anti-inversion guarantee, and ADR 0005 says it "carries no comment
 * of its own and no test — which is why the client-side `COUNT(*)` reconciliation
 * exists as an independent net". A net under a net that only fires when somebody
 * has already noticed is not a net.
 *
 * A permanently skipped row is invisible otherwise: the transcript looks complete,
 * the cursor is past it, and nothing anywhere says a message is missing. Two
 * numbers disagreeing is the only detector that works, because — per ADR 0005 —
 * span-versus-count is UNSOUND, since a rolled-back transaction burns its sequence
 * value and `100, 101, 102, 105` is normal.
 */
import { PAGE_SIZE, seq as seqScalar, type ConversationId, type Seq } from '@vartalap/protocol';
import { compareSeq, type MessageStore } from './store.ts';
import type { Transport } from './transport.ts';

// ═══════════════════════════════════════════════════════════════════════════
// CATCH-UP
// ═══════════════════════════════════════════════════════════════════════════

export interface CatchUpResult {
  /** How many pages the server answered. */
  readonly pages: number;
  /** Where the cursor actually is — which may be below the last row received. */
  readonly cursor: Seq;
  /**
   * Is this browser caught up?
   *
   * **False for three separate reasons, and all three are honest:** a row was
   * refused so the cursor stopped short of it, a full page made no progress, or a
   * conversation's counts disagree after one recovery. Claiming to be caught up
   * while a discrepancy is open is worse than either retrying forever or
   * discarding — the interface would stop showing a connection banner for a client
   * that is missing a message.
   */
  readonly caughtUp: boolean;
  /** What stopped the cursor, if anything did. */
  readonly stoppedAt: { readonly id: string; readonly reason: string } | null;
  readonly reconciled: readonly ReconciliationReport[];
}

/**
 * Catch up from the account cursor, then reconcile every conversation.
 *
 * **The loop ends on a SHORT page** — fewer rows than were asked for — and that is
 * how the client knows it has caught up (`message-lifecycle.md` §10). It also ends
 * early when the cursor reaches `latestSeq`, which `catchUpPage` carries for
 * exactly this: asking for one more page that comes back short is a wasted round
 * trip on every reconnect.
 *
 * **It also ends when a full page moved the cursor by nothing**, which the
 * server's `seq > after` keyset query cannot produce. It is here because a loop
 * that cannot terminate on a client's worst day is a battery drain nobody can
 * debug from a phone.
 */
export async function catchUp(store: MessageStore, transport: Transport): Promise<CatchUpResult> {
  // A brand-new browser has no cursor, and `0` means everything from the beginning.
  // It is a request, not a bug: `seq` comes from a sequence at its default
  // `START WITH 1`, so no real message sits at `0` (ADR 0045).
  let cursor = await store.cursor();
  let pages = 0;
  let caughtUp = false;
  let stoppedAt: CatchUpResult['stoppedAt'] = null;

  while (caughtUp === false && stoppedAt === null) {
    const page = await transport.catchUp({ after: cursor, limit: PAGE_SIZE });
    pages += 1;
    const beforePage = cursor;

    // Sorted locally rather than trusted. Fifty bigint comparisons, and it takes
    // an ORDER BY assumption out of the argument that decides where the cursor
    // stops.
    const ordered = [...page.messages].sort((left, right) =>
      compareSeq(left.seq ?? cursor, right.seq ?? cursor),
    );

    for (const message of ordered) {
      /**
       * **Call site two of three** for the one receive write path. Identical code
       * to a live frame and to a send response — a catch-up row that also arrives
       * over the socket afterwards finds the row already there and changes
       * nothing, which is convergence and is proved as gate G3.
       */
      const outcome = await store.applyReceived(message);

      if (outcome.persisted === false) {
        // Stop HERE. The cursor stays below this row, so the gap is still reachable
        // and `COUNT(*)` will find it. Advancing to the end of the page would make
        // it permanent and silent.
        stoppedAt = { id: String(message.id), reason: outcome.reason };
        break;
      }

      cursor = await store.moveCursorTo(message.seq ?? cursor);
    }

    if (stoppedAt !== null) break;

    // The server's own head, with no cursor applied. Reaching it IS caught up.
    if (compareSeq(cursor, page.latestSeq) >= 0) {
      caughtUp = true;
      break;
    }
    if (page.messages.length < PAGE_SIZE) {
      caughtUp = true;
      break;
    }
    if (compareSeq(cursor, beforePage) <= 0) {
      stoppedAt = { id: '', reason: 'pageMadeNoProgress' };
      break;
    }
  }

  const reconciled = await reconcileAll(store, transport);

  return {
    pages,
    cursor: await store.cursor(),
    // The third condition is the one the gate is about: an open discrepancy means
    // a message is missing, so this browser is not caught up no matter how many
    // pages arrived.
    caughtUp: caughtUp && stoppedAt === null && reconciled.every((report) => report.agreed),
    stoppedAt,
    reconciled,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════

export interface ReconciliationReport {
  readonly conversationId: string;
  /** Positioned rows held. A queued send is not on the server and is not counted. */
  readonly held: number;
  /** The server's `COUNT(*)` for the conversation. */
  readonly expected: number;
  readonly agreed: boolean;
  /** Rows the recovery round actually added. `0` means it could not reach the gap. */
  readonly rowsRecovered: number;
}

/**
 * Compare every conversation this browser holds a positioned message in against
 * the server's `COUNT(*)`.
 *
 * **The set is conversations with at least one POSITIONED row**, and that is a
 * real boundary rather than a simplification: a conversation this browser has
 * never received a message from has nothing to count. What makes it narrow rather
 * than wrong is that a fresh cursor is `0`, so a new browser's catch-up delivers
 * everything the member can see and the set is complete before anything is
 * reconciled.
 */
export async function reconcileAll(store: MessageStore, transport: Transport): Promise<ReconciliationReport[]> {
  const conversations = await store.conversationsWithPositionedRows();
  const reports: ReconciliationReport[] = [];
  for (const conversationId of conversations) {
    reports.push(await reconcileConversation(store, transport, conversationId));
  }
  return reports;
}

/**
 * One conversation: count, compare, recover once, compare again, record if it is
 * still wrong.
 *
 * ── the recovery rule, and its limit ───────────────────────────────────────
 *
 * On a mismatch the client's history is refetched **from the lowest `seq` it
 * holds** and every row is written through the one receive path.
 *
 * That direction is not arbitrary. The cursor only ever advances past a
 * *contiguous persisted prefix*, so a hole can only exist **at or above** the
 * lowest position this browser holds — a row above the floor that never persisted
 * is exactly the shape a failed write leaves behind. Paging forward from the
 * floor is therefore sufficient for every shape the cursor can produce.
 *
 * It is NOT sufficient for a conversation this browser holds only the newest page
 * of — a member added to a long conversation receives its older history through
 * `readHistory`, not through catch-up, so their count will disagree with
 * `COUNT(*)` permanently and no forward page can reach the gap. **That case is
 * recorded, not retried**, and `rowsRecovered === 0` is what distinguishes it
 * from the bug the gate is about.
 *
 * ── and then what ──────────────────────────────────────────────────────────
 *
 * If it still disagrees, the client **discards nothing, retries nothing on a
 * loop, and does not claim to be caught up.** It records the discrepancy where a
 * human can see it and leaves the messages it holds.
 *
 * All three are refusals of a specific, tempting alternative:
 *
 * - a silent refetch loop is a battery and bandwidth drain on the member's worst
 *   day, which is exactly when the phone is about to run out;
 * - discarding is a lie — the client does not know WHICH rows are wrong, so it
 *   would delete messages that are correct;
 * - claiming to be caught up is worse than both, because the interface stops
 *   showing a connection banner for a client that is missing a message.
 */
export async function reconcileConversation(
  store: MessageStore,
  transport: Transport,
  conversationId: string,
): Promise<ReconciliationReport> {
  const page = await transport.history({
    conversationId: conversationId as ConversationId,
    limit: PAGE_SIZE,
  });
  const held = await store.positionedCount(conversationId);

  if (held === page.totalCount) {
    // Agreed. A previous discrepancy is cleared so a fixed gap stops shouting —
    // a net that cries wolf is muted inside a week, and then it is not a net.
    await store.clearDiscrepancy(conversationId);
    return { conversationId, held, expected: page.totalCount, agreed: true, rowsRecovered: 0 };
  }

  // The recovery: forward from the floor, or from `0` when this browser holds
  // nothing positioned here at all.
  const floor = (await store.lowestPosition(conversationId)) ?? seqScalar.parse('0');
  const recovered = await recoverForward(store, transport, conversationId, floor);

  const heldAfter = await store.positionedCount(conversationId);
  if (heldAfter === recovered.totalCount) {
    await store.clearDiscrepancy(conversationId);
    return {
      conversationId,
      held: heldAfter,
      expected: recovered.totalCount,
      agreed: true,
      rowsRecovered: recovered.added,
    };
  }

  // Still wrong. Recorded, loudly, once — and never in a loop.
  const discrepancy = {
    conversationId,
    held: heldAfter,
    expected: recovered.totalCount,
    rowsRecovered: recovered.added,
    notedAt: Date.now(),
  };
  await store.noteDiscrepancy(discrepancy);

  // The only thing a human can actually see before stage 6 renders this. Not
  // decoration: the durable row is what a future surface reads, and this line is
  // what stops it existing silently in the meantime.
  console.error(
    `[vartalap] conversation ${conversationId}: holding ${heldAfter} of ${recovered.totalCount} messages ` +
      `after recovery (${recovered.added} recovered). This client is not claiming to be caught up.`,
  );

  return {
    conversationId,
    held: heldAfter,
    expected: recovered.totalCount,
    agreed: false,
    rowsRecovered: recovered.added,
  };
}

/**
 * Page forward from `floor` until the server answers short, writing every row
 * through the one receive path, and report the freshest `COUNT(*)` it saw.
 *
 * A refusal stops the recovery, for the same reason it stops the catch-up loop:
 * continuing past a row this client refused to record would move the recovery's
 * own boundary over the hole it was called to find.
 */
async function recoverForward(
  store: MessageStore,
  transport: Transport,
  conversationId: string,
  floor: Seq,
): Promise<{ readonly totalCount: number; readonly added: number }> {
  let after = floor;
  let added = 0;
  let totalCount = 0;

  for (;;) {
    const page = await transport.history({
      conversationId: conversationId as ConversationId,
      after,
      limit: PAGE_SIZE,
    });
    totalCount = page.totalCount;

    for (const message of page.messages) {
      // Read BEFORE the write, or "did this add anything" answers itself yes.
      const held = await store.messageById(String(message.id));
      const outcome = await store.applyReceived(message);
      if (outcome.persisted === false) break;
      if (held === undefined || held.seq === null) added += 1;
      after = message.seq ?? after;
    }

    if (page.messages.length < PAGE_SIZE) break;
  }

  return { totalCount, added };
}