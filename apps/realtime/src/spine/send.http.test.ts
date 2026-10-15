/**
 * The send endpoint, over real HTTP, against a running server.
 *
 * `send.test.ts` proves the transaction. This proves the endpoint: the route, the
 * session boundary, the wire shapes, and the three answers a real client can
 * receive. A spine proved only at the function boundary has a half-proven route in
 * front of it, and the route is where the failures live — a body parsed before the
 * transaction, an envelope assembled by hand, a status and a body that disagree.
 *
 * ── why this file signs up ONCE ──────────────────────────────────────────────
 *
 * Better Auth rate-limits its own HTTP surface, and the limit is per path in a
 * single shared bucket because the client IP cannot be resolved (it warns about
 * exactly this). **Measured on this machine: three `/sign-up/email` requests per
 * window, then `429`.** Signing up per test would make this file's tenth test fail
 * for a reason that has nothing to do with the send path.
 *
 * So the member signs up once in `beforeAll` — over HTTP, keeping the
 * `Set-Cookie` header, exactly as `src/server.test.ts` does and for the same
 * reason: `auth.api.signUpEmail` returns the session TOKEN while `requireSession`
 * verifies the signed HttpOnly cookie, so anything testing a protected route has
 * to walk the real boundary. A member who can only send because the test handed the
 * handler a user id is not a member the endpoint protects.
 *
 * Isolation comes from **a fresh conversation per test** instead of a fresh
 * member. Every assertion is scoped to that conversation, so a test cannot see
 * another's rows and cannot pass because of leftovers. The second member of each
 * pair is written straight to `user` (`insertUser`), which needs no session and no
 * rate-limit budget.
 *
 *     bun run test
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  attachment,
  conversationId as conversationIdScalar,
  errorEnvelope,
  sendMessageRequest,
  sendMessageResponse,
  type ConversationId,
} from '@vartalap/protocol';
import { start } from '../server.ts';
import { createDirectConversation, insertUser, newMessageId, signUpOverHttp, uuidV7 } from './fixture.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

let author: Awaited<ReturnType<typeof signUpOverHttp>>;

/**
 * A conversation this member is in, with a second member who is not the author.
 * Fresh per test, which is how this file stays isolated.
 */
async function conversationForAuthor(): Promise<ConversationId> {
  const peerId = await insertUser('Peer');
  return createDirectConversation([author.userId, peerId]).then((direct) => direct.conversationId);
}

