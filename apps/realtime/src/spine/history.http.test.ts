/**
 * History and catch-up, over real HTTP, against a running server.
 *
 * `history.test.ts` proves the two reads. This proves the endpoint in front of
 * them: the routes, the session boundary, the query-string parsing, the error
 * envelope, and — the part a client actually experiences — that a member who may
 * not read a conversation cannot tell that it exists.
 *
 * ── why this file signs up ONCE ──────────────────────────────────────────────
 *
 * Better Auth rate-limits its own HTTP surface, and because the client IP cannot be
 * resolved it falls back to one shared bucket per path: **three `/sign-up/email`
 * requests per run, then `429`**, and the counter does not recover inside a run.
 * `send.http.test.ts` spends one and `src/server.test.ts` spends one, so this file
 * spends the last one and takes exactly one.
 *
 * Isolation is **a fresh conversation per test**, never a fresh member, and every
 * assertion is scoped by `conversation_id`. Messages are sent through the real
 * `POST /messages` endpoint rather than by inserting rows, so a page is tested
 * against rows the real write path produced.
 *
 *     bun run test
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  PAGE_SIZE,
  catchUpPage,
  conversationId as conversationIdScalar,
  errorEnvelope,
  historyPage,
  sendMessageRequest,
  sendMessageResponse,
  seq as seqScalar,
  type ConversationId,
  type Message,
  type Seq,
  type UserId,
} from '@vartalap/protocol';
import { start } from '../server.ts';
import { sendMessage } from './send.ts';
import {
  captureSql,
  createDirectConversation,
  insertUser,
  newMessageId,
  queriesOf,
  signUpOverHttp,
} from './fixture.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

let member: Awaited<ReturnType<typeof signUpOverHttp>>;

/** A conversation this member is in, with a peer who is not. Fresh per test. */
async function conversationForMember(): Promise<ConversationId> {
  const peerId = await insertUser('Peer');
  const direct = await createDirectConversation([member.userId, peerId]);
  return direct.conversationId;
}

/** A conversation this member is not in at all. */
async function conversationWithoutMember(): Promise<{ conversationId: ConversationId; authorId: UserId }> {
  const [one, two] = await Promise.all([insertUser('One'), insertUser('Two')]);
  const direct = await createDirectConversation([one, two]);
  return { conversationId: direct.conversationId, authorId: one };
}

/** A conversation nobody is in, named by a uuid that was never written. */
const NO_SUCH_CONVERSATION = '00000000-0000-4000-8000-000000000000';

const historyPath = (conversationId: string): string => `/api/conversations/${conversationId}/history`;

/** The query a client would build from a `historyQuery` and the path it used. */
function historyUrl(conversationId: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ conversationId, ...params });
  return `${historyPath(conversationId)}?${search.toString()}`;
}

function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'GET',
    headers: cookie === undefined ? {} : { cookie },
  });
}

