/**
 * `GET /api/catch-up?after=…` — reconnect, for the whole account, in one query.
 *
 * **There is no `conversationId` in the path, and that is the design.** ADR 0005
 * made `seq` a single global column precisely so positions compare across
 * conversations and therefore one cursor covers everything: "Reconnect is one
 * query, not one per conversation." A catch-up endpoint that asked for a
 * conversation would let the design it replaced back in, so `catchUpQuery` has no
 * such field and neither has this route.
 *
 * Everything about the answer is scoped to the caller by the query itself —
 * `readCatchUp` joins through the caller's current memberships rather than
 * filtering afterwards, so there is no ordering of statements here in which a row
 * from a conversation the caller was never in, or has left, reaches the response.
 */
import { invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { readCatchUp } from './history.ts';
import { catchUpQueryFrom } from './query.ts';

const ROUTE = /^\/api\/catch-up$/;

const NOT_VALID = 'the catch-up query is not valid';

export async function handleCatchUp(request: Request, pathname: string): Promise<Response | null> {
  if (ROUTE.test(pathname) === false) return null;

  // A path that exists under a method it does not serve answers 405 rather than
  // 404: a client reaching for `POST /api/catch-up` needs to know the path is real
  // and the verb is wrong, because those have different fixes.
  if (request.method !== 'GET') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const query = catchUpQueryFrom(new URL(request.url).searchParams);
  if (!query.ok) return invalidRequest(query.fields, NOT_VALID);

  return json(await readCatchUp({ userId, ...query.value }));
}