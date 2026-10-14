/**
 * A local Postgres, with no Docker and no sudo.
 *
 * This machine has no Postgres server and no usable Docker socket, which had left
 * `packages/database/drizzle/*.sql` unverified — written, committed, and never
 * executed. That is not a small gap: the first migration failed on a fresh database
 * at statement 181 of 53 because `search_vector` was declared `text` and GIN has no
 * default operator class for it. Reading the SQL did not catch that. Running it did.
 *
 * PGlite is Postgres 18 compiled to WASM. `PGLiteSocketServer` puts a real TCP
 * listener in front of it, so `psql`, `drizzle-kit migrate`, and `drizzle-kit push`
 * all connect over `postgres://` and behave the way the app will in production.
 * Nothing downstream needs to know it is WASM.
 *
 *     bun run db:local        # serve, until Ctrl-C
 *     bun run db:setup        # boot, migrate, exit — leaves the port free
 *
 * The extensions are NOT optional. `drizzle-kit push` does not manage Postgres
 * extensions: it will happily create all fifteen tables and then fail creating
 * `message_body_trgm_idx` with
 *
 *     ERROR: data type text has no default operator class for access method "gin"
 *
 * leaving a database that cannot apply its own trigram index. Loading them here is
 * what stops that, and `db:setup` migrates rather than pushes so 0000_extensions.sql
 * runs in order.
 *
 * Not a production database. Single connection, no fsync guarantees, and it dies
 * with the process — which is the point.
 */
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';

const PORT = Number(process.env.PGLITE_PORT ?? 5433);
const HOST = process.env.PGLITE_HOST ?? '127.0.0.1';
// Not `URL` — that shadows the global constructor and breaks `new URL(..)` below.
const DB_URL = `postgres://vartalap:vartalap@${HOST}:${PORT}/vartalap`;

/**
 * Persistent by default. An in-memory database silently loses every user you just
 * created the moment the process restarts, which reads as "the seed didn't work"
 * rather than "you did not save it". `--fresh` is the deliberate wipe.
 */
const DATA_DIR = new URL('../.db/pglite', import.meta.url).pathname;

if (process.argv.includes('--fresh')) {
  await rm(DATA_DIR, { recursive: true, force: true });
  console.log(`wiped ${DATA_DIR}`);
}

// PGlite creates its data dir with a non-recursive mkdir, so `--fresh` leaves the
// parent missing and the next boot fails with a bare ENOENT.
await mkdir(new URL('../.db', import.meta.url).pathname, { recursive: true });

const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto }, dataDir: DATA_DIR });

/** Runs the real drizzle migrate, so setup cannot drift from what deploy runs. */
async function migrate() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'bun',
      ['run', '--filter=@vartalap/database', 'migrate'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_DATABASE_URL: DB_URL },
        stdio: 'inherit',
      },
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`db:migrate exited ${code}`)),
    );
  });
}

const server = new PGLiteSocketServer({ db, port: PORT, host: HOST });

if (process.argv.includes('--migrate')) {
  await server.start();
  await migrate();
  await server.stop();
  await db.close();
  process.exit(0);
}

await server.start();

const { rows } = await db.query<{ n: number }>(
  `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
);
const exts = await db.query<{ extname: string }>(`select extname from pg_extension order by 1`);

const installed = exts.rows.map((r) => r.extname);
console.log(`postgres 18 (wasm) on ${HOST}:${PORT} · ${DATA_DIR}`);
console.log(`  ${rows[0].n} tables · installed: ${installed.join(', ')}`);
// Loading an extension into PGlite and CREATE EXTENSION-ing it in the database are
// different things, and only the second creates the operator classes. Saying so
// beats printing "pg_trgm available" above an index that cannot be created.
console.log('  pg_trgm + pgcrypto are loadable here but must be created by a migration');
if (rows[0].n === 0) console.log('  EMPTY — run `bun run db:setup` to migrate');
else console.log('  ready');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => db.close()).then(() => process.exit(0));
  });
}
