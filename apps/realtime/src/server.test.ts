/**
 * The session boundary, over real HTTP.
 *
 * Why this file bothers with `fetch` when `auth.api.signUpEmail` would have been
 * easier: `auth.api` returns the session TOKEN and never the signed HttpOnly
 * cookie Better Auth sets on the wire. `getSession` verifies that cookie, not the
 * token, so the only honest way to prove `requireSession` works is to sign up
 * over HTTP, keep the `Set-Cookie` header, and send it back.
 *
 * The harness import is FIRST and is load-bearing. `@vartalap/database` reads
 * `DATABASE_URL` at module scope and throws without it; the harness sets it
 * before any other module is evaluated, and ESM evaluates imports in the order
 * they are written.
 */
import { afterAll, expect, test } from 'bun:test';
import { sql } from '@vartalap/database/test-harness';
import { start } from './server.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

const PASSWORD = 'correct horse battery staple';
const run = crypto.randomUUID().slice(0, 8);
const HANDLE = `spine_${run}`;
const EMAIL = `${HANDLE}@example.test`;

let cookie = '';
let userId = '';

/** `set-cookie` carries attributes; a Cookie header wants only `name=value`. */
function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('no Set-Cookie header on the response');
  return header.split(';')[0]!;
}

async function signUp(): Promise<Response> {
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Spine Tester',
      username: HANDLE,
      email: EMAIL,
      password: PASSWORD,
    }),
  });
  if (response.ok) {
    cookie = cookieOf(response);
    userId = ((await response.json()) as { user: { id: string } }).user.id;
  }
  return response;
}

function me(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${origin}/api/me`, { headers });
}

test('the shell routes, and health needs no session', async () => {
  const response = await fetch(`${origin}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test('an unauthenticated request to a protected route is 401', async () => {
  const response = await me();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: 'unauthenticated', message: 'a valid session cookie is required' },
  });
});

test('a forged cookie is 401, not a crash and not a 200', async () => {
  const response = await me({ cookie: 'better-auth.session_token=not-a-real-signature' });
  expect(response.status).toBe(401);
});

test('Better Auth serves sign-up over HTTP and sets a signed HttpOnly cookie', async () => {
  // Nothing in the repo routed a request to `@vartalap/auth` before this. If this
  // 404s, the mount is gone.
  const response = await signUp();
  expect(response.status).toBe(200);
  expect(cookie).toContain('better-auth.session_token=');
  expect(response.headers.get('set-cookie')!.toLowerCase()).toContain('httponly');
});

test('the same request with that cookie is 200 and returns the right user id', async () => {
  expect(cookie).not.toBe('');
  const response = await me({ cookie });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ userId });
});

test('that user id is the row Better Auth wrote, not an echo of the cookie', async () => {
  // A handler that returned whatever it was handed would pass the test above.
  const rows = await sql<{ id: string; username: string }[]>`
    SELECT id, username FROM "user" WHERE id = ${userId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.username).toBe(HANDLE);
});

afterAll(() => {
  server.stop(true);
  // Deliberately NOT `testDb.stop()`. The fixture is a process-lifetime
  // singleton shared by every test file in the run, and `bun test` runs
  // `apps/` before `packages/` — stopping the PGlite here left the database
  // tests with `ECONNREFUSED`. PGlite in-process does not hold the event loop
  // open, so nothing needs tearing down.
});
