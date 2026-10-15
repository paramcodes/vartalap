/**
 * `POST /api/conversations/{conversationId}/delivery/ack`.
 *
 * Its own module because delivery is its own table, its own write, and — ADR 0010's
 * phrase — "a builder who assumes 'the receipt table' is singular will get this
 * wrong". The path is separate for the same reason the receipt paths are separate
 * from each other: one regex per route, and each route answers `null` for everything
 * it does not own.
 *
 * The check order is `send-route.ts`'s — method → session → path → body →
 * path-vs-body → write → envelope — and each step refuses without touching the
 * database.
 *
 * **No device identity, anywhere.** The body is `deliveryAckRequest` and it carries
 * `conversationId` and `deliveredThrough`; there is no `deviceId` field to add later
 * without contradicting ADR 0004, which rejects per-device delivery as unfixable by
 * construction: a powered-off device may never acknowledge.
 */
import {
  conversationId as conversationIdScalar,
  deliveryAckRequest,
  deliveryAckResponse,
  type DeliveryAckRequest,
} from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, notAMember, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { acknowledgeDelivery } from './delivery.ts';
import { storedPosition } from './position.ts';
import type { FieldIssue, Parsed } from './query.ts';

const ROUTE = /^\/api\/conversations\/([^/]+)\/delivery\/ack$/;

const NOT_VALID = 'the delivery acknowledgement is not valid';

export async function handleDeliveryAck(request: Request, pathname: string): Promise<Response | null> {
  const match = ROUTE.exec(pathname);
  if (match === null) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  // A path id that is not a uuid cannot name a conversation. 404, and the same 404
  // for every caller, which is why this refusal leaks nothing.
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

  const body = ackBody(raw, pathConversation.data);
  if (!body.ok) return invalidRequest(body.fields, NOT_VALID);

  const outcome = await acknowledgeDelivery({ userId, request: body.value });

  switch (outcome.kind) {
    // The stored position, never the requested one. After `GREATEST` refuses a lower
    // value the two differ, and a client that assumed its own number was stored
    // renders `Delivered` on messages that never arrived at it.
    case 'acknowledged':
      return json(deliveryAckResponse.parse(outcome.delivery));

    case 'notAMember':
      return notAMember();
  }
}

/** The body, checked against the conversation the PATH named. */
function ackBody(raw: unknown, pathConversation: string): Parsed<DeliveryAckRequest> {
  const parsed = deliveryAckRequest.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, fields };
  }

  // Path and body must name the same conversation, both folded to lower case —
  // ADR 0059 for the redundancy, ADR 0056 for the fold. The router never fills this
  // in, because a payload that cannot be wrong cannot be wrong.
  if (String(parsed.data.conversationId) !== pathConversation) {
    return { ok: false, fields: [{ path: 'conversationId', message: 'must match the conversation in the path' }] };
  }

  // `position.ts` owns the one rule about what a `bigint(…, { mode: 'number' })` can
  // hold. Refused at the boundary so a client bug is a `400` and not a `500`.
  const fields: FieldIssue[] =
    storedPosition(parsed.data.deliveredThrough) === null
      ? [{ path: 'deliveredThrough', message: 'is a position this database cannot store exactly' }]
      : [];
  return fields.length > 0 ? { ok: false, fields } : { ok: true, value: parsed.data };
}