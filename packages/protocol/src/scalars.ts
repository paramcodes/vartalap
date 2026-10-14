import { z } from 'zod';

/**
 * Scalars that cross the wire, and the traps each one carries.
 *
 * The one that bites silently: **a Postgres `bigint` does not survive JSON.**
 * `messages.seq` is a `bigint`, and `JSON.parse` of a bare number above 2^53 loses
 * precision without error. A position is therefore a **decimal string on the wire,
 * always** — never a number, not "a number for now". The branded type below makes
 * that a type error rather than a corruption that surfaces months later as a
 * message that will not order correctly.
 *
 * The other: a Message's id is a client-generated UUIDv7, and it is simultaneously
 * the identity and the idempotency key (ADR 0004). One value, two jobs. The server
 * trusts it for identity and for nothing else.
 */

/** A server-assigned, per-conversation position. See ADR 0005. Decimal string. */
export const seq = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'seq must be a non-negative decimal string')
  .brand<'Seq'>();

export type Seq = z.infer<typeof seq>;

/**
 * A client-generated UUIDv7. This is the Message's identity AND its idempotency
 * key — one value, two jobs. See ADR 0004.
 *
 * Note what this is NOT used for: ordering. The v7 timestamp is the *client's*
 * clock, clients skew, and RFC 9562's same-millisecond monotonicity is a single-node
 * construct that does not survive a connection pool. Order is `seq`.
 */
export const messageId = z.string().uuid('must be a UUIDv7').brand<'MessageId'>();

export type MessageId = z.infer<typeof messageId>;

/** A user's Handle: unique, case-normalized. The alphabet excludes `.` — see ADR 0017. */
export const handle = z
  .string()
  .regex(/^[a-z0-9_]{3,20}$/, 'handle must match ^[a-z0-9_]{3,20}$, already lowercased')
  .brand<'Handle'>();

export type Handle = z.infer<typeof handle>;

export const userId = z.string().uuid().brand<'UserId'>();
export type UserId = z.infer<typeof userId>;

export const conversationId = z.string().uuid().brand<'ConversationId'>();
export type ConversationId = z.infer<typeof conversationId>;

/** A Media id, referenced by an Attachment on a Message. See ADR 0008. */
export const mediaId = z.string().uuid().brand<'MediaId'>();
export type MediaId = z.infer<typeof mediaId>;

/**
 * Normalize a candidate Handle before it is checked. Normalisation happens INSIDE the
 * auth plugin, not in the database (ADR 0001), which is exactly why the database
 * also carries `UNIQUE (lower(username))` as a safety net.
 */
export const normalizeHandle = (candidate: string): string => candidate.trim().toLowerCase();

/** Validate a candidate Handle and return it normalized, or null. */
export const parseHandle = (candidate: string): Handle | null => {
  const result = handle.safeParse(normalizeHandle(candidate));
  return result.success ? result.data : null;
};

/** `bigint` (Postgres) <-> decimal string (JSON). */
export const seqToBigInt = (value: Seq): bigint => BigInt(value);
export const seqFromBigInt = (value: bigint): Seq => seq.parse(value.toString(10));