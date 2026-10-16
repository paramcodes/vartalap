/**
 * Two `POST`s on the receipt row, and the reason they are two paths rather than one
 * body with a flag:
 *
 *     POST /api/conversations/{conversationId}/receipt/advance
 *     POST /api/conversations/{conversationId}/receipt/sharing
 *
 * ADR 0059 settled it: "`sharing` is not on the receipt-advance body. It is a
 * settings change with its own transport (ADR 0022), not an advance." And the reason
 * underneath that decision is mechanical rather than stylistic — **`shared_through`
 * freezes while `read_through` keeps moving, and one write carrying both fields
 * cannot express a freeze.** Whichever order a single statement applied them in, one
 * of the two behaviours would be lost.
 *
 * The check order is `send-route.ts`'s and is not negotiable:
 *
 *     method → session → path → body → path-vs-body → write → envelope
 *
 * Every check before the write refuses without touching the database, which is what
 * makes a `400` or a `403` leave the member's watermarks exactly where they were.
 *
 * Each handler returns `null` for a path it does not own, so `server.ts` grows one
 * line per route and stays a router. If this file ever had to know what a `seq` is,
 * the layering ADR 0054 warns about would already have failed.
 */
import {
  conversationId as conversationIdScalar,
  receiptAdvanceRequest,
  receiptAdvanceResponse,
  receiptSharingRequest,
  receiptSharingResponse,
  type ReceiptAdvanceRequest,
  type ReceiptSharingRequest,
} from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, notAMember, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { storedPosition } from './position.ts';
import { advanceReceipt, setReceiptSharing } from './receipt.ts';
import type { FieldIssue, Parsed } from './query.ts';

const ADVANCE = /^\/api\/conversations\/([^/]+)\/receipt\/advance$/;
const SHARING = /^\/api\/conversations\/([^/]+)\/receipt\/sharing$/;

const ADVANCE_NOT_VALID = 'the receipt advance is not valid';
const SHARING_NOT_VALID = 'the receipt sharing request is not valid';

/**
 * A path segment that is not a uuid cannot name a conversation, so there is nothing
 * to look up and nothing the caller can fix in the body. 404 — and the SAME 404 for
 * a stranger, which is why this refusal leaks nothing.
 */
function noSuchConversation(): Response {
  return fail({ code: 'notFound', message: 'no such conversation', retryable: false }, 404);
}

const NOT_JSON: FieldIssue[] = [{ path: '', message: 'the body must be JSON' }];

function mismatch(): FieldIssue[] {
  return [{ path: 'conversationId', message: 'must match the conversation in the path' }];
}

/**
 * A body that could not even be read as JSON.
 *
 * One shared helper for both `POST`s rather than a copy each, because the difference
 * between the two copies would be invisible until one of them answered a malformed
 * request with a stack trace.
 */
async function readJson(request: Request): Promise<{ ok: true; raw: unknown } | { ok: false }> {
  try {
    return { ok: true, raw: await request.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * A receipt advance, given the conversation the PATH named.
 *
 * `sharing` is not a field here and is not defaulted into one: the schema has no such
 * field, and the server reads the STORED flag (ADR 0058). A client that sends
 * `sharing` here has it stripped, which is the behaviour the protocol already tests.
 */
function advanceBody(raw: unknown, pathConversation: string): Parsed<ReceiptAdvanceRequest> {
  const parsed = receiptAdvanceRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, fields: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
  }
  // The conversation is in the path AND the body and the router does NOT fill it in
  // (ADR 0059). Both sides lowercased, because `uuid` input accepts four spellings of
  // one value and ADR 0056's whole argument is that the database normalises them
  // while a raw string comparison here would not.
  if (String(parsed.data.conversationId) !== pathConversation) return { ok: false, fields: mismatch() };

  // The two positions have to survive the trip into a `bigint(…, { mode: 'number' })`
  // column, and `position.ts` is the one place that rule is written. Refusing here
  // rather than inside the write is what makes it a `400` about a client bug instead
  // of a `500` about ours.
  const unstorable: FieldIssue[] = [
    ...(storedPosition(parsed.data.readThrough) === null
      ? [{ path: 'readThrough', message: 'is a position this database cannot store exactly' }]
      : []),
    ...(storedPosition(parsed.data.sharedThrough) === null
      ? [{ path: 'sharedThrough', message: 'is a position this database cannot store exactly' }]
      : []),
  ];
  return unstorable.length > 0 ? { ok: false, fields: unstorable } : { ok: true, value: parsed.data };
}

export async function handleReceiptAdvance(request: Request, pathname: string): Promise<Response | null> {
  const match = ADVANCE.exec(pathname);
  if (match === null) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const pathConversation = conversationIdScalar.safeParse(match[1]!.toLowerCase());
  if (!pathConversation.success) return noSuchConversation();

  const raw = await readJson(request);
  if (!raw.ok) return invalidRequest(NOT_JSON, ADVANCE_NOT_VALID);

  const body = advanceBody(raw.raw, pathConversation.data);
  if (!body.ok) return invalidRequest(body.fields, ADVANCE_NOT_VALID);

  const outcome = await advanceReceipt({ userId, request: body.value });

  switch (outcome.kind) {
    // **The stored positions, never the requested ones.** After `GREATEST` refuses a
    // lower value — or while sharing is off, where `shared_through` does not move at
    // all — the two differ, and a client that keeps its own idea of where it got to
    // rather than what was stored renders every later `Seen` wrong.
    case 'advanced':
      return json(receiptAdvanceResponse.parse(outcome.receipt));

    case 'notAMember':
      return notAMember();
  }
}

/**
 * The settings write. Per-conversation and never global (ADR 0022): a global switch
 * invites a user to believe it hides a read in one conversation, which is false and
 * surprising.
 *
 * It answers `200` with the flag and **no position at all**, because turning sharing
 * back on must move nothing — and a response carrying `read_through` would invite
 * exactly that.
 */
export async function handleReceiptSharing(request: Request, pathname: string): Promise<Response | null> {
  const match = SHARING.exec(pathname);
  if (match === null) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const pathConversation = conversationIdScalar.safeParse(match[1]!.toLowerCase());
  if (!pathConversation.success) return noSuchConversation();

  const raw = await readJson(request);
  if (!raw.ok) return invalidRequest(NOT_JSON, SHARING_NOT_VALID);

  const parsed = receiptSharingRequest.safeParse(raw.raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return invalidRequest(fields, SHARING_NOT_VALID);
  }
  if (String(parsed.data.conversationId) !== pathConversation.data) {
    return invalidRequest(mismatch(), SHARING_NOT_VALID);
  }

  const outcome = await setReceiptSharing({ userId, request: parsed.data });

  switch (outcome.kind) {
    case 'sharingSet':
      return json(receiptSharingResponse.parse(outcome.receipt));

    case 'notAMember':
      return notAMember();
  }
}