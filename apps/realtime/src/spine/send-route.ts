/**
 * `POST /api/conversations/{conversationId}/messages`.
 *
 * The shape is ADR 0059's and nothing here decides it: the path, the body, the
 * three answers, and the error envelope all come from `@vartalap/protocol`. What
 * this file adds is the order, and the order is the point —
 *
 *   method → session → path → body → path-vs-body → send → envelope
 *
 * — because **every check before `sendMessage` is a check the idempotency key
 * survives.** ADR 0059: a `429` or a `400` that fails validation leaves the key
 * unused, so a rate-limited send or a malformed body is a retry, not a duplicate
 * check. That is only true because nothing has been written yet, which is why
 * validation belongs here and not inside the transaction.
 *
 * It returns `null` when the path is not its own, so `server.ts` grows one line
 * per route and stays a router. If this file ever had to know what a `seq` is, the
 * layering ADR 0054 warns about would already have failed.
 */
import {
  conversationId as conversationIdScalar,
  sendMessageRequest,
  sendMessageResponse,
  type SendMessageRequest,
} from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { sendMessage } from './send.ts';

/**
 * One path, one conversation id, no trailing slash and nothing below it. A regex
 * rather than a router table, because the alternative is a dependency and a
 * second place where routing is defined, for one segment.
 */
const ROUTE = /^\/api\/conversations\/([^/]+)\/messages$/;

/** This endpoint's own wording for a `400`. See `invalidRequest` in `http.ts`. */
const NOT_VALID = 'the send request is not valid';

export async function handleSendMessage(request: Request, pathname: string): Promise<Response | null> {
  const match = ROUTE.exec(pathname);
  if (match === null) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const authorId = await requireSession(request);
  if (authorId === null) return unauthenticated();

  // A path id that is not a uuid cannot name a conversation, so there is nothing
  // to look up and nothing a client can fix by changing the body. 404, not 400.
  const pathConversation = conversationIdScalar.safeParse(match[1]!.toLowerCase());
  if (!pathConversation.success) {
    return fail({ code: 'notFound', message: 'no such conversation', retryable: false }, 404);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'the body must be JSON' }], NOT_VALID);
  }

  const parsed = sendMessageRequest.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })), NOT_VALID);
  }
  const body: SendMessageRequest = parsed.data;

  // The conversation is in the path AND the body, and the router does not fill it
  // in (ADR 0059). So a mismatch is a client bug, named as one.
  //
  // **Lowercased on both sides**, and that is not politeness: `uuid` input accepts
  // uppercase, hyphenated, braced and bare spellings of one value, and ADR 0056's
  // whole argument is that the database normalises them while a string comparison
  // here would not. Comparing raw would refuse a legitimate retry from a client
  // whose JSON builder uppercases uuids. (`pathConversation.data` is already
  // lowercase — the parse above folded it.)
  if (String(body.conversationId).toLowerCase() !== pathConversation.data) {
    return invalidRequest([
      { path: 'conversationId', message: 'must match the conversation in the path' },
    ], NOT_VALID);
  }

  const outcome = await sendMessage({ authorId, request: body });

  switch (outcome.kind) {
    case 'created':
      return json(sendMessageResponse.parse({ message: outcome.message, deduplicated: false }));

    case 'deduplicated':
      return json(sendMessageResponse.parse({ message: outcome.message, deduplicated: true }));

    case 'conflict':
      // `23505` rides along: the comparison finding nothing is not a mystery, it
      // is the constraint that fired, and the envelope has a slot for exactly that.
      return fail(
        {
          code: 'idempotencyConflict',
          message: 'this idempotency key was already used for different content',
          retryable: false,
          conflictingFields: [...outcome.conflictingFields],
          postgresCode: '23505',
        },
        409,
      );

    case 'notAMember':
      // Retryable, because `sendBlockReason` says so for every reason it carries
      // and `not_a_member` is one of them: being added to a conversation is
      // something that happens without the sender doing anything.
      return fail(
        {
          code: 'sendBlocked',
          message: 'you are not a member of this conversation',
          retryable: true,
          reason: 'not_a_member',
        },
        403,
      );

    case 'sendBlocked':
      // The direction is the message the composer renders: `blocked_by_me` and
      // `blocked_by_them` are different copy for different facts. Retryable
      // either way — a block lifts without the sender doing anything.
      return fail(
        {
          code: 'sendBlocked',
          message:
            outcome.reason === 'blocked_by_me'
              ? 'you blocked this conversation'
              : 'you are blocked in this conversation',
          retryable: true,
          reason: outcome.reason,
        },
        403,
      );

    case 'attachmentsUnsupported':
      return fail(
        {
          code: 'unprocessable',
          message: 'attachments are not accepted until the media path exists',
          retryable: false,
        },
        422,
      );
  }
}