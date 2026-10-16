/**
 * Blocks — gate C2 — and the one `canSend` predicate.
 *
 * ── what a block does, exactly ────────────────────────────────────────────
 *
 * ADR 0007: "B blocks A ⟹ A can no longer send to B, and B's messages to A are
 * not delivered." Two sentences that underdetermine the mechanism, so this file
 * records the reading it implements:
 *
 * - In a DIRECT conversation, a block between the pair locks sending for BOTH
 *   members, each refusal naming its own direction (`blocked_by_me` for the
 *   blocker, `blocked_by_them` for the blocked). The alternative — the blocker
 *   sends into a conversation the blocked party cannot receive — needs
 *   per-member delivery suppression, which contradicts the spine's uniformity
 *   (catch-up keyed on `seq`, `COUNT(*)` per conversation, one relay for all
 *   members). A locked conversation with honest copy is the coherent v1; the
 *   asymmetric-delivery design is a new ADR, not a reinterpretation.
 * - In a GROUP, blocks change NOTHING. One member vetoing 499 others' sends
 *   is obviously wrong, and per-member visibility is the same deep water as
 *   above. A group member who wants someone gone removes them (stage 5.C's
 *   leave path) rather than blocking them.
 * - Blocks gate SENDING, never reading. Receipts, delivery acks, history and
 *   catch-up keep the membership-only predicate: a blocked member is still
 *   shown the conversation, and a watermark for what they were shown is true.
 *
 * ── one predicate ──────────────────────────────────────────────────────────
 *
 * `canSend` extends `isCurrentMember`, it does not sit beside it. The send path
 * used to call `isCurrentMember` directly; it now calls this, and the receipt
 * and delivery paths keep calling `isCurrentMember` — which is correct rather
 * than leftover, per the reading above. The protocol's `sendPermission` is the
 * return type, so the composer renders from the same reasons the server
 * refuses with and there is no second vocabulary for being blocked.
 *
 * ── unblock leaves no residue ──────────────────────────────────────────────
 *
 * No tombstone, no flag: the row is gone. A block is a present-tense fact
 * ("this person may not send to me right now"), and a deleted row that still
 * constrained anything would be history pretending to be state.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { db, block, conversation, member, user } from '@vartalap/database';
import {
  sendPermission,
  type SendPermission,
} from '@vartalap/protocol';
import { isCurrentMember } from './membership.ts';

export type BlockOutcome =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'unknownUser' }
  | { readonly kind: 'cannotBlockSelf' };
export type UnblockOutcome = { readonly kind: 'unblocked' } | { readonly kind: 'unknownUser' };

/**
 * Record that `blockerId` blocks `blockedId`. Idempotent — blocking twice is
 * still blocked, and the second write changes nothing.
 */
export async function blockMember(blockerId: string, blockedId: string): Promise<BlockOutcome> {
  if (blockerId === blockedId) return { kind: 'cannotBlockSelf' };
  const [blocker, blocked] = await Promise.all([isKnownUser(blockerId), isKnownUser(blockedId)]);
  if (!blocker || !blocked) return { kind: 'unknownUser' };
  await db.insert(block).values({ blockerId, blockedId }).onConflictDoNothing();
  return { kind: 'blocked' };
}

/** Remove the block. Unblocking what was never blocked is a no-op, not an error. */
export async function unblockMember(blockerId: string, blockedId: string): Promise<UnblockOutcome> {
  if (!(await isKnownUser(blockedId))) return { kind: 'unknownUser' };
  await db.delete(block).where(and(eq(block.blockerId, blockerId), eq(block.blockedId, blockedId)));
  return { kind: 'unblocked' };
}

async function isKnownUser(userId: string): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  return rows.length > 0;
}

/**
 * Can this user send to this conversation? The one predicate ADR 0007 asks
 * for, called by the send path (and by the interface in stage 6).
 */
export async function canSend(conversationId: string, userId: string): Promise<SendPermission> {
  if (!(await isCurrentMember(conversationId, userId))) {
    return sendPermission.parse({ allowed: false, reason: 'not_a_member' });
  }

  const [row] = await db
    .select({ kind: conversation.kind })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  // Groups do not consult blocks at all — see the module header.
  if (row === undefined || row.kind !== 'direct') {
    return sendPermission.parse({ allowed: true });
  }

  // The pair: every member row but this one. Former members count — a block
  // outlives someone leaving, because leaving does not forgive.
  const peers = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.conversationId, conversationId), ne(member.userId, userId)));
  if (peers.length === 0) return sendPermission.parse({ allowed: true });

  const peerIds = peers.map((peer) => peer.userId);
  const blocks = await db
    .select({ blockerId: block.blockerId, blockedId: block.blockedId })
    .from(block)
    .where(
      or(
        and(eq(block.blockerId, userId), inArray(block.blockedId, peerIds)),
        and(inArray(block.blockerId, peerIds), eq(block.blockedId, userId)),
      ),
    );
  for (const found of blocks) {
    if (found.blockerId === userId) {
      return sendPermission.parse({ allowed: false, reason: 'blocked_by_me' });
    }
    return sendPermission.parse({ allowed: false, reason: 'blocked_by_them' });
  }
  return sendPermission.parse({ allowed: true });
}
