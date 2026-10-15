/**
 * Leaving and rejoining — gate C3.
 *
 * A member is a row, and leaving edits the row rather than deleting it:
 * `left_at` set means Former, `NULL` means current. Nothing else changes —
 * in particular the receipt row is never touched, which is why a rejoining
 * member inherits it rather than starting at zero. A zeroed receipt would be
 * a lie (the member did read that far); a stale one is true.
 *
 * ── strict in both directions ──────────────────────────────────────────────
 *
 * Leaving a conversation you are not in is `notAMember`, not a no-op: there is
 * nothing to leave, and silently accepting it would turn a wrong conversation
 * id into a success. Rejoining a conversation you were never in is likewise
 * `notAMember` — rejoin is not a join mechanism, and a join mechanism does
 * not exist in v1 (membership changes are explicit writes, never side effects
 * of sending, per the stage-5 plan). Rejoining while current is a no-op that
 * answers success: the member is where they asked to be.
 *
 * ── leaving changes nothing else ───────────────────────────────────────────
 *
 * No watermark moves, no outbox row is written, no other member is told by
 * this write. Presence lapses on its own TTL; typing was never stored. The
 * transcript stays readable (history serves former members the empty page —
 * 3.D's rule, unchanged), and the member's own client discards its local
 * state through the same paths it always does.
 */
import { and, eq, isNull, sql as drizzleSql } from 'drizzle-orm';
import { db, member } from '@vartalap/database';

export type LeaveOutcome = { readonly kind: 'left' } | { readonly kind: 'notAMember' };
export type RejoinOutcome = { readonly kind: 'rejoined' } | { readonly kind: 'notAMember' };

/** Mark a current member as former. Their row — and their receipt — survives. */
export async function leaveConversation(
  conversationId: string,
  userId: string,
): Promise<LeaveOutcome> {
  const updated = await db
    .update(member)
    .set({ leftAt: drizzleSql`now()` })
    .where(
      and(
        eq(member.conversationId, conversationId),
        eq(member.userId, userId),
        isNull(member.leftAt),
      ),
    )
    .returning({ conversationId: member.conversationId });
  return updated.length > 0 ? { kind: 'left' } : { kind: 'notAMember' };
}

/**
 * Clear `left_at` on a former member's row. The receipt row was never deleted,
 * so this resumes it — inherited, not reset.
 */
export async function rejoinConversation(
  conversationId: string,
  userId: string,
): Promise<RejoinOutcome> {
  const [row] = await db
    .select({ leftAt: member.leftAt })
    .from(member)
    .where(and(eq(member.conversationId, conversationId), eq(member.userId, userId)))
    .limit(1);
  if (row === undefined) return { kind: 'notAMember' };
  if (row.leftAt === null) return { kind: 'rejoined' };
  await db
    .update(member)
    .set({ leftAt: null })
    .where(and(eq(member.conversationId, conversationId), eq(member.userId, userId)));
  return { kind: 'rejoined' };
}
