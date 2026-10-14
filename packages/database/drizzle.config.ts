import { defineConfig } from 'drizzle-kit';

/**
 * Neon's pooled connection is what the app uses; migrations want a DIRECT one.
 * `drizzle-kit` against a pooled endpoint works for `push` and then fails in a way
 * that looks like a schema bug.
 */
const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (or DIRECT_DATABASE_URL) is required');

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  // ADR 0008: the raw upload is never served, and nothing writes user-controlled
  // paths into a query. Drizzle parameterises; this is belt-and-braces documentation.
  strict: true,
  verbose: true,
});