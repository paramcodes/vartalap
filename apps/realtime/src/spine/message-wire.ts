/**
 * The ONE row → wire conversion for a Message.
 *
 * It lives here rather than in `send.ts` because stage 3 has two readers and one
 * writer: the send path answers with a message, `history.ts` answers with fifty,
 * and `catch-up` answers with a page spanning every conversation. Three copies of
 * a twelve-line mapper is three places where the wire shape is decided, and the
 * failure mode is a body one client can read and another cannot.
 *
 * **It PARSES rather than validating.** `message.parse` throws on anything this
 * file gets wrong, which turns a wrong column name into a failed request instead
 * of a body a client has to guess at — and `seq` is `null` in the wire type
 * exactly once, between the optimistic local write and the server's answer
 * (ADR 0060), so a row read back from the database is a row whose position the
 * schema will check for us.
 *
 * **A `bigint` leaves as a decimal string, never a number** (ADR 0005,
 * `scalars.ts`): `JSON.parse` of a bare number above 2^53 loses precision with no
 * error, and a position that stops ordering is the failure this column exists to
 * prevent.
 *
 * ── attachments ───────────────────────────────────────────────────────────────
 *
 * `[]` is the honest answer for every row this server has written, and the reason
 * is that the send path REFUSES attachments with a `422` rather than storing what
 * the wire cannot read back: `message_attachment` holds `media_id` and `position`
 * and no `variant`, so a stored reference cannot be reproduced as a protocol
 * `Attachment`. `send.ts` says the same thing at the refusal; this is the other
 * half of it, on the read side. The moment the media path lands, the two readers
 * stop defaulting to `[]` and start joining the table — and until then, an empty
 * list is true rather than convenient.
 */
import {
  conversationId as conversationIdScalar,
  message as messageWire,
  messageId as messageIdScalar,
  seqFromBigInt,
  userId as userIdScalar,
  type Attachment,
  type Message,
} from '@vartalap/protocol';

/**
 * The one row shape the spine reads and writes.
 *
 * `seq` arrives from Drizzle as a `number` because `schema.ts` declares the column
 * `mode: 'number'`; the wire gets a decimal string back out of it. Neither the
 * driver nor this file pretends to carry more precision than the adapter does.
 */
export interface StoredMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly body: string;
  readonly seq: number;
  /** The CLIENT's clock — the wire's `createdAt`, and never a sort key. */
  readonly clientCreatedAt: Date;
}

/**
 * `attachments` is the CANONICAL list — sorted by `mediaId`, duplicates collapsed,
 * the form `canonicalAttachments` in `send.ts` produces. This function does not
 * canonicalise, because canonicalisation is a comparison concern that belongs to
 * the one place that compares (ADR 0059) and a second implementation of it here
 * would be a third place to keep in sync.
 */
export function toWireMessage(row: StoredMessage, attachments: readonly Attachment[] = []): Message {
  return messageWire.parse({
    id: messageIdScalar.parse(row.id),
    conversationId: conversationIdScalar.parse(row.conversationId),
    authorId: userIdScalar.parse(row.authorId),
    body: row.body,
    attachments: [...attachments],
    // Never null here: a row read back from the database has been assigned one.
    seq: seqFromBigInt(BigInt(row.seq)),
    createdAt: row.clientCreatedAt.toISOString(),
  });
}