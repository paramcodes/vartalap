/**
 * Does the fixture actually work, or does it merely load?
 *
 * A harness that boots, migrates, and silently points at nothing would make every
 * later gate green for the wrong reason, so this file writes a row through the
 * real client, reads it back through the other one, and then proves the truncate
 * ran by asserting the table is empty in a later test.
 *
 *     bun test
 */
import { beforeEach, expect, test } from 'bun:test';
import { db, sql, testDb } from './test-harness.ts';
import { conversation } from './schema.ts';

beforeEach(async () => {
  await testDb.reset();
});

test('the fixture is pointed at a migrated database', async () => {
  const tables = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  expect(tables[0]!.n).toBeGreaterThanOrEqual(15);
  console.log(`  database: ${testDb.url} (${testDb.kind})`);
});

test('a row written through drizzle reads back through postgres.js', async () => {
  const directKey = 'assertion:' + crypto.randomUUID();

  const inserted = await db
    .insert(conversation)
    .values({ kind: 'direct', directKey })
    .returning({ id: conversation.id, lastSeq: conversation.lastSeq });
  expect(inserted).toHaveLength(1);

  // postgres.js resolves to the rows array itself. `.rows` is `undefined` here,
  // which is a node-postgres habit that reads as "no rows found".
  const rows = await sql<{ id: string; direct_key: string; last_seq: string }[]>`
    SELECT id, direct_key, last_seq FROM conversation WHERE direct_key = ${directKey}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(inserted[0]!.id);
  expect(rows[0]!.direct_key).toBe(directKey);
  // bigint comes back as a string, not a number — Postgres has no 64-bit JS type.
  expect(rows[0]!.last_seq).toBe('0');
});

test('the fixture truncates between tests', async () => {
  // The previous test inserted a conversation. If reset() did nothing, this count
  // would be 1 and every later unit would inherit each other's rows.
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conversation`;
  expect(rows[0]!.n).toBe(0);
});

test('a constraint violation is a real failure, not a silent no-op', async () => {
  // The converse of the test above: if writes were being swallowed, everything
  // would "pass" and nothing would be proved. `conversation_kind_direct_key`
  // refuses a direct conversation with no direct_key.
  //
  // Wrapped in an async arrow on purpose. A Drizzle query builder is a thenable,
  // not a Promise, and `expect(...).rejects` asserts on `instanceof Promise`, so
  // handed the builder directly it dumps the whole query object and fails.
  await expect(
    (async () => {
      await db.insert(conversation).values({ kind: 'direct', directKey: null });
    })(),
  ).rejects.toThrow(/conversation_kind_direct_key/);
});
