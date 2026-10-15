/**
 * The conversation list — gate T1's server half, and the spine's first read of
 * the conversation set. Stage 5 taught the server to create conversations, block
 * pairs and leave them; nothing could READ the set back, so the interface had
 * nothing to render. This is that read, and per the stage-6 rule it is a
 * stage-5 gap filled where it belongs (a missing read, not a workaround).
 *
 * ── derivation discipline ──────────────────────────────────────────────────
 *
 * `last_seq` is the sort key (0045), `muted_at` never filters (0046), and the
 * unread count is derived per request from the receipt — there is no unread
 * column anywhere, and this query is the proof. The count is literally
 * `COUNT(seq > own read_through)`: a member's own sends count until the
 * conversation is opened, because sends never advance a receipt (frames.ts
 * says so) and opening is what clears the badge.
 *
 * `0` sorts last with no special case: `seq` starts at 1, so `ORDER BY
 * last_seq DESC` puts positionless conversations at the bottom, and two
 * conversations can never tie (0045) — no tie-break column, which would be
 * the bug wearing a seatbelt.
 *
 * Presence is best-effort and never fails the list: a Redis outage reports
 * everybody offline (logged, fail-safe direction) rather than 500ing the
 * product. Presence answers only the direct peer — group rows carry none,
 * because a group dot is an attendance record nobody can act on.
 */
import { and, count, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { conversation, db, member, message, receipt } from '@vartalap/database';
import {
  conversationListItem,
  seqFromBigInt,
  type ConversationListItem,
  type Member,
  type Presence,
} from '@vartalap/protocol';
import { canSend } from './blocks.ts';
import { memberScope } from './membership.ts';
import { onlineOf } from './presence.ts';
import { Redis } from './redis.ts';

/** One TCP connection per list read: no shared client, no reconnect logic. */
async function presenceOf(userIds: readonly string[]): Promise<Map<string, boolean>> {
  const offline = new Map<string, boolean>();
  for (const id of userIds) offline.set(id, false);
  if (userIds.length === 0) return offline;
  let client: Redis | null = null;
  try {
    client = await Redis.connect({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      timeoutMs: 1_000,
    });
    return await onlineOf({ redis: client }, userIds);
  } catch (error) {
    console.error(`list: presence unavailable, reporting offline: ${(error as Error).message}`);
    return offline;
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * The viewer's current conversations, newest position first.
 *
 * Former memberships (`left_at` set) are excluded by `memberScope` — leaving
 * removes the row from the list, and rejoining restores it with the receipt
 * intact (stage 5.C). Nothing here is cached or stored: ordering, muting and
 * unread are all derived on every call, which is what T1 pins.
 */
export async function listConversations(viewerId: string): Promise<ConversationListItem[]> {
  const memberships = await db
    .select({ conversationId: member.conversationId, mutedAt: member.mutedAt })
    .from(member)
    .where(memberScope(viewerId));
  if (memberships.length === 0) return [];

  const mutedByConversation = new Map(memberships.map((m) => [m.conversationId, m.mutedAt !== null]));
  const ids = memberships.map((m) => m.conversationId);

  const rows = await db
    .select()
    .from(conversation)
    .where(inArray(conversation.id, ids))
    .orderBy(desc(conversation.lastSeq));

  const items: ConversationListItem[] = [];
  for (const row of rows) {
    const conversationId = String(row.id);

    const [receiptRow] = await db
      .select({ readThrough: receipt.readThrough })
      .from(receipt)
      .where(and(eq(receipt.conversationId, conversationId), eq(receipt.userId, viewerId)))
      .limit(1);
    const readThrough = receiptRow?.readThrough ?? 0;

    const [unreadRow] = await db
      .select({ n: count() })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), gt(message.seq, readThrough)));
    const unreadCount = unreadRow?.n ?? 0;

    // Every non-viewer member, current or former: a direct title derives from
    // the pair the key fixed, and leaving does not unname anybody.
    const peerRows = await db
      .select({
        userId: member.userId,
        displayName: member.displayName,
        avatarMediaId: member.avatarMediaId,
        leftAt: member.leftAt,
      })
      .from(member)
      .where(and(eq(member.conversationId, conversationId), ne(member.userId, viewerId)));

    const peers: Member[] = peerRows.map((peer) => ({
      conversationId: conversationId as Member['conversationId'],
      userId: peer.userId as Member['userId'],
      displayName: peer.displayName,
      avatarMediaId: peer.avatarMediaId,
      leftAt: peer.leftAt === null ? null : peer.leftAt.toISOString(),
      mutedAt: null,
    }));

    let presence: Presence[] = [];
    if (row.kind === 'direct' && peers.length > 0) {
      const online = await presenceOf(peers.map((peer) => String(peer.userId)));
      presence = peers.map((peer) => ({
        userId: peer.userId,
        online: online.get(String(peer.userId)) ?? false,
      }));
    }

    const permission = await canSend(conversationId, viewerId);

    items.push(
      conversationListItem.parse({
        conversationId,
        kind: row.kind,
        title: row.title,
        lastSeq: seqFromBigInt(BigInt(row.lastSeq)),
        unreadCount,
        muted: mutedByConversation.get(conversationId) ?? false,
        presence,
        peers: row.kind === 'direct' ? peers : undefined,
        permission,
      }),
    );
  }
  return items;
}
