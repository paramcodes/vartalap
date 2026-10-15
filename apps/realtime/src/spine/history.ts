/**
 * Reading a transcript. Gate **G4, server half**.
 *
 * Two reads, and the second one is the reason `seq` is a single global column.
 *
 * ── history: keyset, both directions, page size 50, never `OFFSET` ─────────────
 *
 * ADR 0005, verbatim:
 *
 *     backwards   WHERE conversation_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 50
 *     forwards    WHERE conversation_id = $1 AND seq > $2 ORDER BY seq ASC  LIMIT 50
 *
 * **`OFFSET` is banned and this file contains none.** The reason is not that it is
 * slow: under concurrent inserts, page three is not the same fifty rows it was a
 * second ago, and a client that has already rendered pages one and two ends up
 * with a duplicated row or a hole. A hole in a keyset-free transcript is exactly
 * the permanently-skipped-row bug G4 exists to detect, so the ban is a
 * correctness rule rather than a performance preference.
 *
 * `message_conversation_seq_idx` is `(conversation_id, seq)`, which is what makes
 * both directions index scans rather than sorts: the cursor is the second index
 * column and the order is its natural one.
 *
 * ── catch-up: ONE query for the whole account ─────────────────────────────────
 *
 * `message.seq` is a **single global column**, so positions compare across
 * conversations and therefore one cursor covers everything (ADR 0005: "Reconnect
 * is one query, not one per conversation"). The per-conversation loop that
 * `message-lifecycle.md` recorded as a known limit is gone, and what replaces it
 * is a keyset page over the `message` table joined to the caller's *current*
 * memberships.
 *
 * ── the two answers that are not rows ─────────────────────────────────────────
 *
 * `latestSeq` is the conversation's current **head**, not the newest row on the
 * page. It exists so a client can assert "I am caught up", and that assertion is
 * only true if it is the head: a client sitting on a short middle page would
 * otherwise be told it had reached the present while messages were still arriving
 * above it.
 *
 * It is computed from `MAX(seq)` rather than read from `conversation.last_seq`,
 * and the difference is deliberate. `last_seq` is a denormalised copy maintained
 * by the send path, and a copy is a value that can be wrong: any future writer
 * that inserts a message without updating it — or a migration, or a repair script
 * — leaves the column behind, and the field whose whole job is "are you behind"
 * is the last field anyone should let drift silently. `MAX(seq)` over the same
 * index the page scan is already using is an index probe, and it cannot be wrong.
 *
 * `totalCount` is the conversation's real **`COUNT(*)`** — half of gate G4, whose
 * other half is the client comparing it against what it holds. It is emphatically
 * NOT the length of the page just returned, and that distinction is invisible on
 * a full first page, which is why the test for it uses a partial page and a short
 * conversation.
 *
 * **An empty conversation answers `latestSeq: '0'` and `totalCount: 0`** rather
 * than null and rather than an error. `0` is a real position — `seq` starts at 1,
 * so it sits before the first message — and `conversation.last_seq` is
 * `NOT NULL DEFAULT 0` for the same reason IndexedDB does not index `null`
 * (ADR 0045). A null here would force every consumer to special-case one.
 *
 * ── the answer a non-member gets ──────────────────────────────────────────────
 *
 * **Identical: the same body, the same status, as a conversation that does not
 * exist, and as a conversation nobody has said anything in.** Not "a 404 for one
 * and an empty page for the other" — that difference is a conversation list the
 * caller is not allowed to see. `readHistory` therefore has no "not a member"
 * outcome at all: there is nothing for the route to branch on, because there is
 * nothing to tell apart.
 *
 * The membership check runs BEFORE any data is read, for the same reason
 * `send.ts` reads membership before it writes: `totalCount` is a volume figure,
 * and an aggregate that ran before the check would leak the size of a
 * conversation to somebody who is not in it. The predicate itself is
 * `membership.ts`'s — the one question the whole spine asks one way.
 *
 * A former member (`left_at` set) is treated exactly like a stranger, on BOTH
 * endpoints and through the same predicate. **Stage 5 owns whether a former
 * member may still read a transcript they were in** — nothing here decides it,
 * and one predicate for both endpoints is worth more than two guesses.
 */
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db, member, message } from '@vartalap/database';
import {
  catchUpPage as catchUpPageSchema,
  historyPage as historyPageSchema,
  seq as seqScalar,
  type CatchUpPage,
  type ConversationId,
  type HistoryPage,
  type Seq,
} from '@vartalap/protocol';
import { isCurrentMember, memberScope } from './membership.ts';
import { toWireMessage } from './message-wire.ts';
import { storedPosition } from './position.ts';

