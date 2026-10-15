/**
 * The send path. Gate G1.
 *
 * One function, one transaction, and the order inside that transaction is the
 * decision this file exists to hold:
 *
 *     BEGIN
 *       pg_advisory_xact_lock(hashtextextended($1::uuid::text, 8530225013392695664))
 *       INSERT INTO message   (…, client_created_at, created_at)
 *       INSERT INTO outbox    (message_seq, conversation_id, payload)
 *       UPDATE conversation SET last_seq = <the new seq>
 *     COMMIT
 *
 * — and only then does anything answer the request.
 *
 * Three things are load-bearing and none of them is visible in the listing above.
 *
 * ── the lock ──────────────────────────────────────────────────────────────────
 *
 * `pg_advisory_xact_lock` is one line carrying the entire anti-inversion guarantee
 * (ADR 0005), and ADR 0005 says it "carries no comment of its own and no test". So
 * this comment IS the comment it did not have, and `send.test.ts` is the test it
 * did not have. Gate **G1a** asserts that this statement is emitted, inside the
 * transaction that inserts the message, before the insert — which is the only part
 * of the guarantee that can be proved on a machine with no Postgres server.
 *
 * **The derivation is ADR 0056's and it is written down there. Do not compute this
 * key in JavaScript, do not interpolate the seed from configuration, and do not
 * drop the `::uuid::text`.** Three separate failures, one line:
 *
 * - A JS reimplementation is a second implementation of a function that already
 *   exists inside the server. Nothing compares the two, so a mismatch is silent.
 * - The expression belongs INSIDE the lock statement so the key never crosses the
 *   driver, and so G1a asserts a statement that still contains the derivation.
 * - `::uuid::text` is the normalisation, not a cast. `uuid` output is canonical
 *   lowercase-hyphenated, and hashing the raw string gives four different locks for
 *   four spellings of one conversation — measured in ADR 0056, and it is one
 *   `.toUpperCase()` in a request builder away.
 *
 * There is deliberately **no JavaScript constant for the seed**, because a constant
 * is a second copy of it. The literal below is the only one, and it is greppable.
 *
 * ── both timestamps ───────────────────────────────────────────────────────────
 *
 * `client_created_at` is `NOT NULL` with no default and `created_at` defaults to
 * `now()`. Supplying only one of them fails the insert and takes the outbox row
 * down with it (decisions index, trap 16). Neither is ever a sort key.
 *
 * ── the outbox payload is a validated frame ───────────────────────────────────
 *
 * `packages/protocol` owns the shape of `message.created` and the outbox stores
 * the frame itself, parsed by `serverFrame.parse` before it is written. The relay
 * publishes `payload` VERBATIM (ADR 0057), so "what the relay sends" and "what the
 * protocol says a frame is" cannot drift: there is one object, validated once,
 * round-tripped through `jsonb`.
 *
 * The row → wire conversion itself is in `message-wire.ts`, because the read path
 * needs the same one and two copies of it is two places where the wire shape of a
 * Message is decided.
 */
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { conversation, db, message, outbox } from '@vartalap/database';
import {
  conversationId as conversationIdScalar,
  serverFrame,
  type Attachment,
  type Message,
  type SendBlockReason,
  type SendConflictField,
  type SendMessageRequest,
} from '@vartalap/protocol';
import { canSend } from './blocks.ts';
import { toWireMessage, type StoredMessage } from './message-wire.ts';

/**
 * SQLSTATE for a unique violation. Not sufficient on its own — see
 * {@link isIdempotencyConflict}, which needs the constraint's name too.
 */
const UNIQUE_VIOLATION = '23505';
const MESSAGE_ID_CONSTRAINT = 'message_id_key';

export interface SendCommand {
  /** The authenticated sender. The server never takes this from the body. */
  readonly authorId: string;
  readonly request: SendMessageRequest;
}

/**
 * ADR 0059's three answers, plus the one refusal this path can make.
 *
 * `created` and `deduplicated` differ ONLY in the flag: both carry the row, and
 * both carry its `seq`. Returning the ORIGINAL row with its position on a retry is
 * the entire point of the middle outcome — it is what lets a client reconcile from
 * its own retry response instead of waiting for an echo of itself over the socket.
 */
export type SendOutcome =
  | { readonly kind: 'created'; readonly message: Message }
  | { readonly kind: 'deduplicated'; readonly message: Message }
  | { readonly kind: 'conflict'; readonly conflictingFields: readonly SendConflictField[] }
  | { readonly kind: 'notAMember' }
  | { readonly kind: 'sendBlocked'; readonly reason: SendBlockReason }
  | { readonly kind: 'attachmentsUnsupported' };

