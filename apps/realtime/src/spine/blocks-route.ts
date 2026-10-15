/**
 * `POST /api/blocks` and `DELETE /api/blocks/{handle}`.
 *
 * Blocking is idempotent — blocking twice is still blocked — so POST answers
 * 200 either way rather than 201-then-200. Unblocking what was never blocked
 * is a no-op with the same answer. An unknown handle names itself in a 404;
 * blocking yourself is a 400, because the database would refuse it with a
 * constraint violation and a constraint is not an error message.
 */
import { blockRequest, normalizeHandle, type BlockRequest } from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { blockMember, unblockMember } from './blocks.ts';
import { lookupUserId } from './users.ts';

const BLOCKS_ROUTE = /^\/api\/blocks$/;
const UNBLOCK_ROUTE = /^\/api\/blocks\/([^/]+)$/;

export async function handleBlocks(request: Request, pathname: string): Promise<Response | null> {
  const unblockMatch = UNBLOCK_ROUTE.exec(pathname);
  const isBlock = BLOCKS_ROUTE.test(pathname);
  if (!isBlock && unblockMatch === null) return null;

  const blockerId = await requireSession(request);
  if (blockerId === null) return unauthenticated();

  if (unblockMatch !== null) {
    if (request.method !== 'DELETE') return methodNotAllowed(request.method);
    return unblock(blockerId, normalizeHandle(decodeURIComponent(unblockMatch[1]!)));
  }

  // POST /api/blocks is the only path still standing here: the unblock path
  // returned above, and anything else never entered.
  if (request.method !== 'POST') return methodNotAllowed(request.method);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'the body must be JSON' }], 'the block request is not valid');
  }
  const parsed = blockRequest.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      'the block request is not valid',
    );
  }
  return block(blockerId, parsed.data);
}

async function block(blockerId: string, body: BlockRequest): Promise<Response> {
  const blockedId = await lookupUserId(body.handle);
  if (blockedId === null) {
    return fail({ code: 'notFound', message: `no such handle: ${body.handle}`, retryable: false }, 404);
  }
  const outcome = await blockMember(blockerId, blockedId);
  switch (outcome.kind) {
    case 'blocked':
      return json({ blocked: true });
    case 'cannotBlockSelf':
      return fail(
        { code: 'invalidRequest', message: 'you cannot block yourself', retryable: false },
        400,
      );
    case 'unknownUser':
      return fail({ code: 'notFound', message: `no such handle: ${body.handle}`, retryable: false }, 404);
  }
}

async function unblock(blockerId: string, handle: string): Promise<Response> {
  const blockedId = await lookupUserId(handle);
  if (blockedId === null) {
    return fail({ code: 'notFound', message: `no such handle: ${handle}`, retryable: false }, 404);
  }
  await unblockMember(blockerId, blockedId);
  return json({ unblocked: true });
}
