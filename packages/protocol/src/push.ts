import { z } from 'zod';
import { conversationId, messageId, userId } from './scalars.ts';

/**
 * ADR 0011: Push payload carries only enough to render the notification
 * and route the tap. The message body NEVER enters the payload.
 */
export const pushPayload = z.object({
  conversationId,
  messageId,
  senderName: z.string().min(1),
  title: z.string().min(1),
  body: z.literal('New message'),
});

export type PushPayload = z.infer<typeof pushPayload>;

export const pushSubscriptionKeys = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export const pushSubscriptionRequest = z.object({
  endpoint: z.string().url(),
  keys: pushSubscriptionKeys,
});

export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequest>;
