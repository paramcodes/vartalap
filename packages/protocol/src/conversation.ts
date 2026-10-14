import { z } from 'zod';
import { conversationId, messageId, seq, mediaId, userId, type Seq } from './scalars.ts';

/**
 * A Conversation and its membership. See ADR 0007.
 *
 * `kind` is a discriminator, not a type hierarchy: Direct and Group conversations are
 * rows in ONE table, because every read path — conversation list, unread badge,
 * last-message preview, drafts, read state, socket subscription, push — is written
 * once against a single shape. Splitting the table duplicates all of it, and the
 * duplication compounds with every feature added afterwards.
 *
 * The cost is named: every query carries a `kind` filter that will occasionally be
 * forgotten, and direct rows carry nullable fields that are always null.
 */

/**
 * The canonical pair key: two user ids sorted and joined by `:`. Nullable, and
 * `UNIQUE` on it — Postgres treats NULLs as distinct by default, so one index gives
 * "exactly one conversation per direct pair" AND "unlimited group rows".
 *
 * `0` rather than `NULL` for `lastSeq`: IndexedDB does not index `null`, so a
 * conversation that has never had a message would sort unpredictably in Dexie.
 */
export const conversation = z.object({
  id: conversationId,
  kind: z.enum(['direct', 'group']),
  /** Present iff kind === 'direct'. Enforced by a CHECK constraint. */
  directKey: z.string().nullable(),
  /** Groups only; direct conversations DERIVE their title from the other member. */
  title: z.string().nullable(),
  /** What the conversation list orders by, descending. Never NULL. */
  lastSeq: seq,
});

export type Conversation = z.infer<typeof conversation>;

/**
 * A Member. Retained with `leftAt` when they leave — a Former member remains one,
 * nothing is deleted, and a rejoining member INHERITS their receipt, because a stale
 * receipt is true and a zeroed one is a lie. See ADR 0007 and ADR 0010.
 */
export const member = z.object({
  conversationId,
  userId,
  displayName: z.string().min(1).max(64),
  avatarMediaId: mediaId.nullable(),
  /** Set when they left. Non-null means Former member. */
  leftAt: z.string().datetime().nullable(),
  mutedAt: z.string().datetime().nullable(),
});

export type Member = z.infer<typeof member>;

export const membership = z.object({
  conversation: conversation,
  members: z.array(member),
});

/**
 * An Attachment is one Message's reference to one piece of Media (ADR: glossary).
 * Media itself is never embedded in a frame — only its id, and only once the worker
 * has flipped it to `ready`. See ADR 0008.
 */
export const attachment = z.object({
  mediaId,
  /** Which derived variant the client should request. */
  variant: z.enum(['thumb', 'preview', 'full']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type Attachment = z.infer<typeof attachment>;

/**
 * A Message is authored content and nothing else — text, or one or more
 * attachments. It is NOT "read", "unread", or "delivered": those are facts about a
 * member's relationship to a position in the transcript, and they live in `receipt`
 * and `delivery` (ADR 0003).
 *
 * `seq` is null exactly once: between the optimistic local write and the server's
 * acknowledgement. A client may NEVER interpolate it from local time. See ADR 0004.
 */
export const message = z.object({
  id: messageId,
  conversationId,
  authorId: userId,
  body: z.string().max(8192),
  attachments: z.array(attachment),
  /** null while pending. Assigned by the server, never by a client. */
  seq: seq.nullable(),
  /** client clock — for display only, NEVER for order. */
  createdAt: z.string().datetime(),
});

export type Message = z.infer<typeof message>;

/** The four states a message passes through. See ADR 0004. */
export const messageState = z.enum(['pending', 'sent', 'delivered', 'read']);
export type MessageState = z.infer<typeof messageState>;

/**
 * Whether a member may send to a conversation — and WHY not, because `blocked_by_me`
 * and `blocked_by_them` say opposite things and a boolean cannot carry that.
 * One implementation, called from both the send path and the UI. See ADR 0007.
 */
export const sendPermission = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: z.enum(['blocked_by_me', 'blocked_by_them', 'not_a_member', 'too_many_members']) }),
]);

export type SendPermission = z.infer<typeof sendPermission>;

export const MAX_GROUP_MEMBERS = 500;
export type { Seq };