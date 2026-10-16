/**
 * One conversation and everybody in it — the transcript header's read.
 *
 * A stranger cannot tell a conversation apart from its absence: non-members
 * get the same `404` as an unknown id, exactly like the history route.
 */
import { conversationId as conversationIdScalar } from '@vartalap/protocol';
import { fail, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { readMembership } from './membership.ts';

const ROUTE = /^\/api\/conversations\/([^/]+)$/;

export async function handleMembership(request: Request, pathname: string): Promise<Response | null> {
  const match = ROUTE.exec(pathname);
  if (match === null) return null;
  if (request.method !== 'GET') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const parsed = conversationIdScalar.safeParse(match[1]!.toLowerCase());
  if (!parsed.success) {
    return fail({ code: 'notFound', message: 'no such conversation', retryable: false }, 404);
  }

  const found = await readMembership(parsed.data, userId);
  if (found === null) {
    return fail({ code: 'notFound', message: 'no such conversation', retryable: false }, 404);
  }
  return json(found);
}
