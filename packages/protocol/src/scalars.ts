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
 * The version is CHECKED, not assumed. `z.string().uuid()` was doing the whole job
 * and it is not enough: its pattern matches any hex UUID shape without ever
 * reading the version nibble, so a v4 passed under a message promising a v7 —
 * and so did `ffff`. Two failures come out of that. A reader who trusts the error
 * believes they hold a guarantee they never got, and a client that quietly minted
 * a v4 keeps working right up until something reads the v7 timestamp that only a
 * v7 has. The custom message is gone rather than reworded: the default "Invalid
 * uuid" is true, and a message that names the real constraint carries it.
 *
 * Note what this is NOT used for: ordering. The v7 timestamp is the *client's*
 * clock, clients skew, and RFC 9562's same-millisecond monotonicity is a single-node
 * construct that does not survive a connection pool. Order is `seq`. That is why
 * validating the version here is honouring the stated contract and not making the
 * ordering guarantee safer — nothing about the ordering guarantee reads this.
 */
export const messageId = z
  .string()
  .uuid()
  /**
   * Position 15 of the canonical form is the version nibble:
   * `xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx`. Eight hex, a dash, four hex, a dash,
   * then M. It is a digit, so there is no case to normalise first.
   */
  .refine((value) => value[14] === '7', 'must be a UUIDv7: the version nibble at position 15 must be 7')
  .brand<'MessageId'>();

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