/**
 * Canonical form for attachments, and the comparison ADR 0059 is built on.
 *
 * Ordered by `mediaId`, duplicates collapsed. Two clients that picked the same
 * photos in a different order sent the same message, and a `409` for a
 * reordering is a false accusation — and false accusations are how a retryable
 * path loses its credibility.
 *
 * ⚠️ **The stored side cannot currently honour the `variant` ADR 0059 also lists.**
 * `message_attachment` holds `media_id` and `position` and nothing else, so a
 * stored reference does not say which derived size was asked for. This function is
 * therefore exact on the wire side and on the ids, and says nothing about
 * variants. It is the shape the comparison uses the moment the media path lands;
 * it is not a claim that the storage is complete. See `attachmentsUnsupported`
 * below for why 3.C refuses attachments rather than storing what it cannot
 * reproduce.
 */
export function canonicalAttachments(attachments: readonly Attachment[]): Attachment[] {
  const byMediaId = new Map<string, Attachment>();
  for (const attachment of attachments) {
    // First write wins. A duplicate is a client slip, not a second attachment, and
    // the alternative — erroring — would make a harmless retry fail.
    if (!byMediaId.has(attachment.mediaId)) byMediaId.set(attachment.mediaId, attachment);
  }
  return [...byMediaId.values()].sort((a, b) => (a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0));
}

