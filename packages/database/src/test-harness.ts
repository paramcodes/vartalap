/**
 * The database every test in this repo runs against.
 *
 * This module is the ONLY way a test should reach the database. Importing it
 * re-points `@vartalap/database` at a test database before that module is
 * evaluated, which is why the fixture lives here and not in a `beforeAll`:
 *
 *     import { sql, db, testDb } from '@vartalap/database/test-harness'
 *
 * `src/index.ts` throws at import when `DATABASE_URL` is unset, and it reads the
 * variable at module scope. A test file that imported it statically would throw
 * before any hook could run, so the harness is a self-bootstrapping module with a
 * top-level `await`, and the real singleton is imported DYNAMICALLY, afterwards.
 * Import the harness; do not import `@vartalap/database` from a test.
 *
 * ── what it does ────────────────────────────────────────────────────────────
 *
 * 1. `TEST_DATABASE_URL` if it is set — the escape hatch for a REAL Postgres,
 *    which is what gate G1b waits for. See the warning below.
 * 2. Otherwise it boots PGlite — Postgres compiled to WASM — behind a socket
 *    server, exactly the way `scripts/db-local.ts` does, so `drizzle-kit` and
 *    `postgres.js` both speak ordinary `postgres://` and nothing downstream knows
 *    it is WASM. It is a SEPARATE database from the development one; see below.
 * 3. Runs the real `drizzle-kit migrate` when the database has no tables, so the
 *    fixture cannot drift from what deploy runs.
 *
 * ── ⚠ it is `TEST_DATABASE_URL`, not `DATABASE_URL` ─────────────────────────
 *
 * The stage 3 plan says the fixture uses `DATABASE_URL` when one is set. Written
 * that way, `bun test` in this repo TRUNCATES the development database — which is
 * exactly what it did the first time this ran, on `localhost:5433` — because
 * `.env` always sets `DATABASE_URL`, and `.env` always points at the database
 * `bun run db:local` is serving. The same line pointed at Neon would truncate
 * Neon.
 *
 * A fixture that destroys a database it did not create is not a fixture, it is a
 * loaded gun with `beforeEach` on it. So the override is a differently-named
 * variable, which cannot be set by accident by copying `.env.example`. Point
 * `TEST_DATABASE_URL` at a throwaway database or a scratch Neon branch — never
 * production.
 *
 * ── why not port 5433 ───────────────────────────────────────────────────────
 *
 * Reusing the development server would be faster. But this fixture TRUNCATES
 * every table between tests, so pointing that at the database somebody is
 * developing against means a test run silently eats their handles, and a
 * `bun run auth:smoke` in another shell interleaves with a truncate.
 * `PGLITE_TEST_PORT` moves the socket; the data dir is always
 * `.db/pglite-test`, which is gitignored local state like `.db/pglite`.
 *
 * ── ⚠ PGlite is effectively single-connection ───────────────────────────────
 *
 * It is a WASM build of Postgres behind one serialising server. Two genuinely
 * concurrent transactions do not race — the second one WAITS for the first, so a
 * test written that way HANGS rather than fails. Therefore:
 *
 *   - Do not write a test that needs two open transactions at once. There is no
 *     such test here, and that is exactly why gate G1b (real concurrency, real
 *     Postgres) is a separate test that SKIPS LOUDLY when this is the target.
 *   - The pool is pinned to one connection for the same reason. A second one
 *     blocks behind the first and reads as a slow query, which is harder to
 *     diagnose than a failure.
 *
 * A test that passes here has proved the guarantee holds on a correct
 * implementation. It has proved nothing about concurrency, and
 * `docs/plans/stage-3.md` records that distinction rather than blurring it.
 *
 * Nothing here is used by the running server. If a production path ever imports
 * this file, that is a bug.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';

export type TestDatabaseKind = 'pglite' | 'postgres';

export interface TestDatabase {
  /** The `postgres://` URL every test in this process is talking to. */
  readonly url: string;
  readonly kind: TestDatabaseKind;
  /** `TRUNCATE`s every application table. Drizzle's ledger is never touched. */
  reset(): Promise<void>;
  /** Stops a PGlite this process booted. A no-op against a real server. */
  stop(): Promise<void>;
}

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const DOT_DB_DIR = new URL('../../../.db', import.meta.url).pathname;
const PGLITE_DATA_DIR = new URL('../../../.db/pglite-test', import.meta.url).pathname;

const PGLITE_HOST = process.env.PGLITE_TEST_HOST ?? '127.0.0.1';
const PGLITE_PORT = Number(process.env.PGLITE_TEST_PORT ?? 5434);
const PGLITE_URL = `postgres://vartalap:vartalap@${PGLITE_HOST}:${PGLITE_PORT}/vartalap`;

