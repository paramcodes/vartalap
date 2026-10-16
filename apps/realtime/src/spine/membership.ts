/**
 * ADR 0007: "the 'can this user send' predicate lives in the application, once."
 *
 * That sentence was written when the send path was the only caller, and it reads
 * like a note about one function. It is not: stage 3 adds three write paths that
 * all need it — sending, advancing a receipt, acknowledging delivery — and the
 * failure mode of copying the query three times is not a bug report. It is three
 * subtly different predicates, one of which someone will eventually relax. A
 * watermark for a conversation you are not in is a privacy leak, so this module
 * is the *only* place that question is asked, and it is asked the same way every
 * time.
 *
 * ── why the predicate is here and not in the database ──────────────────────────
 *
 * ADR 0007 rejects Postgres RLS on purpose, and the reason applies to a receipt
 * with more force than it does to a send: a rule the database enforces and the
 * client reimplements is two implementations of one rule, and defence in depth
 * here means the two can disagree. One function cannot disagree with itself.
 *
 * ── `left_at IS NULL` is half the predicate ──────────────────────────────────
 *
 * A Former member remains a row and remains a member for history — their receipt
 * survives and a rejoin inherits it, which is true rather than a lie (ADR 0003,
 * `GLOSSARY.md`). None of that makes them somebody you may write for. The one
 * `isNull` is the whole difference between "was here" and "is here", and it is
 * the line a copy-paste drops.
 *
 * **Read it before the write, never inside the transaction that writes.** A
 * transaction held open across an authorisation check serialises members against
 * each other for no reason; 3.C's G1a pins that ordering for the send path and
 * this function is deliberately callable from outside any transaction.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { conversation, db, member, receipt } from '@vartalap/database';
import {
  mediaId as mediaIdScalar,
  membership,
  seqFromBigInt,
  type Membership,
} from '@vartalap/protocol';
import { canSend } from './blocks.ts';

/**
 * The predicate itself, as a SQL fragment, for callers that need it INSIDE a query
 * rather than as an answer to a question.
 *
 * Catch-up (3.D) is one of them: its authorisation is a join through the caller's
 * current memberships, so there is no separate question to ask first and no row to
 * throw away afterwards. Two shapes, one definition — which is the entire argument
 * this module exists to make. A third caller that needs the shape belongs here.
 */
export function memberScope(userId: string) {
  return and(eq(member.userId, userId), isNull(member.leftAt));
}

/**
 * Is this user a current member of this conversation?
 *
 * The single question behind `sendMessage`'s `notAMember`, a receipt advance's
 * refusal, and a delivery ack's refusal. A former member answers `false` — they
 * remain a row, and they are not somebody whose watermarks may be moved.
 */
export async function isCurrentMember(conversationId: string, userId: string): Promise<boolean> {
  const memberships = await db
    .select({ conversationId: member.conversationId })
    .from(member)
    .where(and(eq(member.conversationId, conversationId), memberScope(userId)))
    .limit(1);
  return memberships.length > 0;
}

/**
 * One conversation and everybody in it — the transcript header's read.
 *
 * Ever-members read it, current or former: a former member remains a row and
 * keeps their history, so the transcript that shows it owes them the header
 * too. Strangers get `null` and the route answers the same `404` as an
 * unknown id, which is what keeps the two indistinguishable.
 */
export async function readMembership(
  conversationId: string,
  userId: string,
): Promise<Membership | null> {
  const ever = await db
    .select({ conversationId: member.conversationId })
    .from(member)
    .where(and(eq(member.conversationId, conversationId), eq(member.userId, userId)))
    .limit(1);
  if (ever.length === 0) return null;

  const [row] = await db
    .select()
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  if (row === undefined) return null;

  const memberRows = await db.select().from(member).where(eq(member.conversationId, conversationId));

  // ADR 0007's one predicate, called from the send path AND the interface, so
  // the composer's lock and the server's refusal can never be two answers.
  const permission = await canSend(conversationId, userId);

  // The viewer's own sharing flag, carried by this read so the toggle has one
  // source. No receipt row means the default (0058): `true`. The toggle is the
  // only writer of it, via the `/receipt/sharing` POST — never a receipt advance.
  const [ownReceipt] = await db
    .select({ sharing: receipt.sharing })
    .from(receipt)
    .where(and(eq(receipt.conversationId, conversationId), eq(receipt.userId, userId)))
    .limit(1);
  const sharing = ownReceipt?.sharing ?? true;

  return membership.parse({
    conversation: {
      id: String(row.id),
      kind: row.kind,
      directKey: row.directKey,
      title: row.title,
      lastSeq: seqFromBigInt(BigInt(row.lastSeq)),
    },
    members: memberRows.map((entry) => ({
      conversationId: String(entry.conversationId),
      userId: String(entry.userId),
      displayName: entry.displayName,
      avatarMediaId: entry.avatarMediaId === null ? null : mediaIdScalar.parse(entry.avatarMediaId),
      leftAt: entry.leftAt === null ? null : entry.leftAt.toISOString(),
      mutedAt: entry.mutedAt === null ? null : entry.mutedAt.toISOString(),
    })),
    permission,
    sharing,
  });
}