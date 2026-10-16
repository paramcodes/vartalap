import { z } from 'zod';
import { conversationId, messageId, seq, userId } from './scalars.ts';

/**
 * One match from full-text message search (ADR 0009).
 *
 * `snippet` is generated via Postgres `ts_headline('simple', ...)` with matching
 * terms wrapped in `<mark>...</mark>`. `rank` is `ts_rank_cd`.
 */
export const searchHit = z.object({
  messageId,
  conversationId,
  authorId: userId,
  body: z.string(),
  snippet: z.string(),
  seq,
  createdAt: z.string(),
  rank: z.number(),
});

export type SearchHit = z.infer<typeof searchHit>;

export const searchResults = z.object({
  results: z.array(searchHit),
  nextCursor: seq.nullable(),
});

export type SearchResults = z.infer<typeof searchResults>;
