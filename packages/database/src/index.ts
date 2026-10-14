import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

/**
 * One place that knows how to reach the database, so no caller has to.
 *
 * ADR: **direct** connections for migrations, **pooled** for the app. Neon's pooled
 * endpoint multiplexes over a small number of backends, and anything session-scoped
 * (prepared statements, advisory locks) misbehaves behind it. That matters here
 * specifically: the send path holds `pg_advisory_xact_lock`, and session state is
 * lost when a Neon compute suspends anyway.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

export const sql = postgres(connectionString, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // Long-lived transactions must not be cut short by a library default.
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });
export { schema };
export * from './schema.ts';