/**
 * The cursor `backwards` uses when the caller named none, and the fact it has to
 * be a real position rather than a nullable parameter.
 *
 * `seq < NULL` is never true, so a NULL cursor silently answers an empty page —
 * the quietest possible failure of the most ordinary request there is. It also
 * costs the index: `($2 IS NULL OR seq < $2)` wraps the keyset predicate in
 * something the planner cannot satisfy from `(conversation_id, seq)`, so the query
 * that has to be an index scan becomes a sequential one. A ban on `OFFSET` that
 * quietly reintroduces its problem in a different clause is not a ban.
 *
 * ⚠️ **`Number.MAX_SAFE_INTEGER`, and NOT the bigint maximum — this was measured.**
 * `Number(9223372036854775807n)` is `9223372036854775808`, which is out of range
 * for `bigint` as a value, and postgres.js then serialises the double as
 * `9223372036854776000` and Postgres answers `22003 value … is out of range`.
 * `2^53 - 1` is exactly representable, binds cleanly, and sits above every position
 * the sequence will reach in the next quarter of a million years at one message a
 * second.
 *
 * Catch-up has no equivalent: `catchUpQuery.after` is REQUIRED, so "no cursor"
 * cannot be asked for. Its mirror case is spelled `'0'`, which is sound because
 * `seq` comes from a sequence at its default `START WITH 1` — `0` is unreachable
 * by any real message (ADR 0045).
 */
const EVERY_ROW_BELOW = Number.MAX_SAFE_INTEGER;

/**
 * A cursor as the number a `bigint(…, { mode: 'number' })` column takes.
 *
 * `position.ts` owns that arithmetic and explains both ceilings — 2^53, where the
 * number starts lying, and 2^63 − 1, where the bind fails. Calling it here rather
 * than inlining `Number(seqToBigInt(…))` is what keeps ONE rule about one column
 * type in one file, and it is why the route can answer `400` about a cursor the
 * spine would otherwise have rounded silently.
 *
 * A `null` here is unreachable from the route — it refuses the same value first —
 * so it is thrown rather than answered: it would be an internal contradiction, not
 * anything a client sent.
 */
function storedCursor(cursor: Seq): number {
  const stored = storedPosition(cursor);
  if (stored === null) throw new Error(`the cursor ${cursor} is not a position a bigint column can hold exactly`);
  return stored;
}

/** The columns a page carries. One projection, so no page can invent a field. */
const MESSAGE_COLUMNS = {
  id: message.id,
  conversationId: message.conversationId,
  authorId: message.authorId,
  body: message.body,
  seq: message.seq,
  clientCreatedAt: message.clientCreatedAt,
};

export interface HistoryCommand {
  /** The authenticated reader. The server never takes this from the query string. */
  readonly userId: string;
  readonly conversationId: ConversationId;
  /** Omitted for the newest page. Explicitly `undefined` is the same as omitted. */
  readonly before?: Seq | undefined;
  /** Omitted to page towards the present. Explicitly `undefined` is the same. */
  readonly after?: Seq | undefined;
  readonly limit: number;
}

export interface CatchUpCommand {
  /** The authenticated member. Everything is scoped to THEIR current memberships. */
  readonly userId: string;
  /** The account cursor. `'0'` is "everything from the beginning". */
  readonly after: Seq;
  readonly limit: number;
}

/**
 * The answer to "no such conversation", "not your conversation", and "nobody has
 * said anything yet" — one function, three callers' worth of meaning, because the
 * caller cannot tell them apart and must not be able to.
 *
 * Built fresh on each call rather than shared as a constant: a module-level frozen
 * object handed to a hundred requests is one bug away from a mutation somebody
 * makes for a reason that makes sense to them.
 */
