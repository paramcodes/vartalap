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
 *
 * It also **guards the sign-up budget**, at the bottom: the test named "the sign-up
 * budget for a test run is not three" is what guarantees the auth preload ran before
 * `@vartalap/auth` was evaluated. See `packages/auth/src/test-harness.ts` for why that
 * ordering cannot be guaranteed by a comment.
 */
import { afterAll, expect, test } from 'bun:test';
import { errorEnvelope } from '@vartalap/protocol';
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
  // Parsed through the shared envelope rather than compared to a literal, so this
  // test fails if the server and `@vartalap/protocol` ever disagree about the
  // shape. A hand-copied literal would only prove the two copies still match each
  // other, which is not the claim.
  expect(errorEnvelope.parse(await response.json())).toEqual({
    error: {
      code: 'unauthenticated',
      message: 'a valid session cookie is required',
      // Retryable: a signed-out member's queued sends re-flush on sign-in rather
      // than becoming a failed row. That is the whole reason `retryable` is a field
      // in the envelope instead of something a client infers from a status code.
      retryable: true,
    },
  });
});

test('an unrouted path answers with the same envelope, not a second error shape', async () => {
  const response = await fetch(`${origin}/api/nope`);
  expect(response.status).toBe(404);
  const parsed = errorEnvelope.parse(await response.json());
  expect(parsed.error.code).toBe('notFound');
  expect(parsed.error.retryable).toBe(false);
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

/**
 * ⚠️ **This test is the guarantee that the auth preload ran.** Read it as infrastructure
 * rather than as a duplicate of the sign-up test above.
 *
 * Better Auth 1.7.7 hard-codes `{ window: 10, max: 3 }` for any path starting
 * `/sign-up`, applies it AFTER `rateLimit.max` — so the repository's `max: 100` never
 * governed sign-up — and keys the bucket by client IP, which `bun test` cannot resolve,
 * so every test file shares one bucket (decisions index, traps 17 and 19).
 *
 * **Measured on this machine: three sign-ups in one window, then `429` for the rest of
 * the run.** Four test files each sign up once, so the suite was one request away from
 * a failure that had nothing to do with what those files test.
 *
 * `packages/auth/src/test-harness.ts` raises the ceiling through `customRules`, and
 * `packages/auth/src/auth.ts` reads that variable at MODULE SCOPE — so the raise only
 * happens if the preload was evaluated first. Drop the preload from a `test` script,
 * reorder it behind an import of `@vartalap/auth`, rename the variable in one place, or
 * let `.env` shadow it, and the fourth request below is a `429`.
 *
 * **Eleven sign-ups, not four.** Four would pass by accident: two of the four would come
 * from files running more than the 10-second window apart. Eleven inside one test cannot.
 */
test('the sign-up budget for a test run is not three — the limiter is raised, not removed', async () => {
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const handle = `budget${attempt}x${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Budget',
        username: handle,
        email: `${handle}@example.test`,
        password: PASSWORD,
      }),
    });
    statuses.push(response.status);
    // The bodies on a failure, because "expected 429 got 200" eleven times says nothing
    // about WHICH of the two things went wrong.
    if (!response.ok) statuses.push(Number(response.headers.get('x-retry-after') ?? -1));
  }

  expect(statuses.filter((status) => status >= 400)).toEqual([]);
  expect(statuses).toHaveLength(11);

  // And they really are users: a raised ceiling that answered `200` without writing
  // would satisfy the assertion above and prove nothing about the harness.
  const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM "user" WHERE name = 'Budget'`;
  expect(rows[0]!.n).toBe('11');
});

afterAll(() => {
  server.stop(true);
  // Deliberately NOT `testDb.stop()`. The fixture is a process-lifetime
  // singleton shared by every test file in the run, and `bun test` runs
  // `apps/` before `packages/` — stopping the PGlite here left the database
  // tests with `ECONNREFUSED`. PGlite in-process does not hold the event loop
  // open, so nothing needs tearing down.
});