/**
 * `postgres.js` resolves to the rows array itself. That is not a typo and it is
 * not `node-postgres` — reaching for `.rows` here yields `undefined`, and the
 * failure reads as an empty result set rather than as a bug.
 */
async function reachable(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Lazily imported so a run against a real `DATABASE_URL` never pays for WASM, and
 * so importing the harness does not throw on a machine without the packages.
 */
async function openPGlite(): Promise<() => Promise<void>> {
  const [{ PGlite }, { pg_trgm }, { pgcrypto }, { PGLiteSocketServer }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
    import('@electric-sql/pglite/contrib/pgcrypto'),
    import('@electric-sql/pglite-socket'),
  ]);

  // PGlite creates its data dir with a non-recursive mkdir, so wiping `.db`
  // wholesale leaves the parent missing and the next boot fails with ENOENT.
  await mkdir(DOT_DB_DIR, { recursive: true });

  const pg = await PGlite.create({ extensions: { pg_trgm, pgcrypto }, dataDir: PGLITE_DATA_DIR });
  const server = new PGLiteSocketServer({ db: pg, port: PGLITE_PORT, host: PGLITE_HOST });
  await server.start();
  return async () => {
    await server.stop();
    await pg.close();
  };
}

const noop = async (): Promise<void> => {};

/**
 * A throwaway client, closed before it returns. This exists so nothing in this
 * file holds PGlite's one client slot while `migrate()` spawns a child that needs
 * it too.
 */
async function withClient<T>(url: string, fn: (client: postgres.Sql) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 2 }).catch(() => {});
  }
}

async function isEmpty(url: string): Promise<boolean> {
  return withClient(url, async (client) => {
    const rows = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`;
    return rows[0]!.n === 0;
  });
}

async function boot(): Promise<{
  url: string;
  kind: TestDatabaseKind;
  stop: () => Promise<void>;
}> {
  // Deliberately NOT `DATABASE_URL`. See the warning at the top of this file.
  const url = process.env.TEST_DATABASE_URL;
  if (url) return { url, kind: 'postgres', stop: noop };

  // Somebody already owns this port and data dir — a previous run that has not
  // been reaped, most likely. Two PGlite instances over one directory corrupt
  // it, so never race for it.
  if (await reachable(PGLITE_URL)) return { url: PGLITE_URL, kind: 'pglite', stop: noop };
  const stop = await openPGlite();
  return { url: PGLITE_URL, kind: 'pglite', stop };
}

/**
 * The real migration, spawned exactly the way `scripts/db-local.ts` spawns it, so
 * a test database is built by the code that builds a deployed one. The URL is
 * passed in the child's environment rather than inherited, so this does not
 * depend on `.env` having been loaded.
 */
async function migrate(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', ['run', '--filter=@vartalap/database', 'migrate'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      stdio: 'inherit',
    });
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`db:migrate exited ${code}`)),
    );
  });
}

const booted = await boot();

/**
 * Migrate BEFORE the application singleton exists.
 *
 * The ordering is load-bearing and the bug it fixes was real: the first version
 * imported `src/index.ts`, asked it whether the database had any tables, and only
 * then spawned `drizzle-kit migrate` — so the parent was holding PGlite's single
 * client slot while the migration child tried to connect, and the child died with
 * `ECONNRESET`. A short-lived probe connection that is closed again costs nothing.
 */
if (await isEmpty(booted.url)) await migrate(booted.url);

/**
 * Set BEFORE the dynamic import below. `src/index.ts` reads this at module scope
 * and throws without it, so the ordering here is load-bearing, not tidiness.
 */
process.env.DATABASE_URL = booted.url;
if (booted.kind === 'pglite' && !process.env.DATABASE_POOL_MAX) {
  // See the single-connection warning at the top. One connection fails fast; a
  // second one blocks behind the first and looks like latency.
  process.env.DATABASE_POOL_MAX = '1';
}

// `src/index.ts` is the real thing, not a copy. A fixture with its own client
// would prove a configuration the app never runs.
const { sql, db, schema } = await import('./index.ts');

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function reset(): Promise<void> {
  // `drizzle.__drizzle_migrations` is excluded on purpose, and it is excluded by
  // schema rather than by name: truncating it makes every applied migration look
  // unapplied, and the next migrate either re-runs the DDL or dies on a hash
  // mismatch. Truncating every `public` table is the blunt alternative.
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`;

  if (tables.length === 0) throw new Error('no public tables — the harness did not migrate');

  // Identifiers come from information_schema, never from input. CASCADE because
  // this schema is deliberately dense with foreign keys; RESTART IDENTITY because
  // a serial that keeps counting is not a truncated table.
  const list = tables.map((t) => `public.${quoteIdent(t.table_name)}`).join(', ');
  await sql.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export const testDb: TestDatabase = {
  url: booted.url,
  kind: booted.kind,
  reset,
  stop: booted.stop,
};

export { sql, db, schema };
