/**
 * `GET /api/conversations/{conversationId}/history` — one page of a transcript.
 *
 * The order of the checks is `send-route.ts`'s, deliberately: **method → session →
 * path → query → read.** Every one of them refuses without touching the database,
 * which is not a performance claim — it is what keeps the `404` for a stranger and
 * the empty page for a member indistinguishable from the outside.
 *
 * ── why the path says `history` and not `messages` ────────────────────────────
 *
 * Because `send-route.ts` already answers `405` for a `GET` on
 * `/api/conversations/{id}/messages`, and that answer is committed and tested. Two
 * routes owning two methods of one path means the router has to know which comes
 * first, and `server.ts` is a router — it is not allowed to know what a page is.
 * A distinct path gives each route its own regex, and each route answers `null`
 * for everything it does not own.
 *
 * ── what is NOT decided here ──────────────────────────────────────────────────
 *
 * The body is `historyPage` from `@vartalap/protocol` and the paging rules are
 * ADR 0005's; neither is this file's to change. The one thing this file owns is
 * that a caller who is not a current member cannot tell a conversation apart from
 * its absence — which it gets by *not* branching: `readHistory` has no "not a
 * member" answer, so there is nothing here to leak.
 */
import { conversationId as conversationIdScalar } from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { readHistory } from './history.ts';
import { historyQueryFrom } from './query.ts';

const ROUTE = /^\/api\/conversations\/([^/]+)\/history$/;

const NOT_VALID = 'the history query is not valid';

export async function handleHistory(request: Request, pathname: string): Promise<Response | null> {
  const match = ROUTE.exec(pathname);
  if (match === null) return null;

  if (request.method !== 'GET') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  // A path id that is not a uuid cannot name a conversation, whatever the caller
  // is or is not. 404, and the same 404 for every caller — which is why this
  // refusal leaks nothing.
  const pathConversation = conversationIdScalar.safeParse(match[1]!.toLowerCase());
  if (!pathConversation.success) {
    return fail({ code: 'notFound', message: 'no such conversation', retryable: false }, 404);
  }

  const query = historyQueryFrom(new URL(request.url).searchParams, pathConversation.data);
  if (!query.ok) return invalidRequest(query.fields, NOT_VALID);

  return json(await readHistory({ userId, ...query.value }));
}