/** A conversation this member is NOT in. Built from two written users. */
async function conversationWithoutAuthor(): Promise<ConversationId> {
  const [one, two] = await Promise.all([insertUser('One'), insertUser('Two')]);
  return createDirectConversation([one, two]).then((direct) => direct.conversationId);
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

function sendPath(conversationId: string): string {
  return `/api/conversations/${conversationId}/messages`;
}

/** The same id, unbranded, for a path segment. */
const asPath = (id: ConversationId): string => conversationIdScalar.parse(id);

/**
 * A committed message's position.
 *
 * `seq` is nullable on the wire because `null` is a real state — it is what a
 * queued send holds until the server answers (ADR 0060). A row that came back
 * from this endpoint has one, so this is an assertion rather than a cast.
 */
function positionOf(message: { seq: string | null }): string {
  if (message.seq === null) throw new Error('a committed message has no position');
  return message.seq;
}

beforeAll(async () => {
  await testDb.reset();
  author = await signUpOverHttp(origin);
});

test('an unauthenticated send is 401 and writes nothing', async () => {
  const conversationId = await conversationForAuthor();
  const response = await post(sendPath(conversationId), {
    conversationId,
    id: newMessageId(),
    body: 'hello',
    attachments: [],
  });

  expect(response.status).toBe(401);
  const envelope = errorEnvelope.parse(await response.json());
  expect(envelope.error.code).toBe('unauthenticated');
  // Retryable, and it is a field rather than a status code a client mirrors.
  expect(envelope.error.retryable).toBe(true);

  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM message WHERE conversation_id = ${conversationId}`;
  expect(rows[0]!.n).toBe('0');
});

test('a send is 200 with the canonical row, and the row and its outbox row are on disk', async () => {
  const conversationId = await conversationForAuthor();
  const id = newMessageId();
  const clientCreatedAt = '2026-10-15T09:30:00.000Z';

  const response = await post(
    sendPath(conversationId),
    { conversationId, id, body: 'hello from http', attachments: [], clientCreatedAt },
    author.cookie,
  );

  expect(response.status).toBe(200);
  // Parsed through the protocol schema, not compared field by field: the claim is
  // that the server's answer is one the protocol accepts.
  const parsed = sendMessageResponse.parse(await response.json());

  expect(parsed.deduplicated).toBe(false);
  expect(parsed.message.id).toBe(id);
  expect(parsed.message.conversationId).toBe(conversationId);
  expect(parsed.message.authorId).toBe(author.userId);
  expect(parsed.message.body).toBe('hello from http');
  expect(parsed.message.createdAt).toBe(clientCreatedAt);
  // A bigint on the wire is a DECIMAL STRING, never a number.
  expect(typeof parsed.message.seq).toBe('string');
  expect(BigInt(positionOf(parsed.message))).toBeGreaterThan(0n);

  // …and the same facts are in the database, not just in the response.
  const stored = await sql<{ seq: string; body: string; author_id: string }[]>`
    SELECT seq, body, author_id FROM message WHERE id = ${id}`;
  expect(stored).toHaveLength(1);
  expect(stored[0]!.seq).toBe(positionOf(parsed.message));
  expect(stored[0]!.body).toBe('hello from http');
  expect(stored[0]!.author_id).toBe(author.userId);

  // The outbox row is the publishable frame, committed before the response.
  const outbox = await sql<{ message_seq: string; payload: unknown }[]>`
    SELECT message_seq, payload FROM outbox WHERE message_seq = ${positionOf(parsed.message)}`;
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.message_seq).toBe(positionOf(parsed.message));
  expect(outbox[0]!.payload).toEqual({
    type: 'message.created',
    conversationId,
    message: parsed.message,
  });

  // And the conversation's position moved with it.
  const conversation = await sql<{ last_seq: string }[]>`
    SELECT last_seq FROM conversation WHERE id = ${conversationId}`;
  expect(conversation[0]!.last_seq).toBe(positionOf(parsed.message));
});

test('the same key and the same content: identical `seq`, `deduplicated: true`, one row', async () => {
  const conversationId = await conversationForAuthor();
  const id = newMessageId();
  const body = { conversationId, id, body: 'only once', attachments: [] };

  const firstResponse = await post(sendPath(conversationId), body, author.cookie);
  expect(firstResponse.status).toBe(200);
  const first = sendMessageResponse.parse(await firstResponse.json());

  const retryResponse = await post(sendPath(conversationId), body, author.cookie);
  const retry = sendMessageResponse.parse(await retryResponse.json());

  expect(retryResponse.status).toBe(200);
  expect(retry.deduplicated).toBe(true);
  // Returning the ORIGINAL with its position is the point: the client reconciles
  // from its own retry response instead of waiting for an echo over the socket.
  expect(retry.message).toEqual(first.message);
  expect(positionOf(retry.message)).toBe(positionOf(first.message));

  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM message WHERE conversation_id = ${conversationId}`;
  expect(rows[0]!.n).toBe('1');
  // One outbox row as well. A retry that re-published would be at-least-once churn
  // the relay cannot undo.
  const outbox = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM outbox WHERE conversation_id = ${conversationId}`;
  expect(outbox[0]!.n).toBe('1');
});

test('the same key and different content: 409, naming the field', async () => {
  const conversationId = await conversationForAuthor();
  const id = newMessageId();

  await post(sendPath(conversationId), { conversationId, id, body: 'first', attachments: [] }, author.cookie);
  const response = await post(
    sendPath(conversationId),
    { conversationId, id, body: 'second', attachments: [] },
    author.cookie,
  );

  expect(response.status).toBe(409);
  const envelope = errorEnvelope.parse(await response.json());
  expect(envelope.error.code).toBe('idempotencyConflict');
  // Terminal, so a client stops instead of retrying a bug forever.
  expect(envelope.error.retryable).toBe(false);
  if (envelope.error.code !== 'idempotencyConflict') throw new Error('unreachable');
  expect(envelope.error.conflictingFields).toEqual(['body']);
  expect(envelope.error.postgresCode).toBe('23505');

  // The original is untouched. A `409` must never overwrite what it collides with.
  const rows = await sql<{ body: string }[]>`SELECT body FROM message WHERE id = ${id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.body).toBe('first');
});

test('a validation 400 leaves the idempotency key UNUSED, so the retry is a fresh attempt', async () => {
  // ADR 0059, copied from Stripe: "a `429`, or a `400` that fails validation,
  // leaves the key unused and the request retryable." The implementation
  // consequence is that nothing is written before the row is about to be committed
  // — which is only testable by refusing, then succeeding, with the same key.
  const conversationId = await conversationForAuthor();
  const id = newMessageId();

  const refused = await post(
    sendPath(conversationId),
    // `attachments` missing: the schema says a list, never absent.
    { conversationId, id, body: 'hello' },
    author.cookie,
  );
  expect(refused.status).toBe(400);
  const envelope = errorEnvelope.parse(await refused.json());
  expect(envelope.error.code).toBe('invalidRequest');

  const none = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM message WHERE conversation_id = ${conversationId}`;
  expect(none[0]!.n).toBe('0');

  // Same key, valid bytes. If the refusal had consumed it, this would be a 409.
  const accepted = await post(
    sendPath(conversationId),
    { conversationId, id, body: 'hello', attachments: [] },
    author.cookie,
  );
  expect(accepted.status).toBe(200);
  expect(sendMessageResponse.parse(await accepted.json()).deduplicated).toBe(false);
});

test('a send whose id is not a UUIDv7 is refused, and `crypto.randomUUID()` is exactly that mistake', async () => {
  const conversationId = await conversationForAuthor();
  const response = await post(
    sendPath(conversationId),
    { conversationId, id: crypto.randomUUID(), body: 'hello', attachments: [] },
    author.cookie,
  );

  expect(response.status).toBe(400);
  const envelope = errorEnvelope.parse(await response.json());
  if (envelope.error.code !== 'invalidRequest') throw new Error('unreachable');
  // The field is NAMED, which is what the composer's `Not sent` strip reads.
  expect(envelope.error.fields?.map((field) => field.path)).toContain('id');
  expect(envelope.error.fields?.[0]?.message).toContain('UUIDv7');
});

test('the path and the body must agree on the conversation', async () => {
  // ADR 0059: the conversation is in the path AND the body, and the router does
  // not fill it in — because a payload that cannot be wrong cannot be wrong.
  const mine = await conversationForAuthor();
  const elsewhere = await conversationForAuthor();

  const response = await post(
    sendPath(elsewhere),
    { conversationId: mine, id: newMessageId(), body: 'hello', attachments: [] },
    author.cookie,
  );

  expect(response.status).toBe(400);
  const envelope = errorEnvelope.parse(await response.json());
  if (envelope.error.code !== 'invalidRequest') throw new Error('unreachable');
  expect(envelope.error.fields?.[0]?.path).toBe('conversationId');
});

test('an uppercase spelling of the conversation is the same conversation, not a mismatch', async () => {
  // ADR 0056 exists because `uuid` input accepts four spellings of one value. If
  // the route compared raw strings, a client whose JSON builder uppercases uuids
  // would get a `400` on a request that names the right conversation.
  const conversationId = await conversationForAuthor();

  const response = await post(
    sendPath(asPath(conversationId).toUpperCase()),
    { conversationId, id: newMessageId(), body: 'hello', attachments: [] },
    author.cookie,
  );

  expect(response.status).toBe(200);
  expect(sendMessageResponse.parse(await response.json()).message.conversationId).toBe(conversationId);
});

test('a member of no conversation cannot send into one, and is told why', async () => {
  const elsewhere = await conversationWithoutAuthor();

  const response = await post(
    sendPath(elsewhere),
    { conversationId: elsewhere, id: newMessageId(), body: 'hello', attachments: [] },
    author.cookie,
  );

  expect(response.status).toBe(403);
  const envelope = errorEnvelope.parse(await response.json());
  expect(envelope.error.code).toBe('sendBlocked');
  if (envelope.error.code !== 'sendBlocked') throw new Error('unreachable');
  // The composer already renders copy for these reasons, so the envelope names one
  // rather than inventing a boolean.
  expect(envelope.error.reason).toBe('not_a_member');
  // Being added is something that happens without the sender doing anything, so
  // these identical bytes could plausibly succeed later.
  expect(envelope.error.retryable).toBe(true);
});

test('attachments are refused with `422`, and nothing is written', async () => {
  const conversationId = await conversationForAuthor();
  const response = await post(
    sendPath(conversationId),
    {
      conversationId,
      id: newMessageId(),
      body: 'look',
      attachments: [attachment.parse({ mediaId: uuidV7(), variant: 'thumb', width: 80, height: 80 })],
    },
    author.cookie,
  );

  expect(response.status).toBe(422);
  const envelope = errorEnvelope.parse(await response.json());
  expect(envelope.error.code).toBe('unprocessable');
  // Retrying these identical bytes reaches this identical answer, forever.
  expect(envelope.error.retryable).toBe(false);

  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM message WHERE conversation_id = ${conversationId}`;
  expect(rows[0]!.n).toBe('0');
});

test('the route answers `405` for a method it does not serve, and `404` for a stranger', async () => {
  const conversationId = await conversationForAuthor();

  const wrongMethod = await fetch(`${origin}${sendPath(conversationId)}`, {
    headers: { cookie: author.cookie },
  });
  expect(wrongMethod.status).toBe(405);
  expect(errorEnvelope.parse(await wrongMethod.json()).error.code).toBe('methodNotAllowed');

  // A path that is not a uuid cannot name a conversation, so it is not a `400` —
  // nothing a client sends in the body would make it resolvable.
  const stranger = await fetch(`${origin}/api/conversations/not-a-uuid/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: author.cookie },
    body: JSON.stringify({ conversationId, id: newMessageId(), body: 'hello', attachments: [] }),
  });
  expect(stranger.status).toBe(404);
  expect(errorEnvelope.parse(await stranger.json()).error.code).toBe('notFound');
});

test('a body that is not JSON is a `400`, not a crash', async () => {
  const conversationId = await conversationForAuthor();
  const response = await fetch(`${origin}${sendPath(conversationId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: author.cookie },
    body: 'not json at all',
  });

  expect(response.status).toBe(400);
  expect(errorEnvelope.parse(await response.json()).error.code).toBe('invalidRequest');
});

test('the request schema and the endpoint agree on what a send is', async () => {
  // A cheap consistency check, and the kind that rots: the fixture builds bodies
  // by hand, so this asserts the hand-built shape is one the endpoint accepts.
  const conversationId = await conversationForAuthor();
  const parsed = sendMessageRequest.parse({
    conversationId,
    id: newMessageId(),
    body: 'hello',
    attachments: [],
  });

  const response = await post(sendPath(conversationId), parsed, author.cookie);
  expect(response.status).toBe(200);
});

afterAll(() => {
  server.stop(true);
  // Deliberately NOT `testDb.stop()` — the fixture is a process-lifetime
  // singleton shared by every test file in the run.
});