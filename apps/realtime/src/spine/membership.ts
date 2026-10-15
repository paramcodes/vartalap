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
import { db, member } from '@vartalap/database';

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