/** The real write path, over real HTTP, as the signed-in member. */
async function send(conversationId: ConversationId, body: string): Promise<Message> {
  const response = await fetch(`${origin}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member.cookie },
    body: JSON.stringify({ conversationId, id: newMessageId(), body, attachments: [] }),
  });
  if (!response.ok) throw new Error(`send failed: ${response.status} ${await response.text()}`);
  return sendMessageResponse.parse(await response.json()).message;
}

/**
 * A message written by somebody who is not the signed-in member.
 *
 * Same function the endpoint calls, minus the HTTP hop — because a row in
 * somebody else's conversation has to exist, and this file spends its entire
 * sign-up budget on one member. No row is ever inserted by hand: this is the real
 * write path, lock and outbox row included.
 */
async function sayAs(authorId: UserId, conversationId: ConversationId, body: string): Promise<Message> {
  const outcome = await sendMessage({
    authorId,
    request: sendMessageRequest.parse({ conversationId, id: newMessageId(), body, attachments: [] }),
  });
  if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
  return outcome.message;
}

const bodiesOf = (messages: readonly Message[]): string[] => messages.map((message) => message.body);

function positionOf(wire: { seq: Seq | null }): Seq {
  if (wire.seq === null) throw new Error('a committed message has no position');
  return wire.seq;
}

/** The field paths a `400` names, for the assertions that care which field. */
function fieldsOf(envelope: ReturnType<typeof errorEnvelope.parse>): string[] {
  if (envelope.error.code !== 'invalidRequest') throw new Error(`expected invalidRequest, got ${envelope.error.code}`);
  return (envelope.error.fields ?? []).map((field) => field.path);
}

beforeAll(async () => {
  await testDb.reset();
  member = await signUpOverHttp(origin);
});

afterAll(() => {
  server.stop(true);
  // Deliberately NOT `testDb.stop()` — the fixture is a process-lifetime
  // singleton shared by every test file in the run.
});

test('an unauthenticated read is 401 on both endpoints', async () => {
  const conversationId = await conversationForMember();

  for (const path of [historyUrl(conversationId), '/api/catch-up?after=0']) {
    const response = await get(path);
    expect(response.status).toBe(401);
    const envelope = errorEnvelope.parse(await response.json());
    expect(envelope.error.code).toBe('unauthenticated');
    // Retryable, and a field rather than a status a client mirrors: a signed-out
    // member's reads re-run after sign-in rather than becoming an error state.
    expect(envelope.error.retryable).toBe(true);
  }
});

test('the newest page is real rows, newest first, with the head and the count', async () => {
  const conversationId = await conversationForMember();
  await send(conversationId, 'one');
  await send(conversationId, 'two');
  const third = await send(conversationId, 'three');

  const response = await get(historyUrl(conversationId), member.cookie);
  expect(response.status).toBe(200);

  // Parsed through the protocol schema, so the claim is that the server's answer is
  // one the protocol accepts.
  const page = historyPage.parse(await response.json());

  expect(bodiesOf(page.messages)).toEqual(['three', 'two', 'one']);
  expect(page.messages[0]!.id).toBe(third.id);
  expect(page.messages[0]!.authorId).toBe(member.userId);
  expect(page.messages[0]!.conversationId).toBe(conversationId);
  // A `bigint` on the wire is a DECIMAL STRING, never a number (ADR 0005).
  expect(typeof page.messages[0]!.seq).toBe('string');
  expect(page.latestSeq).toBe(positionOf(third));
  expect(page.totalCount).toBe(3);
});

test('the page size is the one asked for, and `totalCount` is still the whole conversation', async () => {
  // Gate G4's server half, over the wire a client actually calls. Two rows back,
  // three rows counted — the two can only be equal on a full page, which is why
  // this asks for a short one.
  const conversationId = await conversationForMember();
  for (const body of ['one', 'two', 'three']) await send(conversationId, body);

  const response = await get(historyUrl(conversationId, { limit: '2' }), member.cookie);
  expect(response.status).toBe(200);
  const page = historyPage.parse(await response.json());

  expect(page.messages).toHaveLength(2);
  expect(bodiesOf(page.messages)).toEqual(['three', 'two']);
  expect(page.totalCount).toBe(3);
});

test('a walk backwards over HTTP covers the transcript exactly once, and a short page ends it', async () => {
  const conversationId = await conversationForMember();
  const bodies = ['one', 'two', 'three', 'four', 'five'];
  for (const body of bodies) await send(conversationId, body);

  const collected: string[] = [];
  const pageLengths: number[] = [];
  let before: string | undefined;

  do {
    const page = historyPage.parse(
      await (await get(historyUrl(conversationId, { limit: '2', ...(before === undefined ? {} : { before }) }), member.cookie)).json(),
    );
    collected.push(...bodiesOf(page.messages));
    pageLengths.push(page.messages.length);
    before = page.messages.at(-1)?.seq ?? undefined;
  } while (pageLengths.at(-1) === 2);

  expect(pageLengths).toEqual([2, 2, 1]);
  expect(collected).toEqual(['five', 'four', 'three', 'two', 'one']);
});

test('the default page is 50 — the constant, bound as a parameter', async () => {
  // ADR 0005: fifty rows, and "the exact number matters less than it being a
  // constant". This asserts the number reached the DATABASE rather than trusting
  // the schema's `.default(50)` to still be wired up.
  const conversationId = await conversationForMember();
  await send(conversationId, 'only one');

  const { result, statements } = await captureSql(sql, () =>
    get(historyUrl(conversationId), member.cookie),
  );
  expect(result.status).toBe(200);

  const page = statements.find((statement) => /from "message"/.test(statement.query) && /order by/i.test(statement.query));
  if (page === undefined) throw new Error(`no page statement was emitted: ${queriesOf(statements).join(' | ')}`);
  // [conversation, cursor, limit] — the cursor is the "everything below" sentinel
  // and the limit is the constant.
  expect(page.parameters[2]).toBe(PAGE_SIZE);
  expect(page.parameters[2]).toBe(50);
});

test('a conversation the caller is not in is indistinguishable from one that does not exist', async () => {
  // The security-relevant ruling, and the reason this endpoint has no "not a
  // member" branch: the two answers are the same BYTES, not merely the same
  // status. A `404` for one and an empty page for the other would be a
  // conversation list the caller is not allowed to see.
  const elsewhere = await conversationWithoutMember();
  await sayAs(elsewhere.authorId, elsewhere.conversationId, 'not yours');

  const notMine = await get(historyUrl(elsewhere.conversationId), member.cookie);
  const doesNotExist = await get(historyUrl(NO_SUCH_CONVERSATION), member.cookie);
  const empty = await conversationForMember();
  const genuinelyEmpty = await get(historyUrl(empty), member.cookie);

  expect(notMine.status).toBe(200);
  expect(doesNotExist.status).toBe(200);
  // Byte comparison, so this is the whole response and not a field somebody
  // picked — and `.text()` once each, because a body can only be read once.
  const notMineBody = await notMine.text();
  expect(notMineBody).toBe(await doesNotExist.text());
  expect(notMineBody).toBe(await genuinelyEmpty.text());
  // …and it really is empty: no rows and no volume.
  expect(historyPage.parse(JSON.parse(notMineBody))).toEqual({
    messages: [],
    latestSeq: seqScalar.parse('0'),
    totalCount: 0,
  });
});

test('a peer leaving takes nothing out of the transcript the member can still read', async () => {
  // The other half of `left_at IS NULL`: it removes the PEER from the read set, and
  // it must not remove a single row from anybody else's. A member who left remains
  // a member FOR HISTORY (the glossary), and this is the read side of that.
  const peerId = await insertUser('Leaver');
  const direct = await createDirectConversation([member.userId, peerId]);
  await send(direct.conversationId, 'while they were here');
  await sayAs(peerId, direct.conversationId, 'and they answered');
  await sql`UPDATE member SET left_at = now() WHERE user_id = ${peerId}`;

  const response = await get(historyUrl(direct.conversationId), member.cookie);
  expect(response.status).toBe(200);
  const page = historyPage.parse(await response.json());

  expect(bodiesOf(page.messages)).toEqual(['and they answered', 'while they were here']);
  expect(page.totalCount).toBe(2);
  expect(page.latestSeq).toBe(positionOf(page.messages[0]!));
});

test('catch-up is one query for the whole account, and never reaches somebody else\'s conversation', async () => {
  const first = await conversationForMember();
  const second = await conversationForMember();
  const elsewhere = await conversationWithoutMember();

  await send(first, 'first-1');
  const notYours = await sayAs(elsewhere.authorId, elsewhere.conversationId, 'not yours');
  await send(second, 'second-1');
  await send(first, 'first-2');

  const response = await get('/api/catch-up?after=0', member.cookie);
  expect(response.status).toBe(200);
  const page = catchUpPage.parse(await response.json());

  // Scoped to THIS test's conversations: the account cursor is global, so earlier
  // tests in this file have rows in the database too, and `after=0` legitimately
  // returns those as well. What must hold is that this member's own rows come back
  // in one strictly increasing run across two conversations — only possible
  // because `seq` is a single global column (ADR 0005) — and that the stranger's
  // row never appears at all.
  const mine = new Set<string>([first, second]);
  const mineInOrder = page.messages.filter((message) => mine.has(message.conversationId));
  expect(bodiesOf(mineInOrder)).toEqual(['first-1', 'second-1', 'first-2']);

  const positions = page.messages.map(positionOf).map(Number);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));

  expect(page.messages.map((message) => message.id)).not.toContain(notYours.id);
  for (const message of page.messages) expect(message.conversationId).not.toBe(elsewhere.conversationId);
});

test('a catch-up cursor pages towards the present, exclusively', async () => {
  const conversationId = await conversationForMember();
  const first = await send(conversationId, 'one');
  await send(conversationId, 'two');
  const third = await send(conversationId, 'three');

  const response = await get(`/api/catch-up?after=${positionOf(first)}&limit=1`, member.cookie);
  expect(response.status).toBe(200);
  const page = catchUpPage.parse(await response.json());

  expect(bodiesOf(page.messages)).toEqual(['two']);
  // The cursor is exclusive: the row it names is not repeated on the next page.
  expect(page.messages.map(positionOf)).not.toContain(positionOf(first));
  // `latestSeq` is the caller's HEAD, unfiltered by the cursor, so the loop knows
  // when to stop without asking for one more page.
  expect(page.latestSeq).toBe(positionOf(third));
});

test('a bad query is a `400` that names the field, and a stranger\'s path is a `404`', async () => {
  const conversationId = await conversationForMember();
  const bad: [string, string, string[]][] = [
    // path, what it gets wrong, the field it must name
    [historyUrl(conversationId, { limit: '0' }), 'limit below the floor', ['limit']],
    [historyUrl(conversationId, { limit: '101' }), 'limit above the ceiling', ['limit']],
    [historyUrl(conversationId, { limit: 'abc' }), 'limit that is not a number', ['limit']],
    [historyUrl(conversationId, { before: 'abc' }), 'a cursor that is not a position', ['before']],
    [historyUrl(conversationId, { after: '-1' }), 'a negative position', ['after']],
    [historyUrl(conversationId, { before: '5', after: '2' }), 'both cursors at once', ['before']],
    [`${historyPath(conversationId)}?limit=2`, 'no conversation in the query', ['conversationId']],
    [
      historyUrl(conversationId, { conversationId: NO_SUCH_CONVERSATION }),
      'a conversation that disagrees with the path',
      ['conversationId'],
    ],
    ['/api/catch-up', 'no cursor at all', ['after']],
    ['/api/catch-up?after=92233720368547758070', 'a cursor no bigint holds', ['after']],
    // 2^53 + 1 is a legal bigint and an illegal JavaScript number: binding it
    // rounds, which would page from a position the client never named. `position.ts`
    // owns the arithmetic; this asserts the route says so.
    ['/api/catch-up?after=9007199254740993', 'a cursor no number holds exactly', ['after']],
    [historyUrl(conversationId, { before: '9007199254740993' }), 'a cursor no number holds exactly', ['before']],
  ];

  for (const [path, why, fields] of bad) {
    const response = await get(path, member.cookie);
    expect(response.status, `${why}: ${path}`).toBe(400);
    const envelope = errorEnvelope.parse(await response.json());
    expect(envelope.error.retryable, why).toBe(false);
    expect(fieldsOf(envelope), why).toEqual(expect.arrayContaining(fields));
  }

  // A path that is not a uuid cannot name a conversation, whatever the caller is.
  // The same 404 everybody gets, so it reveals nothing.
  const stranger = await get(historyPath('not-a-uuid'), member.cookie);
  expect(stranger.status).toBe(404);
  expect(errorEnvelope.parse(await stranger.json()).error.code).toBe('notFound');
});

test('each endpoint answers `405` for a method it does not serve', async () => {
  const conversationId = await conversationForMember();

  for (const path of [historyUrl(conversationId), '/api/catch-up?after=0']) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { cookie: member.cookie } });
    expect(response.status).toBe(405);
    expect(errorEnvelope.parse(await response.json()).error.code).toBe('methodNotAllowed');
  }
});

test('the send endpoint is untouched: `POST …/messages` still writes and `GET` on it is still a 405', async () => {
  // The read path lives on its OWN route, so the send route's committed answers
  // have not moved. If someone ever merges the two, this is the test that says so.
  const conversationId = await conversationForMember();
  const message = await send(conversationId, 'still works');
  expect(message.seq).not.toBeNull();

  const response = await get(`/api/conversations/${conversationId}/messages`, member.cookie);
  expect(response.status).toBe(405);
  expect(errorEnvelope.parse(await response.json()).error.code).toBe('methodNotAllowed');
});

test('an uppercase spelling of the conversation is the same conversation, not a mismatch', async () => {
  // ADR 0056: `uuid` input accepts four spellings of one value, and the database
  // normalises them. A raw string comparison would refuse a legitimate request
  // from a client whose URL builder uppercases.
  const conversationId = await conversationForMember();
  await send(conversationId, 'one');

  const upper = conversationIdScalar.parse(conversationId).toUpperCase();
  const response = await get(`${historyPath(upper)}?conversationId=${upper}`, member.cookie);

  expect(response.status).toBe(200);
  expect(historyPage.parse(await response.json()).messages).toHaveLength(1);
});