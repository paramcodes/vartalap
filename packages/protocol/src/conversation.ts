import { z } from 'zod';
import { conversationId, messageId, seq, mediaId, seqToBigInt, userId, type Seq } from './scalars.ts';

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

export type Membership = z.infer<typeof membership>;

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
  /** null while the message is a queued send. Assigned by the server, never by a client. */
  seq: seq.nullable(),
  /** client clock — for display only, NEVER for order. */
  createdAt: z.string().datetime(),
});

export type Message = z.infer<typeof message>;

/**
 * The state a **stored** message row carries, and nothing else.
 *
 * It was `pending | sent | delivered | read`, which is four RENDERINGS and none of
 * them storage:
 *
 * - `delivered` and `read` are facts about a **member's** relationship to a
 *   position, not about a message. They live in `delivery` and `receipt` (ADR 0003,
 *   ADR 0010), and copying them onto a row is the second source of truth the
 *   glossary bans — the moment either is wrong, the two disagree and nothing says
 *   which one to believe.
 * - `sent` is not stored either. It is `seq !== null` and that is the whole test
 *   (ADR 0004: `seq` is null exactly once, between the optimistic write and the
 *   server's acknowledgement).
 *
 * What IS local to the row and nowhere else is the state of the request: is it
 * waiting for a window, is it open, or has the server definitively refused it.
 * Those three are what a browser can know with no network at all, which is why
 * they are the only ones here.
 *
 * `composer-and-sending.md` calls this "five sources, four renderings, one
 * indicator", and `queued` is the word — a **queued send** is the glossary's term
 * for a message the server has not acknowledged. "Pending message" is on its avoid
 * list. The send endpoint's response is what moves a row between these states; see
 * `docs/concepts/composer-and-sending.md`, ADR 0004, and **ADR 0060**, which is
 * where the split between stored and derived state is decided.
 */
export const messageState = z.enum(['queued', 'inFlight', 'failed']);
export type MessageState = z.infer<typeof messageState>;

/**
 * What the interface renders for one message — derived on every render and NEVER
 * stored, unlike {@link messageState}.
 *
 * Three of these come off the row alone (`queued`, `inFlight`, `failed`), one is
 * the row's `seq` (`sent`), and two come off watermarks that belong to **members**
 * (`delivered`, `read`). Nothing here is a property of a Message: a Message is
 * authored content and nothing else. ADR 0060.
 *
 * `delivered` and `read` deliberately do not use Messenger's word. "Seen" is
 * interface copy only — it appears in no schema, no protocol, and no model
 * (`GLOSSARY.md`), and the indicator that prints it is computed over
 * `shared_through`, never over this enum.
 */
export const renderedMessageState = z.enum([
  'queued',
  'inFlight',
  'sent',
  'delivered',
  'read',
  'failed',
]);

export type RenderedMessageState = z.infer<typeof renderedMessageState>;

export interface MessageStateInput {
  /**
   * The row's stored state, or `null`.
   *
   * ⚠️ **`null` is the positioned row**, and it was added by ADR 0061 when the
   * client data layer turned this function into a library rather than a
   * description. The enum above is the set of states a browser can know *before
   * the server has answered*; once the server HAS answered there is nothing left
   * to know locally, and a row that carries a position has to be able to say so.
   * Withholding it forced one of two lies — either a committed row kept a stale
   * `'queued'`, which puts a message nobody should send back into the send queue,
   * or every caller invented a value to satisfy the type.
   *
   * `null` is safe as an input rather than a lie because this function checks
   * `position` before `state`: a row with `state: null` always has one, so the
   * `state === 'inFlight' ? … : 'queued'` branch below is unreachable for it.
   */
  state: MessageState | null;
  /** The row's `seq`, or null while the server has not assigned one. */
  position: Seq | null;
  /**
   * `delivery.delivered_through`, ALREADY REDUCED by the caller to the members this
   * rendering is about. The protocol compares a position against a watermark; it
   * does not decide which members qualify — that predicate, its exclusions, and
   * `shared_through` versus `read_through` belong to ADR 0003 and are render logic,
   * not wire shape.
   */
  deliveredThrough: Seq | null;
  /** The same reduction of the receipt watermark. See ADR 0003. */
  readThrough: Seq | null;
}

/**
 * The one function that turns stored state plus watermarks into something to draw.
 *
 * The watermarks arrive **already reduced** to the members this rendering is about.
 * The reduction is ADR 0003's predicate — which members qualify, and over
 * `shared_through` rather than `read_through` — and duplicating it inside a schema
 * would be a second implementation of a privacy decision, which is the shape of bug
 * this repo keeps paying for. See ADR 0060.
 *
 * The ordering is the argument:
 *
 * 1. `failed` first, because a definitive rejection outranks everything — the row
 *    is not going anywhere and no later frame changes that.
 * 2. No position means the server has not answered, so the row is still local. An
 *    open request renders differently from one waiting for a window, and that is
 *    the only difference between them.
 * 3. A position means it is committed, which is the durability guarantee ADR 0004
 *    exists for. From there the watermarks say how far it has travelled.
 *
 * Read is checked before delivered, and read implies having: a member who has read
 * it has necessarily received it.
 */
export function deriveRenderedMessageState(input: MessageStateInput): RenderedMessageState {
  const { state, position, deliveredThrough, readThrough } = input;

  if (state === 'failed') return 'failed';
  if (position === null) return state === 'inFlight' ? 'inFlight' : 'queued';

  const at = seqToBigInt(position);
  if (readThrough !== null && seqToBigInt(readThrough) >= at) return 'read';
  if (deliveredThrough !== null && seqToBigInt(deliveredThrough) >= at) return 'delivered';
  return 'sent';
}

/**
 * Why a member may not send to a conversation — and WHY not, because `blocked_by_me`
 * and `blocked_by_them` say opposite things and a boolean cannot carry that.
 * One implementation, called from both the send path and the UI. See ADR 0007.
 *
 * Named separately because two consumers need it: the UI renders it, and the error
 * envelope names it on a refused send. Inlining the enum into the union twice would
 * be two lists that drift.
 */
export const sendBlockReason = z.enum([
  'blocked_by_me',
  'blocked_by_them',
  'not_a_member',
  'too_many_members',
]);

export type SendBlockReason = z.infer<typeof sendBlockReason>;

export const sendPermission = z.discriminatedUnion('allowed', [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), reason: sendBlockReason }),
]);

export type SendPermission = z.infer<typeof sendPermission>;

export const MAX_GROUP_MEMBERS = 500;
export type { Seq };