/** Read the stored row fresh. `null` when this idempotency key was never used. */
async function readStored(id: string): Promise<StoredMessage | null> {
  const rows = await db
    .select({
      id: message.id,
      conversationId: message.conversationId,
      authorId: message.authorId,
      body: message.body,
      seq: message.seq,
      clientCreatedAt: message.clientCreatedAt,
    })
    .from(message)
    .where(eq(message.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The four compared fields, and ONLY those four (ADR 0059).
 *
 * A comparison over a field the client controls and the server discards is a
 * source of `409`s no member can act on. `createdAt` and `seq` are therefore not
 * compared even though a client could plausibly send them: they are not content.
 */
function conflictingFields(
  stored: StoredMessage,
  request: SendMessageRequest,
  authorId: string,
  storedAttachments: readonly Attachment[],
): SendConflictField[] {
  const fields: SendConflictField[] = [];
  if (stored.body !== request.body) fields.push('body');
  if (stored.conversationId !== request.conversationId) fields.push('conversationId');
  // One key bound to two authors is a client bug, and answering `200` would hide
  // it: the second author would see their own text attached to somebody else's
  // send with nothing anywhere saying why.
  if (stored.authorId !== authorId) fields.push('authorId');

  const before = canonicalAttachments(storedAttachments).map((a) => a.mediaId).join('|');
  const after = canonicalAttachments(request.attachments).map((a) => a.mediaId).join('|');
  if (before !== after) fields.push('attachments');

  return fields;
}

/**
 * Is this the dedupe path, or some other unique constraint?
 *
 * Both halves matter. `23505` alone would swallow a violation of any constraint
 * and answer `409` for a bug that is not a conflict, and `constraint_name` alone
 * would fire on a re-save of the same row rather than on a collision.
 */
function isIdempotencyConflict(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return candidate.code === UNIQUE_VIOLATION && candidate.constraint_name === MESSAGE_ID_CONSTRAINT;
}

/**
 * Send a message.
 *
 * Refusals that happen BEFORE the transaction are the ones that leave the
 * idempotency key unconsumed, which is the whole point of there being no separate
 * "reserve the key" write: a reservation that outlives a rolled-back transaction
 * is a key consumed by a failure that never executed (ADR 0059).
 */
export async function sendMessage(command: SendCommand): Promise<SendOutcome> {
  const { authorId, request } = command;

  // Membership AND blocks, before anything is written — and before anything is
  // said about the request's validity, because there is no reason to tell a
  // non-member that their attachments are the wrong shape.
  //
  // ADR 0007 puts the "can this user send" predicate in the application, once,
  // and `canSend` IS that one copy: membership plus the block check between
  // the direct pair (stage 5.B), asked the same way the receipt and delivery
  // paths ask `isCurrentMember`. Blocks gate sending, never reading, so the
  // watermark paths keep the membership-only predicate — correctly, not as
  // leftover.
  const permission = await canSend(request.conversationId, authorId);
  if (!permission.allowed) {
    if (permission.reason === 'not_a_member') return { kind: 'notAMember' };
    return { kind: 'sendBlocked', reason: permission.reason };
  }

  // `message-lifecycle.md` says the media seam exists and does not cross it, and
  // this is where that is enforced rather than assumed. A `422`, not a silent
  // drop: `message_attachment` cannot round-trip a protocol Attachment (no
  // `variant`), so a stored attachment could never be reproduced in a dedupe
  // response, and the alternative — accept them and store what the wire cannot
  // read back — is a state where the database claims a message has attachments
  // and the server cannot show them. Terminal on the wire by the composer's own
  // test: retrying these identical bytes reaches this identical answer.
  if (request.attachments.length > 0) return { kind: 'attachmentsUnsupported' };

  const clientCreatedAt =
    request.clientCreatedAt !== undefined ? new Date(request.clientCreatedAt) : new Date();

  try {
    const row = await db.transaction(async (tx) => {
      // 1. THE LOCK. Before the insert, inside this transaction, or not at all.
      //    `db.transaction` is postgres.js's `begin`, so this statement and the
      //    insert below share one connection and one transaction — which is what
      //    makes the lock transaction-scoped and self-releasing (ADR 0005).
      //
      //    ADR 0056's derivation, verbatim. The seed is `0x76617274616C6170` —
      //    ASCII `vartalap` — legible on purpose, so a reader who has never opened
      //    that ADR can tell at a glance that the number is ours and not a hash
      //    copied out of another project.
      //
      //    `$1` is BOUND, never interpolated. `hashtextextended` is IMMUTABLE, so
      //    with a literal the planner folds the whole expression to a constant at
      //    plan time; the bound-parameter case is the one that matters.
      await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${request.conversationId}::uuid::text, 8530225013392695664))`);

      // 2. The message, with BOTH timestamps supplied.
      const [inserted] = await tx
        .insert(message)
        .values({
          id: request.id,
          conversationId: request.conversationId,
          authorId,
          body: request.body,
          clientCreatedAt,
        })
        .returning({ seq: message.seq });
      if (inserted === undefined) throw new Error('the message insert returned no row');

      const stored: StoredMessage = {
        id: request.id,
        conversationId: request.conversationId,
        authorId,
        body: request.body,
        seq: inserted.seq,
        clientCreatedAt,
      };

      // 3. The outbox row, in the SAME transaction and BEFORE the response. The
      //    payload is the frame the relay will publish, validated first — so a
      //    malformed payload cannot reach the table and cannot reach a client.
      const frame = serverFrame.parse({
        type: 'message.created',
        conversationId: conversationIdScalar.parse(stored.conversationId),
        message: toWireMessage(stored),
      });
      await tx.insert(outbox).values({
        messageSeq: inserted.seq,
        conversationId: stored.conversationId,
        payload: frame,
      });

      // 4. The conversation's position, which the conversation list orders by.
      await tx
        .update(conversation)
        .set({ lastSeq: inserted.seq })
        .where(eq(conversation.id, stored.conversationId));

      return stored;
    });

    return { kind: 'created', message: toWireMessage(row) };
  } catch (error) {
    if (!isIdempotencyConflict(error)) throw error;

    // ── the dedupe re-read, and why it CANNOT be in that transaction ──────────
    //
    // postgres.js rolls the transaction back the moment the callback rejects, so
    // the `23505` above arrives with the transaction already GONE: every further
    // statement on it would answer `25P02` (in_failed_sql_transaction). That is
    // not a style note, it is the shape of the bug — doing the re-read on the
    // aborted transaction produces a dedupe path that reads the row as "absent"
    // and answers `409` for a retry of a message that committed perfectly well.
    //
    // So the re-read is a fresh query, after the rollback. It is safe because the
    // rollback left the first transaction nothing behind: a colliding `id` means a
    // COMMITTED row exists, not an in-flight one.
    const stored = await readStored(request.id);
    if (stored === null) throw error;

    // `[]` on the stored side because a message in this table cannot HAVE
    // attachments: the send path refuses them above, so every row it wrote has an
    // empty list. Passing it explicitly rather than defaulting keeps the gap
    // visible when the media path lands.
    const fields = conflictingFields(stored, request, authorId, []);
    if (fields.length > 0) return { kind: 'conflict', conflictingFields: fields };

    return { kind: 'deduplicated', message: toWireMessage(stored) };
  }
}