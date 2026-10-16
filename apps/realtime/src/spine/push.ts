/**
 * Push notifications (ADR 0011, Gate S2).
 *
 * An independent consumer of the outbox row:
 * - Two-layer suppression: Redis presence TTL, then watermark delivered_through >= seq.
 * - Payload contains ONLY { conversationId, messageId, senderName, title, body: "New message" }.
 *   The message body is NEVER included.
 * - Endpoint is a capability URL with SSRF guards.
 * - Dead endpoints (404/410) are purged immediately.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, delivery, pushSubscription } from '@vartalap/database';
import {
  pushPayload,
  type PushPayload,
  type PushSubscriptionRequest,
  type Seq,
} from '@vartalap/protocol';
import { isOnline, type PresenceStore } from './presence.ts';

export function isSafeEndpoint(endpointUrl: string): boolean {
  try {
    const parsed = new URL(endpointUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function buildPushPayload(params: {
  conversationId: string;
  messageId: string;
  senderName: string;
}): PushPayload {
  return pushPayload.parse({
    conversationId: params.conversationId,
    messageId: params.messageId,
    senderName: params.senderName,
    title: params.senderName,
    body: 'New message',
  });
}

export async function savePushSubscription(
  userId: string,
  sub: PushSubscriptionRequest,
  userAgent?: string | null,
  dbInstance = defaultDb,
): Promise<void> {
  if (!isSafeEndpoint(sub.endpoint)) {
    throw new Error('unsafe push endpoint rejected');
  }

  await dbInstance
    .insert(pushSubscription)
    .values({
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscription.endpoint,
      set: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: userAgent ?? null,
      },
    });
}

export async function removePushSubscription(
  userId: string,
  endpoint: string,
  dbInstance = defaultDb,
): Promise<void> {
  await dbInstance
    .delete(pushSubscription)
    .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
}

export async function purgeDeadSubscription(endpoint: string, dbInstance = defaultDb): Promise<void> {
  await dbInstance.delete(pushSubscription).where(eq(pushSubscription.endpoint, endpoint));
}

export async function isSuppressedByPresence(
  store: PresenceStore,
  userId: string,
): Promise<boolean> {
  try {
    return await isOnline(store, userId);
  } catch {
    // If Redis is unreachable, fail safe: don't suppress push
    return false;
  }
}

export async function isSuppressedByDelivery(
  params: {
    userId: string;
    conversationId: string;
    seq: Seq;
  },
  dbInstance = defaultDb,
): Promise<boolean> {
  const targetSeq = Number(params.seq);
  const rows = await dbInstance
    .select({ deliveredThrough: delivery.deliveredThrough })
    .from(delivery)
    .where(
      and(
        eq(delivery.userId, params.userId),
        eq(delivery.conversationId, params.conversationId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return false;
  return rows[0]!.deliveredThrough >= targetSeq;
}

export async function shouldPush(
  params: {
    recipientId: string;
    conversationId: string;
    seq: Seq;
  },
  presenceStore?: PresenceStore,
  dbInstance = defaultDb,
): Promise<boolean> {
  if (presenceStore && (await isSuppressedByPresence(presenceStore, params.recipientId))) {
    return false;
  }
  if (await isSuppressedByDelivery({ ...params, userId: params.recipientId }, dbInstance)) {
    return false;
  }
  return true;
}
