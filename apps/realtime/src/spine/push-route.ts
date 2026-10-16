/**
 * Push subscription endpoints (ADR 0011).
 *
 * `POST /api/push/subscribe`
 * `POST /api/push/unsubscribe`
 */
import { pushSubscriptionRequest } from '@vartalap/protocol';
import { fail, invalidRequest, json, methodNotAllowed, unauthenticated } from '../http.ts';
import { requireSession } from '../session.ts';
import { isSafeEndpoint, removePushSubscription, savePushSubscription } from './push.ts';

const SUBSCRIBE_ROUTE = '/api/push/subscribe';
const UNSUBSCRIBE_ROUTE = '/api/push/unsubscribe';

export async function handlePush(request: Request, pathname: string): Promise<Response | null> {
  if (pathname !== SUBSCRIBE_ROUTE && pathname !== UNSUBSCRIBE_ROUTE) {
    return null;
  }

  if (request.method !== 'POST') {
    return methodNotAllowed(request.method);
  }

  const userId = await requireSession(request);
  if (userId === null) return unauthenticated();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail({ code: 'invalidRequest', message: 'malformed JSON body', retryable: false }, 400);
  }

  if (pathname === SUBSCRIBE_ROUTE) {
    const parsed = pushSubscriptionRequest.safeParse(body);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        'the push subscription is not valid',
      );
    }

    if (!isSafeEndpoint(parsed.data.endpoint)) {
      return fail(
        { code: 'invalidRequest', message: 'unsafe push endpoint rejected', retryable: false },
        400,
      );
    }

    try {
      await savePushSubscription(userId, parsed.data, request.headers.get('user-agent'));
      return json({ ok: true }, 201);
    } catch {
      return fail(
        { code: 'internal', message: 'could not persist subscription', retryable: true },
        500,
      );
    }
  }

  if (pathname === UNSUBSCRIBE_ROUTE) {
    const endpoint = (body as { endpoint?: unknown })?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return invalidRequest([{ path: 'endpoint', message: 'endpoint string required' }], 'missing endpoint');
    }

    await removePushSubscription(userId, endpoint);
    return json({ ok: true });
  }

  return null;
}
