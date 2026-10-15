/**
 * `POST /api/conversations/{id}/leave` and `POST /api/conversations/{id}/rejoin`.
 *
 * A refusal here answers 404 either way — no such conversation and not a
 * member of it are the same response, because 3.D forbids leaking which one
 * it is. A member asking about a conversation that does not exist learns
 * nothing they did not know.
 */
import { conversationId as conversationIdScalar } from '@vartalap/protocol';
import { fail, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { leaveConversation, rejoinConversation } from './leave.ts';

const LEAVE_ROUTE = /^\/api\/conversations\/([^/]+)\/leave$/;
const REJOIN_ROUTE = /^\/api\/conversations\/([^/]+)\/rejoin$/;

export async function handleLeaveRejoin(request: Request, pathname: string): Promise<Response | null> {
  const leaveMatch = LEAVE_ROUTE.exec(pathname);
  const rejoinMatch = REJOIN_ROUTE.exec(pathname);
  if (leaveMatch === null && rejoinMatch === null) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const rawId = (leaveMatch ?? rejoinMatch)![1]!.toLowerCase();
  const parsed = conversationIdScalar.safeParse(rawId);
  if (!parsed.success) {
    return fail({ code: 'notFound', message: 'no such membership', retryable: false }, 404);
  }

  if (leaveMatch !== null) {
    const outcome = await leaveConversation(parsed.data, userId);
    if (outcome.kind !== 'left') {
      return fail({ code: 'notFound', message: 'no such membership', retryable: false }, 404);
    }
    return json({ left: true });
  }

  const outcome = await rejoinConversation(parsed.data, userId);
  if (outcome.kind !== 'rejoined') {
    return fail({ code: 'notFound', message: 'no such membership', retryable: false }, 404);
  }
  return json({ rejoined: true });
}
