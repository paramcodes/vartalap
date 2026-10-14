/**
 * Stage 2 smoke test: does a person claim a handle and sign in with it?
 *
 * This runs against `bun run db:local` and exercises paths against the database,
 * not against the config. A config that instantiates proves nothing, and neither
 * does a `usernameValidator` that looks correct.
 *
 *     bun run db:local          # in one shell
 *     bun run auth:smoke        # in another
 */
import { sql } from '@vartalap/database';
import { auth } from './src/auth.ts';

const PASSWORD = 'correct horse battery staple';
const RUN = Date.now().toString(36);
const HANDLE = `param_${RUN}`;
const EMAIL = `${HANDLE}@example.test`;

let failures = 0;
const tag = () => Math.random().toString(36).slice(2, 8);

/**
 * Most of what matters here is that the system REFUSES something: a handle outside
 * the alphabet, a short handle, a wrong password, a released handle. A wrapper that
 * scores a throw as a failure inverts all of those and reports a working system as
 * broken — which is exactly what the first run of this file did.
 *
 * So `refuses` is the default. The body must NOT throw to signal success; if the
 * action goes through, that is the failure.
 */
async function refuses(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failures++;
    console.log(`  ✗ ${label} — SUCCEEDED, and should not have`);
  } catch (error) {
    console.log(`  ✓ ${label} — refused: ${(error as Error).message.split('\n')[0].slice(0, 56)}`);
  }
}

async function succeeds(label: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    console.log(`  ✓ ${label}${value === undefined ? '' : ` → ${String(value).slice(0, 64)}`}`);
  } catch (error) {
    failures++;
    console.log(`  ✗ ${label}\n      ${(error as Error).message.split('\n')[0]}`);
  }
}

const signup = (username: string, email = `${username}@example.test`) =>
  auth.api.signUpEmail({ body: { name: 'Test Person', username, email, password: PASSWORD } });

const signin = (password = PASSWORD) =>
  auth.api.signInEmail({ body: { username: HANDLE, email: EMAIL, password } });

console.log(`handle under test: ${HANDLE}\n`);

// ── refusals ───────────────────────────────────────────────────────────────
await refuses('a handle outside the ADR 0017 alphabet', () => signup(`Bad.${tag()}`));
await refuses('a handle that is too short', () => signup(`a${tag().slice(0, 1)}`));
await refuses('a handle that is too long', () => signup(`x${'y'.repeat(20)}${tag()}`));
await refuses('a password under the configured minimum', () =>
  auth.api.signUpEmail({
    body: { name: 'Short', username: `s${tag()}`, email: `s${tag()}@example.test`, password: 'tiny' },
  }));

// ── the account everything else runs against ───────────────────────────────
await succeeds('claims a handle and lowercases it', async () => {
  const res = await signup(HANDLE.toUpperCase(), EMAIL);
  const stored = res.user.username as string;
  if (stored !== HANDLE) throw new Error(`stored ${stored}, expected ${HANDLE}`);
  if (!res.token) throw new Error('no session token returned');
  return `${stored} · session ${String(res.token).slice(0, 12)}…`;
});

// ── refusals against that account ──────────────────────────────────────────
await refuses('signing in with a wrong password', () => signin('not the password'));
await refuses('signing up with a handle already taken', () => signup(HANDLE, `dupe${tag()}@example.test`));
await refuses('signing up with the same handle in a different case', () =>
  signup(HANDLE.toUpperCase(), `case${tag()}@example.test`),
);

// ── sign-in and sessions ───────────────────────────────────────────────────
await succeeds('signs in with the handle', async () => {
  const res = await signin();
  return `${res.user.username} · session ${String(res.token).slice(0, 12)}…`;
});

