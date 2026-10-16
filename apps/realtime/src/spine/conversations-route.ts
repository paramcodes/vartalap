/**
 * `POST /api/conversations/direct` and `POST /api/conversations/groups`.
 *
 * Creation, not messaging: the bodies name people by handle, the server
 * resolves them to user ids, and the response is the `conversation` row. Same
 * router discipline as every other route — method → session → body → work —
 * and `null` for paths it does not own.
 */
import {
  conversation as conversationSchema,
  createGroupRequest,
  directConversationRequest,
  type CreateGroupRequest,
  type DirectConversationRequest,
} from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { createDirectConversationWith, createGroupConversation } from './conversations.ts';

const DIRECT_ROUTE = /^\/api\/conversations\/direct$/;
const GROUPS_ROUTE = /^\/api\/conversations\/groups$/;

export async function handleCreateConversation(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const isDirect = DIRECT_ROUTE.test(pathname);
  const isGroup = GROUPS_ROUTE.test(pathname);
  if (!isDirect && !isGroup) return null;

  if (request.method !== 'POST') return methodNotAllowed(request.method);

  const creatorId = await requireSession(request);
  if (creatorId === null) return unauthenticated();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'the body must be JSON' }], 'the creation request is not valid');
  }

  if (isDirect) {
    const parsed = directConversationRequest.safeParse(raw);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        'the creation request is not valid',
      );
    }
    return createDirect(creatorId, parsed.data);
  }

  const parsed = createGroupRequest.safeParse(raw);
  if (!parsed.success) {
    return invalidRequest(
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      'the creation request is not valid',
    );
  }
  return createGroup(creatorId, parsed.data);
}

async function createDirect(creatorId: string, body: DirectConversationRequest): Promise<Response> {
  const outcome = await createDirectConversationWith(creatorId, body.handle);
  switch (outcome.kind) {
    case 'created':
      return json(conversationSchema.parse(outcome.conversation), 201);
    case 'unknownHandle':
      return fail(
        { code: 'notFound', message: `no such handle: ${outcome.handle}`, retryable: false },
        404,
      );
    case 'cannotTalkToSelf':
      return fail(
        { code: 'invalidRequest', message: 'a direct conversation needs somebody else', retryable: false },
        400,
      );
    case 'tooManyMembers':
      // Unreachable: two members cannot exceed a ceiling of five hundred. Kept
      // because an unhandled union variant is a 500 with no body rather than
      // an answer, and the next reader should not have to prove reachability
      // to trust the switch.
      return fail(
        { code: 'invalidRequest', message: 'a direct conversation holds two members', retryable: false },
        400,
      );
  }
}

async function createGroup(creatorId: string, body: CreateGroupRequest): Promise<Response> {
  const outcome = await createGroupConversation(creatorId, body.title, body.handles);
  switch (outcome.kind) {
    case 'created':
      return json(conversationSchema.parse(outcome.conversation), 201);
    case 'unknownHandle':
      return fail(
        { code: 'notFound', message: `no such handle: ${outcome.handle}`, retryable: false },
        404,
      );
    case 'cannotTalkToSelf':
      // Unreachable: the creator is always a member and never their own peer.
      // Kept because the outcome union has the variant and an unhandled case
      // is a 500 with no body rather than an answer.
      return fail(
        { code: 'invalidRequest', message: 'a direct conversation needs somebody else', retryable: false },
        400,
      );
    case 'tooManyMembers':
      return fail(
        {
          code: 'invalidRequest',
          message: `a group holds 500 members; ${outcome.members} were named`,
          retryable: false,
        },
        400,
      );
  }
}
