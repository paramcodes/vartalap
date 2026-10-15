/**
 * A query string into a `historyQuery` or a `catchUpQuery`.
 *
 * Everything untrusted about a read arrives as text — `?limit=2`, `?after=abc`, a
 * `conversationId` that disagrees with the path — and none of it is the protocol's
 * type. So the parsing happens HERE, once, and the routes above receive a value
 * that has already been through the schema in `packages/protocol`. A route that
 * did its own coercion would be a third implementation of "what a cursor is",
 * and the three would disagree about it eventually.
 *
 * **The protocol schema does the work.** `historyQuery` and `catchUpQuery` say
 * what a cursor is (`Seq`: a non-negative decimal string), how many rows a page
 * may hold (`1..100`, defaulting to `PAGE_SIZE`), and that the catch-up cursor is
 * required. Spelling those rules out again in this file would be a copy that
 * rots; this file's job is to hand the raw strings over and translate the
 * complaints back into the envelope's `fields`.
 *
 * ── two guards the schema cannot express ──────────────────────────────────────
 *
 * 1. **A cursor that fits a `Seq` but not a `bigint`.** `Seq` is a string and
 *    `92233720368547758070` matches its pattern; binding it produces SQLSTATE
 *    `22003` inside Postgres and a `500` on the wire. A position a database
 *    cannot store is a bad request, not a server fault, and this is the last place
 *    that can still say so. `position.ts` owns that arithmetic — including the
 *    2^53 round trip, which is the quieter half — and this file only decides what
 *    to SAY about it.
 * 2. **A path and a body that disagree.** The conversation is in the path AND in
 *    the query, for the reason ADR 0059 gives: a payload that does not say which
 *    conversation it belongs to is a bug that can only appear on a platform nobody
 *    has built yet. The router never fills it in — it compares.
 *
 * **`before` and `after` together are refused**, and this is the one rule here
 * that the protocol leaves open. They are cursors for two different ORDER BYs, so
 * a request carrying both has not asked for a window, it has failed to say which
 * way it wants to read. Answering it with one of them chosen silently is how a
 * client ends up with a loop that never terminates. Neither cursor is a valid
 * initial load either, and that case is NOT an error: it is the newest page, which
 * is what opening a conversation means.
 */
import { catchUpQuery, conversationId as conversationIdScalar, historyQuery, type CatchUpQuery, type HistoryQuery, type Seq } from '@vartalap/protocol';
import { storedPosition } from './position.ts';

/** One complaint about one field, in the shape `errorEnvelope` carries. */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fields: FieldIssue[] };

function issuesOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): FieldIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * `?limit=` as the protocol's number, and `NaN` when it is not a number at all —
 * which the schema then rejects with a `limit` issue rather than a `NaN` reaching
 * the database. Absent is `undefined`, so `PAGE_SIZE` is the one place a page
 * size is decided.
 */
function limitOf(params: URLSearchParams): number | undefined {
  const raw = params.get('limit');
  return raw === null ? undefined : Number(raw);
}

/**
 * `''` for the ways a position cannot be bound exactly.
 *
 * `position.ts` does the arithmetic and explains why a magnitude comparison is the
 * wrong question; this is the half that is about HTTP — which field, and what the
 * caller is told.
 */
function unstorable(name: string, cursor: Seq): FieldIssue[] {
  return storedPosition(cursor) === null
    ? [{ path: name, message: 'is not a position this server can represent exactly' }]
    : [];
}

/**
 * A history query, given the conversation the PATH named.
 *
 * `conversationId` is still required in the query, because `historyQuery` has no
 * default for it and a client that sends the object it already holds should not
 * get a different answer from a client that hand-builds a URL.
 */
export function historyQueryFrom(params: URLSearchParams, pathConversationId: string): Parsed<HistoryQuery> {
  const claimedRaw = params.get('conversationId');
  if (claimedRaw === null) {
    return {
      ok: false,
      fields: [{ path: 'conversationId', message: 'is required, and must match the conversation in the path' }],
    };
  }

  // Lowercased because `uuid` input accepts four spellings of one value, and ADR
  // 0056's whole argument is that the database normalises them while a raw string
  // comparison does not — the same fold `send-route.ts` applies to the path.
  const claimed = conversationIdScalar.safeParse(claimedRaw.toLowerCase());
  if (!claimed.success || claimed.data !== pathConversationId) {
    return { ok: false, fields: [{ path: 'conversationId', message: 'must match the conversation in the path' }] };
  }

  const before = params.get('before');
  const after = params.get('after');
  const parsed = historyQuery.safeParse({
    conversationId: pathConversationId,
    before: before ?? undefined,
    after: after ?? undefined,
    limit: limitOf(params),
  });
  if (!parsed.success) return { ok: false, fields: issuesOf(parsed.error) };

  const { before: cursorBack, after: cursorForward } = parsed.data;
  if (cursorBack !== undefined && cursorForward !== undefined) {
    return {
      ok: false,
      fields: [{ path: 'before', message: 'send `before` or `after`, not both — they are opposite directions' }],
    };
  }

  const overflow = [
    ...(cursorBack === undefined ? [] : unstorable('before', cursorBack)),
    ...(cursorForward === undefined ? [] : unstorable('after', cursorForward)),
  ];
  return overflow.length > 0 ? { ok: false, fields: overflow } : { ok: true, value: parsed.data };
}

/**
 * A catch-up query.
 *
 * `after` is required rather than defaulting to zero, and `catchUpQuery` says why:
 * a client with no cursor has nothing to catch up, and `'0'` is the honest way to
 * say "everything from the beginning". So a missing one is a `400` that teaches
 * that, not a page of the caller's entire history by accident.
 */
export function catchUpQueryFrom(params: URLSearchParams): Parsed<CatchUpQuery> {
  const after = params.get('after');
  if (after === null) {
    return {
      ok: false,
      fields: [{ path: 'after', message: 'is required — use 0 to start from the beginning' }],
    };
  }

  const parsed = catchUpQuery.safeParse({ after, limit: limitOf(params) });
  if (!parsed.success) return { ok: false, fields: issuesOf(parsed.error) };

  const overflow = unstorable('after', parsed.data.after);
  return overflow.length > 0 ? { ok: false, fields: overflow } : { ok: true, value: parsed.data };
}