function emptyPage(): HistoryPage {
  return historyPageSchema.parse({ messages: [], latestSeq: seqScalar.parse('0'), totalCount: 0 });
}

/**
 * One page of a transcript, newest first by default.
 *
 * **Exactly one cursor.** Both cursors supplied is not a wider page, it is an
 * ambiguous ORDER BY, so the route refuses it before this function sees it.
 */
export async function readHistory(command: HistoryCommand): Promise<HistoryPage> {
  // Authorisation first, through the ONE predicate every spine path asks, and
  // before any data is read: `totalCount` is a volume figure, and an aggregate that
  // ran first would leak the size of a conversation to somebody who is not in it.
  if (!(await isCurrentMember(command.conversationId, command.userId))) return emptyPage();

  // `after` means "towards the present", and its presence is what selects the
  // direction. `before` omitted (and `after` omitted) means the newest page.
  const forwards = command.after !== undefined;
  const cursor = forwards
    ? storedCursor(command.after!)
    : command.before === undefined
      ? EVERY_ROW_BELOW
      : storedCursor(command.before);

  const rows = await db
    .select(MESSAGE_COLUMNS)
    .from(message)
    .where(
      and(
        eq(message.conversationId, command.conversationId),
        forwards ? gt(message.seq, cursor) : lt(message.seq, cursor),
      ),
    )
    .orderBy(forwards ? asc(message.seq) : desc(message.seq))
    .limit(command.limit);

  const totals = await conversationTotals(command.conversationId);

  return historyPageSchema.parse({
    messages: rows.map((row) => toWireMessage(row)),
    latestSeq: totals.latestSeq,
    totalCount: totals.totalCount,
  });
}

/**
 * `MAX(seq)` and `COUNT(*)` in ONE statement over the whole conversation.
 *
 * Both are aggregates over the conversation rather than over the page, which is
 * the entire content of gate G4's server half. `count(*) OVER ()` would be the
 * wrong tool in two separate ways: it counts the rows the `LIMIT` kept, and on an
 * empty page it is not there at all because the window had nothing to count.
 *
 * `::text` on both, so the value crosses as a string whichever way the driver
 * chooses to render a `bigint` — the same reason the tests format their counts.
 */
async function conversationTotals(conversationId: ConversationId): Promise<{ latestSeq: Seq; totalCount: number }> {
  const [row] = await db
    .select({
      latestSeq: sql<string>`coalesce(max(${message.seq}), 0)::text`,
      totalCount: sql<string>`count(*)::text`,
    })
    .from(message)
    .where(eq(message.conversationId, conversationId));

  if (row === undefined) throw new Error('the conversation totals query returned no row');
  return { latestSeq: seqScalar.parse(row.latestSeq), totalCount: Number(row.totalCount) };
}

/**
 * Everything this member has been sent since their account cursor, across every
 * conversation they are in — one query, not one per conversation (ADR 0005).
 *
 * **The join IS the authorisation, not a filter applied afterwards.** There is no
 * version of this query that returns a message from a conversation the caller is
 * not a current member of, because the membership rows are what the message rows
 * are found through. A member row is unique per `(conversation_id, user_id)` — it
 * is the primary key — so the join cannot duplicate a message either.
 *
 * `latestSeq` is the caller's head across everything visible to them, with no
 * cursor applied, so the client's loop can stop when its cursor reaches it rather
 * than asking for one more page that comes back short.
 */
export async function readCatchUp(command: CatchUpCommand): Promise<CatchUpPage> {
  const visibleTo = and(eq(member.conversationId, message.conversationId), memberScope(command.userId));

  const rows = await db
    .select(MESSAGE_COLUMNS)
    .from(message)
    .innerJoin(member, visibleTo)
    .where(gt(message.seq, storedCursor(command.after)))
    .orderBy(asc(message.seq))
    .limit(command.limit);

  const [head] = await db
    .select({ latestSeq: sql<string>`coalesce(max(${message.seq}), 0)::text` })
    .from(message)
    .innerJoin(member, visibleTo)
    .where(memberScope(command.userId));

  if (head === undefined) throw new Error('the catch-up head query returned no row');

  return catchUpPageSchema.parse({
    messages: rows.map((row) => toWireMessage(row)),
    latestSeq: seqScalar.parse(head.latestSeq),
  });
}