/**
 * The two ways this service writes a response.
 *
 * These live here rather than in `server.ts` because the spine needs them too, and
 * two copies of `fail()` would be two places where a status code could disagree
 * with the envelope beside it. That disagreement is the whole failure ADR 0059
 * exists to remove: `composer-and-sending.md` builds the composer's retry policy on
 * `retryable`, so a response whose body and status drift apart does not fail a
 * test, it silently changes what a client does with somebody's message.
 *
 * `fail()` parses rather than stringifies. A shape that has drifted from
 * `@vartalap/protocol` is a failed request, loudly, rather than a quietly different
 * body that every client then has to cope with.
 */
import { errorEnvelope, type ErrorBody } from '@vartalap/protocol';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Every failure is `{ error: { code, message, retryable, … } }`. One shape, always. */
export function fail(error: ErrorBody, status: number): Response {
  return json(errorEnvelope.parse({ error }), status);
}

/**
 * The 401. Retryable, because a signed-out member's queued sends stay queued and
 * re-flush on sign-in — a 401 is not a message that failed, it is a session that
 * is missing. See `errorBody`.
 */
export function unauthenticated(): Response {
  return fail(
    { code: 'unauthenticated', message: 'a valid session cookie is required', retryable: true },
    401,
  );
}

/**
 * The 405. A route that exists under a method it does not serve answers this
 * rather than `notFound`: a client reaching for `GET /messages` needs to know the
 * path is real and the verb is wrong, because those have different fixes.
 */
export function methodNotAllowed(method: string): Response {
  return fail(
    { code: 'methodNotAllowed', message: `${method} is not served here`, retryable: false },
    405,
  );
}

export function notFound(pathname: string): Response {
  return fail({ code: 'notFound', message: `no route for ${pathname}`, retryable: false }, 404);
}