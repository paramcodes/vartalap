/**
 * A cookie in, a user id out. Nothing else.
 *
 * This is the whole of the auth boundary for the realtime service, and it is
 * deliberately the smallest thing that can work. `auth.api.getSession` verifies
 * the SIGNED session cookie against the `session` row and returns the user, so a
 * route never has to know how a session is stored, how long it lasts, or that it
 * is revoked by deleting a row.
 *
 * Why the cookie has to come from HTTP, not from `auth.api`: the server-side API
 * hands back the session TOKEN but not the signed HttpOnly cookie Better Auth
 * sets on the wire, and `listSessions` and friends refuse a bare token. Anything
 * that needs the real cookie — a device list, or any test of this file — has to
 * go over HTTP. See `src/server.test.ts`, which signs up through
 * `POST /api/auth/sign-up/email` and keeps the `Set-Cookie` it gets back.
 */
import { auth } from '@vartalap/auth';

/**
 * The authenticated user's id, or `null` when the request carries no valid
 * session. It never throws for an unauthenticated caller — an anonymous request
 * is a normal state, not an error, and a route that has to catch an exception to
 * find that out will eventually forget to.
 */
export async function requireSession(request: Request): Promise<string | null> {
  const result = await auth.api.getSession({ headers: request.headers });
  return result?.user?.id ?? null;
}
