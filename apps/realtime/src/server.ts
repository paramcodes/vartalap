/**
 * The realtime service. A `Bun.serve` shell, a router, and the auth boundary.
 *
 * **No HTTP framework, on purpose.** This will be six routes. Hono would add a
 * dependency, a second place where routing is defined, and a layer between a
 * request and the code that has to be trusted — to save a `switch`. The spine
 * (send, history, catch-up, receipts) is the part stage 3 exists to prove, and
 * it should be reachable by reading this file top to bottom.
 *
 * What this file is NOT allowed to become: a place where the spine lives. Nothing
 * here writes a message, publishes a frame, or knows what a `seq` is. Later units
 * add `src/spine/*` and the router grows one line per route.
 *
 *     bun run realtime          # from the repo root
 */
import { auth } from '@vartalap/auth';
import { errorEnvelope, type ErrorBody } from '@vartalap/protocol';
import { requireSession } from './session.ts';

/**
 * Better Auth's own default base path, restated so the mount point and the
 * library cannot drift apart silently: if either changes, this comparison stops
 * matching and every auth route 404s.
 */
const AUTH_PREFIX = '/api/auth';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Every failure leaves as the one envelope `@vartalap/protocol` defines, so there
 * is exactly one error shape on the wire. The `code` is what a client branches on;
 * `retryable` is in the envelope because a send queue has to know whether to back
 * off or to give up, and a client that had to infer that from a status code would
 * be mirroring a table it cannot see.
 */
function fail(body: ErrorBody, status: number): Response {
  return json(errorEnvelope.parse({ error: body }), status);
}

/**
 * The 401. A signed-out member's queued sends stay queued and re-flush on sign-in,
 * so this one is retryable — see `errorBody`.
 */
function unauthenticated(): Response {
  return fail({ code: 'unauthenticated', message: 'a valid session cookie is required', retryable: true }, 401);
}

export async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/health' && request.method === 'GET') {
    return json({ ok: true });
  }

  // Better Auth owns this whole prefix. Mounted rather than reimplemented:
  // `auth.handler` IS the HTTP surface for sign-up, sign-in, session and sign-out,
  // and before this file existed nothing in the repo routed a request to it —
  // `@vartalap/auth` was exported and unreachable over HTTP.
  if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
    return auth.handler(request);
  }

  // The protected route that proves the session boundary works. It is a
  // harness, not a product route: it exists so 3.A can show an anonymous caller
  // gets 401 and a signed-in caller gets their own id back. `/api/conversations`
  // and friends are 3.C's problem.
  if (pathname === '/api/me') {
    if (request.method !== 'GET') {
      return fail({ code: 'methodNotAllowed', message: 'use GET here', retryable: false }, 405);
    }
    const userId = await requireSession(request);
    if (userId === null) return unauthenticated();
    return json({ userId });
  }

  return fail({ code: 'notFound', message: `no route for ${pathname}`, retryable: false }, 404);
}

export function start(port = Number(process.env.REALTIME_PORT ?? 3000)) {
  return Bun.serve({ port, hostname: '127.0.0.1', fetch: handleRequest });
}

if (import.meta.main) {
  const server = start();
  // `BETTER_AUTH_URL` must be this origin. Same-origin is the documented
  // assumption in `packages/auth/src/auth.ts` — if the web app and this service
  // are ever split, `sameSite: 'none'` + `secure` is required and the default in
  // that file will break quietly.
  console.log(`realtime  http://${server.hostname}:${server.port}`);
  console.log(`auth      ${process.env.BETTER_AUTH_URL ?? '(unset)'}${AUTH_PREFIX}`);
  console.log(`database  ${process.env.DATABASE_URL ?? '(unset)'}`);
}