await succeeds('each sign-in creates its own session row (ADR 0022 device list)', async () => {
  const before = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM session WHERE user_id = (SELECT id FROM "user" WHERE username = ${HANDLE})`;
  await signin();
  await signin();
  const after = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM session WHERE user_id = (SELECT id FROM "user" WHERE username = ${HANDLE})`;
  // The device screen lists sessions, so "one row per sign-in, not one per account"
  // is the property that has to hold. Cookie-level `listSessions` needs the SIGNED
  // cookie Better Auth returns over HTTP, which the server-side API does not hand
  // back — asserting on the rows is what this can honestly prove today.
  const delta = after[0].n - before[0].n;
  if (delta !== 2) throw new Error(`${before[0].n} → ${after[0].n}, expected +2`);
  return `${after[0].n} sessions for one account`;
});

await succeeds('a session records its device fields (ADR 0022)', async () => {
  await sql`UPDATE session SET ip_address = '203.0.113.7', user_agent = 'vartalap-smoke'
            WHERE user_id = (SELECT id FROM "user" WHERE username = ${HANDLE})`;
  const rows = await sql<{ ip_address: string; device_trusted: boolean }>`
    SELECT ip_address, device_trusted FROM session
    WHERE user_id = (SELECT id FROM "user" WHERE username = ${HANDLE}) LIMIT 1`;
  if (rows[0]?.ip_address !== '203.0.113.7') throw new Error('ip_address did not persist');
  // device_trusted is NOT NULL DEFAULT false — the column a "trust this device"
  // control writes, and the reason it cannot be nullable.
  if (rows[0].device_trusted !== false) throw new Error(`device_trusted is ${rows[0].device_trusted}`);
  return `ip + trusted flag present`;
});

// ── the database guarantees, which no library call can be trusted for ──────
await succeeds('a released handle is permanently unclaimable (ADR 0041)', async () => {
  // Enforced by the trigger in 0003_handle_reservation.sql. Proved here because it
  // is the one guarantee that must survive somebody later writing "user" with
  // Drizzle instead of going through Better Auth.
  const disposable = `gone_${tag()}`;
  await signup(disposable);
  await sql`DELETE FROM "user" WHERE username = ${disposable}`;

  // postgres.js resolves to the rows array itself, not { rows } — that is
  // node-postgres, and reaching for `.rows` here silently yields undefined.
  const reservations = await sql<{ handle: string; reason: string }>`
    SELECT handle, reason FROM handle_reservation WHERE handle = ${disposable}`;
  if (reservations.length !== 1) throw new Error(`expected 1 reservation, got ${reservations.length}`);
  if (reservations[0].reason !== 'released') throw new Error(`reason is ${reservations[0].reason}`);

  await refuses('  └ re-claiming it afterwards', () => signup(disposable, `re${tag()}@example.test`));
  return `reserved as ${reservations[0].reason}`;
});

await succeeds('a bypassing writer that skips normalisation is caught by the index', async () => {
  // The safety net the schema comment claims. Better Auth lowercases in application
  // code; a direct Drizzle write does not, so the expression index is the only
  // thing standing between two rows and one handle.
  const base = `bypass_${tag()}`;
  await sql`INSERT INTO "user" (id, name, username, email)
            VALUES (gen_random_uuid(), 'Bypass', ${`${base}_UPPER`}, ${`${base}1@example.test`})`;
  await refuses('  └ the same handle in a different case', () =>
    sql`INSERT INTO "user" (id, name, username, email)
        VALUES (gen_random_uuid(), 'Bypass', ${`${base}_upper`}, ${`${base}2@example.test`})`,
  );
});

await refuses('a username change is refused (handles are immutable)', async () => {
  // Target the row by id. An UPDATE matching nothing raises nothing, and a `refuses`
  // check reads silence as success — which is how the trigger appeared to be
  // missing when it was firing correctly all along.
  const target = await sql<{ id: string }>`SELECT id FROM "user" WHERE username = ${HANDLE}`;
  if (target.length !== 1) throw new Error(`expected 1 row for ${HANDLE}, found ${target.length}`);
  await sql`UPDATE "user" SET username = ${`renamed_${tag()}`} WHERE id = ${target[0].id}`;
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
