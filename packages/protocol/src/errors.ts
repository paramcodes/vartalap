import { z } from 'zod';
import { sendBlockReason } from './conversation.ts';

/**
 * The error envelope.
 *
 * There was none. `apps/realtime` answered `401` with a hand-written
 * `{ error: { code, message } }`, nothing else existed anywhere, and `409` and the
 * Postgres codes had no shape at all — which matters because the send path's whole
 * retry story depends on it.
 *
 * `composer-and-sending.md` separates failures that back off and stay queued from
 * failures that become a visible `Not sent`:
 *
 * | outcome                        | retryable | code                    |
 * |---|---|---|
 * | `401`                          | yes | `unauthenticated`       |
 * | `408`                          | yes | `requestTimeout`        |
 * | `425`                          | yes | `tooEarly`              |
 * | `429`                          | yes | `rateLimited`           |
 * | `5xx`                          | yes | `internal`              |
 * | a locked conversation          | yes | `sendBlocked`           |
 * | `409`                          | **no**  | `idempotencyConflict`   |
 * | `400`                          | **no**  | `invalidRequest`        |
 * | `413`                          | **no**  | `payloadTooLarge`       |
 * | `422`                          | **no**  | `unprocessable`         |
 * | `404` / `405`                  | **no**  | `notFound` / `methodNotAllowed` |
 * | not a member, on a non-send write | yes  | `notAMember`                   |
 *
 * **A client must be able to make that call without reading a status code**, so
 * retryability is a field, not a lookup table it has to mirror. It is a `z.literal`
 * per branch rather than a boolean on the envelope, which is what makes
 * `{ code: 'rateLimited', retryable: false }` unparseable instead of merely wrong.
 *
 * ⚠️ No code-to-status table lives here. A status is the server's to choose, and a
 * second table beside this one would be a second source of truth that could disagree
 * about whether a `409` is retryable.
 */

/** A human-readable sentence. Never parsed by a client — `code` is what they read. */
const message = z.string().min(1);

/**
 * A SQLSTATE, so a database failure is recognisable rather than prose. Five
 * characters, which is what `23505` (unique violation) and `40001` (serialization
 * failure) both are, and the constraint is what stops a whole class of driver
 * message from landing here.
 */
const postgresCode = z
  .string()
  .regex(/^[0-9A-Z]{5}$/, 'must be a five-character SQLSTATE, e.g. 23505');

/**
 * The fields compared when one idempotency key arrives twice, and therefore
 * exactly what decides whether the answer is `200` or `409`.
 *
 * `attachments` is compared CANONICALISED — ordered by media id, `variant` included,
 * no duplicates — because two clients that picked the same photo in a different
 * order sent the same message and a client bug is a binding failure, not a
 * reordering. The decision itself is in ADR 0059; this list is its wire form.
 */
export const sendConflictField = z.enum(['body', 'attachments', 'conversationId', 'authorId']);

export type SendConflictField = z.infer<typeof sendConflictField>;

export const errorBody = z.discriminatedUnion('code', [
  // ── retryable ───────────────────────────────────────────────────────────────
  // A re-authentication re-flushes the send queue, so a signed-out member's send
  // stays queued rather than failing.
  z.object({ code: z.literal('unauthenticated'), message, retryable: z.literal(true) }),

  z.object({ code: z.literal('requestTimeout'), message, retryable: z.literal(true) }),

  z.object({ code: z.literal('tooEarly'), message, retryable: z.literal(true) }),

  z.object({
    code: z.literal('rateLimited'),
    message,
    retryable: z.literal(true),
    /** Honour it AND reset the backoff: the server has answered. */
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),

  z.object({
    code: z.literal('internal'),
    message,
    // Ambiguous by construction — the send may well have committed, and the
    // idempotency key is what makes a retry safe rather than a second message.
    retryable: z.literal(true),
    postgresCode: postgresCode.optional(),
  }),

  z.object({
    code: z.literal('sendBlocked'),
    message,
    // RETRYABLE, and the interesting case in this file. `composer-and-sending.md`'s
    // test is "could retrying these identical bytes plausibly produce a different
    // status?" and a block is the clearest YES on this list: it is server-side
    // state, it can be lifted by the other member, and the member who is blocked
    // does not even have to do anything for it to change. So the send stays queued
    // and flushes on the next backoff tick after the block lifts.
    //
    // The member-facing affordance is a SEPARATE concern and the two are easy to
    // conflate: the composer renders `You can't send messages to this conversation`
    // and offers `Leave conversation` (ADR 0007). That is what the interface does
    // with a locked conversation. It is not a statement about whether the queued
    // send is dead, and collapsing the two produced exactly one wrong answer.
    retryable: z.literal(true),
    /**
     * The `sendPermission` reason, so the composer renders its existing copy rather
     * than matching on the code. `blocked_by_me` and `blocked_by_them` say opposite
     // things and a boolean cannot carry that.
     */
    reason: sendBlockReason,
  }),

  /**
   * Not a member of the conversation — for a write that is not a send.
   *
   * `sendBlocked` is the right answer for a SEND and the wrong answer everywhere
   * else: its name promises a lock, and a receipt advance is refused because the
   * caller was never in the conversation. Naming it honestly costs one branch and
   * saves a client from rendering "you are blocked" for a stranger's conversation.
   *
   * Retryable, for `sendBlocked`'s reason: being added to a conversation happens
   * without the member doing anything, so these identical bytes could plausibly
   * succeed later. Stage 3.E: a receipt or a delivery ack for a conversation you
   * are not in is refused, and this is what it answers.
   */
  z.object({ code: z.literal('notAMember'), message, retryable: z.literal(true) }),

  // ── terminal ───────────────────────────────────────────────────────────────
  // Retrying identical bytes reaches an identical answer, forever, and no amount of
  // waiting changes it. The composer's test: could this plausibly produce a
  // different status?
  z.object({
    code: z.literal('invalidRequest'),
    message,
    retryable: z.literal(false),
    /** Field-level detail for the `Not sent` strip, which "names the reason". */
    fields: z.array(z.object({ path: z.string(), message })).optional(),
  }),

  z.object({ code: z.literal('payloadTooLarge'), message, retryable: z.literal(false) }),

  z.object({ code: z.literal('unprocessable'), message, retryable: z.literal(false) }),

  /**
   * The 409 from ADR 0004. `message-lifecycle.md` says it names the conflict, so
   * this names the FIELDS: a member staring at `Not sent` learns that the text
   * differed, not merely that something did.
   *
   * Terminal by ruling, not by accident. A key reused for a different message is a
   * client bug, and retrying cannot fix a client bug.
   */
  z.object({
    code: z.literal('idempotencyConflict'),
    message,
    retryable: z.literal(false),
    conflictingFields: z.array(sendConflictField).min(1),
    /** `23505` on `message_id_key`, for the case where the comparison found nothing. */
    postgresCode: postgresCode.optional(),
  }),

  z.object({ code: z.literal('notFound'), message, retryable: z.literal(false) }),

  z.object({ code: z.literal('methodNotAllowed'), message, retryable: z.literal(false) }),
]);

export type ErrorBody = z.infer<typeof errorBody>;

/** Every error the server sends is wrapped in this. `{ error: … }`, always. */
export const errorEnvelope = z.object({ error: errorBody });

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;
