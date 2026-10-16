/**
 * `GET /api/conversations` — the list, newest position first.
 *
 * Session → work. One line in `server.ts` reaches it; it answers `null` for a
 * path it does not own, like every other route.
 */
import { fail, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { listConversations } from './list.ts';

const LIST_ROUTE = '/api/conversations';

export async function handleListConversations(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== LIST_ROUTE) return null;
  if (request.method !== 'GET') return methodNotAllowed(request.method);

  const viewerId = await requireSession(request);
  if (viewerId === null) return unauthenticated();

  try {
    return json(await listConversations(viewerId));
  } catch (error) {
    return fail(
      { code: 'internal', message: 'the list could not be read', retryable: true },
      500,
    );
  }
}
