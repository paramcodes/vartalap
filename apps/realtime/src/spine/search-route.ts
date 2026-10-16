/**
 * `GET /api/search` — search messages across caller's conversations (ADR 0009).
 */
import { conversationId as conversationIdScalar, seq as seqScalar } from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { searchMessages } from './search.ts';

const ROUTE = '/api/search';

export async function handleSearch(request: Request, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE) return null;

  if (request.method !== 'GET') return methodNotAllowed(request.method);

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  const url = new URL(request.url);
  const q = url.searchParams.get('q');
  if (q === null) {
    return invalidRequest([{ path: 'q', message: 'search query q is required' }], 'missing search query');
  }

  const rawConversationId = url.searchParams.get('conversationId');
  let conversationId: string | undefined = undefined;
  if (rawConversationId !== null && rawConversationId.length > 0) {
    const parsed = conversationIdScalar.safeParse(rawConversationId.toLowerCase());
    if (!parsed.success) {
      return invalidRequest([{ path: 'conversationId', message: 'must be a valid uuid' }], 'invalid conversationId');
    }
    conversationId = parsed.data;
  }

  const rawCursor = url.searchParams.get('cursor');
  let cursor = undefined;
  if (rawCursor !== null && rawCursor.length > 0) {
    const parsed = seqScalar.safeParse(rawCursor);
    if (!parsed.success) {
      return invalidRequest([{ path: 'cursor', message: 'must be a valid sequence string' }], 'invalid cursor');
    }
    cursor = parsed.data;
  }

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit !== null ? parseInt(rawLimit, 10) : undefined;

  const results = await searchMessages({
    userId,
    query: q,
    conversationId,
    cursor,
    limit: Number.isNaN(limit) ? undefined : limit,
  });

  return json(results);
}
