/**
 * Message search behind one exported function (ADR 0009, Gate S1).
 *
 * Postgres full-text search using:
 * - Stored generated `tsvector` on 'simple' configuration (never 'english' per 0009).
 * - `websearch_to_tsquery('simple', $query)` so raw input cannot raise syntax errors.
 * - `ts_rank_cd` for ranking, `ts_headline` for snippets.
 * - Scoped strictly to conversations the caller is an active member of (`left_at IS NULL`).
 * - Short query guard (< 3 word characters or pure punctuation) returns empty without query cost.
 */
import { sql } from 'drizzle-orm';
import { db, message } from '@vartalap/database';
import {
  conversationId as conversationIdScalar,
  messageId as messageIdScalar,
  seq as seqScalar,
  userId as userIdScalar,
  type ConversationId,
  type SearchResults,
  type Seq,
  type UserId,
} from '@vartalap/protocol';
import { storedPosition } from './position.ts';

/**
 * ADR 0009: Prefix matching degrades for short strings and punctuation-only
 * queries degenerate into full index scans. Guard requires at least 3 word chars.
 */
export function isSearchableQuery(q: string): boolean {
  const trimmed = q.trim();
  if (trimmed.length < 3) return false;
  const wordChars = trimmed.match(/[\p{L}\p{N}]/gu);
  return wordChars !== null && wordChars.length >= 3;
}

export interface SearchOptions {
  readonly userId: string;
  readonly query: string;
  readonly conversationId?: string | undefined;
  readonly cursor?: Seq | undefined;
  readonly limit?: number | undefined;
}

interface RawSearchResult extends Record<string, unknown> {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly author_id: string;
  readonly body: string;
  readonly snippet: string;
  readonly seq: string;
  readonly created_at: Date | string;
  readonly rank: number | string;
}

export async function searchMessages({
  userId,
  query,
  conversationId,
  cursor,
  limit = 20,
}: SearchOptions): Promise<SearchResults> {
  if (!isSearchableQuery(query)) {
    return { results: [], nextCursor: null };
  }

  const effectiveLimit = Math.max(1, Math.min(limit, 50));
  // Request one extra to determine nextCursor
  const fetchCount = effectiveLimit + 1;

  const conversationFilter = conversationId
    ? sql`AND m.conversation_id = ${conversationId}::uuid`
    : sql``;

  const cursorFilter = cursor
    ? sql`AND m.seq < ${BigInt(cursor)}`
    : sql``;

  const statement = sql<RawSearchResult[]>`
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.author_id,
      m.body,
      ts_headline(
        'simple',
        m.body,
        websearch_to_tsquery('simple', ${query}),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=25, MinWords=10'
      ) AS snippet,
      m.seq::text AS seq,
      m.created_at,
      ts_rank_cd(m.search_vector, websearch_to_tsquery('simple', ${query})) AS rank
    FROM message m
    INNER JOIN member mem
      ON mem.conversation_id = m.conversation_id
      AND mem.user_id = ${userId}::uuid
      AND mem.left_at IS NULL
    WHERE m.search_vector @@ websearch_to_tsquery('simple', ${query})
      ${conversationFilter}
      ${cursorFilter}
    ORDER BY rank DESC, m.seq DESC
    LIMIT ${fetchCount}
  `;

  const rows = await db.execute<RawSearchResult>(statement);
  const hits = Array.from(rows);
  const hasMore = hits.length > effectiveLimit;
  const sliced = hasMore ? hits.slice(0, effectiveLimit) : hits;

  const results = sliced.map((row) => ({
    messageId: messageIdScalar.parse(row.message_id),
    conversationId: conversationIdScalar.parse(row.conversation_id),
    authorId: userIdScalar.parse(row.author_id),
    body: row.body,
    snippet: row.snippet ?? row.body,
    seq: seqScalar.parse(String(row.seq)),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    rank: typeof row.rank === 'number' ? row.rank : parseFloat(String(row.rank)),
  }));

  const nextCursor = hasMore && results.length > 0
    ? results[results.length - 1]!.seq
    : null;

  return { results, nextCursor };
}
