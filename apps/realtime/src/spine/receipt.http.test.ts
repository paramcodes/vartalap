/**
 * The three watermark routes, over real HTTP, against a running server.
 *
 * `receipt.test.ts` proves the statement. This proves the endpoint: the paths, the
 * session boundary, the wire shapes, and the answers a real client can receive. Gate
 * G2 is about what is STORED, and a spine proved only at the function boundary has a
 * half-proven route in front of it — and the route is where the failures live: a body
 * parsed after the write, a status and a body that disagree, a response echoing the
 * request instead of the row.
 *
 * ── why this file signs up ONCE ──────────────────────────────────────────────
 *
 * Better Auth rate-limits its own HTTP surface, and the limit is per path in a single
 * shared bucket because the client IP cannot be resolved (decisions index, trap 17).
 * **Measured on this machine: three `/sign-up/email` requests per window, then
 * `429`.** Signing up per test would make this file's tenth test fail for a reason
 * that has nothing to do with the receipt path.
 *
 * Isolation comes from **a fresh conversation per test** instead of a fresh member.
 * Every assertion is scoped to that conversation. The other member of each pair is
 * written straight to `user` (`insertUser`), which needs no session and no
 * rate-limit budget.
 *
 *     bun run test
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  conversationId as conversationIdScalar,
  deliveryAckResponse,
  errorEnvelope,
  receiptAdvanceResponse,
  receiptSharingResponse,
  sendMessageRequest,
  sendMessageResponse,
  type ConversationId,
  type Seq,
} from '@vartalap/protocol';
import { start } from '../server.ts';
import { createDirectConversation, insertUser, newMessageId, signUpOverHttp } from './fixture.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

let member: Awaited<ReturnType<typeof signUpOverHttp>>;

const advancePath = (id: string) => `/api/conversations/${id}/receipt/advance`;
const sharingPath = (id: string) => `/api/conversations/${id}/receipt/sharing`;
const ackPath = (id: string) => `/api/conversations/${id}/delivery/ack`;

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });
}

/** A conversation this member is in, with `count` real messages in it. */
async function conversationWithMessages(count = 0): Promise<{
  conversationId: ConversationId;
  peerId: string;
  positions: Seq[];
}> {
  const peerId = await insertUser('Peer');
  const { conversationId } = await createDirectConversation([member.userId, peerId]);
  const positions: Seq[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await post(
      `/api/conversations/${conversationId}/messages`,
      {
        conversationId,
        id: newMessageId(),
        body: `message ${index}`,
        attachments: [],
      },
      member.cookie,
    );
    const parsed = sendMessageResponse.parse(await response.json());
    if (parsed.message.seq === null) throw new Error('a committed message has no position');
    positions.push(parsed.message.seq);
  }
  return { conversationId, peerId, positions };
}

/** A conversation this member is NOT in. */
async function conversationWithoutMember(): Promise<ConversationId> {
  const [one, two] = await Promise.all([insertUser('One'), insertUser('Two')]);
  const direct = await createDirectConversation([one, two]);
  return direct.conversationId;
}

async function storedReceiptRow(conversationId: string, userId: string): Promise<{
  read_through: string;
  shared_through: string;
  sharing: boolean;
} | null> {
  const rows = await sql<{ read_through: string; shared_through: string; sharing: boolean }[]>`
    SELECT read_through::text AS read_through, shared_through::text AS shared_through, sharing
    FROM receipt WHERE conversation_id = ${conversationId} AND user_id = ${userId}`;
  return rows[0] ?? null;
}

beforeAll(async () => {
  await testDb.reset();
  member = await signUpOverHttp(origin);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The boundary
// ═══════════════════════════════════════════════════════════════════════════════

test('an unauthenticated watermark write is 401 on all three paths, and writes nothing', async () => {
  const { conversationId, positions } = await conversationWithMessages(1);
  const position = positions[0]!;

  const advanced = await post(advancePath(conversationId), { conversationId, readThrough: position, sharedThrough: position });
  expect(advanced.status).toBe(401);
  expect(errorEnvelope.parse(await advanced.json()).error.code).toBe('unauthenticated');

  const shared = await post(sharingPath(conversationId), { conversationId, sharing: false });
  expect(shared.status).toBe(401);

  const acked = await post(ackPath(conversationId), { conversationId, deliveredThrough: position });
  expect(acked.status).toBe(401);

  const rows = await sql<{ receipts: string; deliveries: string }[]>`
    SELECT (SELECT count(*)::text FROM receipt WHERE conversation_id = ${conversationId}) AS receipts,
           (SELECT count(*)::text FROM delivery WHERE conversation_id = ${conversationId}) AS deliveries`;
  expect(rows[0]!.receipts).toBe('0');
  expect(rows[0]!.deliveries).toBe('0');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate G2, through the route
// ═══════════════════════════════════════════════════════════════════════════════

test('an advance is 200 with the STORED positions, and the row on disk says the same', async () => {
  const { conversationId, positions } = await conversationWithMessages(1);
  const position = positions[0]!;

  const response = await post(
    advancePath(conversationId),
    { conversationId, readThrough: position, sharedThrough: position },
    member.cookie,
  );

  expect(response.status).toBe(200);
  // Parsed through the protocol schema: the claim is that the server's answer is one
  // the protocol accepts, not that it matches a hand-copied literal.
  const parsed = receiptAdvanceResponse.parse(await response.json());
  expect(String(parsed.conversationId)).toBe(conversationId);
  expect(String(parsed.userId)).toBe(member.userId);
  expect(String(parsed.readThrough)).toBe(position);
  expect(String(parsed.sharedThrough)).toBe(position);
  // A bigint is a DECIMAL STRING on the wire, never a number.
  expect(typeof parsed.readThrough).toBe('string');

  const stored = await storedReceiptRow(conversationId, member.userId);
  expect(stored!.read_through).toBe(position);
  expect(stored!.shared_through).toBe(position);
  // The column default, because an advance cannot set the flag (ADR 0058).
  expect(stored!.sharing).toBe(true);
});

test('out-of-order advances over HTTP never regress, and the answer is the stored value', async () => {
  // Gate G2 at the boundary a client actually uses: a debounced advance flushed out
  // of order, then a retry. The second response reports the STORED position, not the
  // one that was sent — a client that took the response at its word and kept its own
  // watermark would render every later `Seen` wrong.
  const { conversationId, positions } = await conversationWithMessages(3);
  const [first, , last] = positions as [Seq, Seq, Seq];

  await post(advancePath(conversationId), { conversationId, readThrough: last, sharedThrough: last }, member.cookie);

  const outOfOrder = await post(
    advancePath(conversationId),
    { conversationId, readThrough: first, sharedThrough: first },
    member.cookie,
  );
  expect(outOfOrder.status).toBe(200);
  const refused = receiptAdvanceResponse.parse(await outOfOrder.json());
  expect(String(refused.readThrough)).toBe(last);
  expect(String(refused.sharedThrough)).toBe(last);

  expect((await storedReceiptRow(conversationId, member.userId))!.read_through).toBe(last);
  expect((await storedReceiptRow(conversationId, member.userId))!.shared_through).toBe(last);

  // A duplicate is accepted and changes nothing.
  const retry = await post(
    advancePath(conversationId),
    { conversationId, readThrough: last, sharedThrough: last },
    member.cookie,
  );
  expect(retry.status).toBe(200);
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM receipt WHERE conversation_id = ${conversationId}`;
  expect(rows[0]!.n).toBe('1');
});

test('sharing off, over HTTP: read_through advances and shared_through does not, and turning it back on moves nothing', async () => {
  // The whole privacy story across three requests and a real session — the reason the
  // second column exists. Read privately with sharing off; the sender's view of how
  // far you got does not move; turning sharing back on does not snap it forward to
  // where you actually are.
  const { conversationId, positions } = await conversationWithMessages(3);
  const [first, second, last] = positions as [Seq, Seq, Seq];
  expect(last > second && second > first).toBe(true);

  const opened = await post(
    advancePath(conversationId),
    { conversationId, readThrough: first, sharedThrough: first },
    member.cookie,
  );
  expect(String(receiptAdvanceResponse.parse(await opened.json()).sharedThrough)).toBe(first);

  const off = await post(sharingPath(conversationId), { conversationId, sharing: false }, member.cookie);
  expect(off.status).toBe(200);
  // The answer carries the FLAG and no position, so a client cannot mistake a
  // settings write for an advance.
  const offBody = receiptSharingResponse.parse(await off.json());
  expect(offBody.sharing).toBe(false);
  expect('readThrough' in offBody).toBe(false);
  expect('sharedThrough' in offBody).toBe(false);

  const readPrivately = await post(
    advancePath(conversationId),
    { conversationId, readThrough: last, sharedThrough: last },
    member.cookie,
  );
  const hidden = receiptAdvanceResponse.parse(await readPrivately.json());
  expect(String(hidden.readThrough)).toBe(last);
  // Frozen where it was, not at zero: the first message was disclosed before the
  // control was turned off.
  expect(String(hidden.sharedThrough)).toBe(first);
  expect(String(hidden.sharedThrough)).not.toBe(second);

  const stored = await storedReceiptRow(conversationId, member.userId);
  expect(stored!.read_through).toBe(last);
  expect(stored!.shared_through).toBe(first);

  // Back on. The flag moves; both positions stay exactly where they were — no
  // discontinuity and no leak on the re-enable itself.
  const on = await post(sharingPath(conversationId), { conversationId, sharing: true }, member.cookie);
  expect(receiptSharingResponse.parse(await on.json()).sharing).toBe(true);
  const afterEnable = await storedReceiptRow(conversationId, member.userId);
  expect(afterEnable!.sharing).toBe(true);
  expect(afterEnable!.read_through).toBe(last);
  expect(afterEnable!.shared_through).toBe(first);

  // And the next advance resumes forward from the frozen value rather than jumping.
  const resumed = await post(
    advancePath(conversationId),
    { conversationId, readThrough: last, sharedThrough: last },
    member.cookie,
  );
  expect(String(receiptAdvanceResponse.parse(await resumed.json()).sharedThrough)).toBe(last);
});

test('a delivery ack is 200 with the stored position, out of order, and carries no device', async () => {
  const { conversationId, positions } = await conversationWithMessages(2);
  const [first, last] = positions as [Seq, Seq];

  await post(ackPath(conversationId), { conversationId, deliveredThrough: last }, member.cookie);
  const stale = await post(ackPath(conversationId), { conversationId, deliveredThrough: first }, member.cookie);

  expect(stale.status).toBe(200);
  const parsed = deliveryAckResponse.parse(await stale.json());
  expect(String(parsed.deliveredThrough)).toBe(last);
  expect('deviceId' in parsed).toBe(false);

  const rows = await sql<{ delivered_through: string }[]>`
    SELECT delivered_through::text AS delivered_through FROM delivery WHERE conversation_id = ${conversationId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.delivered_through).toBe(last);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The refusal that matters
// ═══════════════════════════════════════════════════════════════════════════════

test('a watermark for a conversation the caller is not in is 403 on all three paths, and writes nothing', async () => {
  // The security case, at the boundary. A stranger who could write a receipt into
  // somebody else's conversation would learn how far those members have read in a
  // conversation they were never shown.
  const elsewhere = await conversationWithoutMember();

  const advanced = await post(
    advancePath(elsewhere),
    { conversationId: elsewhere, readThrough: '10', sharedThrough: '10' },
    member.cookie,
  );
  expect(advanced.status).toBe(403);
  const envelope = errorEnvelope.parse(await advanced.json());
  expect(envelope.error.code).toBe('notAMember');
  // Being added is something that happens without the caller doing anything, so these
  // identical bytes could plausibly succeed later.
  expect(envelope.error.retryable).toBe(true);

  const shared = await post(sharingPath(elsewhere), { conversationId: elsewhere, sharing: false }, member.cookie);
  expect(shared.status).toBe(403);
  expect(errorEnvelope.parse(await shared.json()).error.code).toBe('notAMember');

  const acked = await post(ackPath(elsewhere), { conversationId: elsewhere, deliveredThrough: '10' }, member.cookie);
  expect(acked.status).toBe(403);
  expect(errorEnvelope.parse(await acked.json()).error.code).toBe('notAMember');

  // Nothing, anywhere it would have been a leak. Scoped to THIS conversation because
  // this file does not truncate between tests (see the sign-up note) — and it counts
  // every member's rows, not just this caller's, because a refusal must not write on
  // anybody's behalf.
  const rows = await sql<{ receipts: string; deliveries: string }[]>`
    SELECT (SELECT count(*)::text FROM receipt WHERE conversation_id = ${elsewhere}) AS receipts,
           (SELECT count(*)::text FROM delivery WHERE conversation_id = ${elsewhere}) AS deliveries`;
  expect(rows[0]!.receipts).toBe('0');
  expect(rows[0]!.deliveries).toBe('0');
  expect(await storedReceiptRow(elsewhere, member.userId)).toBeNull();
});

test('the path and the body must name the same conversation, and the method must be POST', async () => {
  const mine = await conversationWithMessages(1);
  const elsewhere = await conversationWithMessages(1);

  const mismatch = await post(
    advancePath(elsewhere.conversationId),
    { conversationId: mine.conversationId, readThrough: '1', sharedThrough: '1' },
    member.cookie,
  );
  expect(mismatch.status).toBe(400);
  const envelope = errorEnvelope.parse(await mismatch.json());
  if (envelope.error.code !== 'invalidRequest') throw new Error('unreachable');
  expect(envelope.error.fields?.map((field) => field.path)).toEqual(['conversationId']);
  expect(await storedReceiptRow(elsewhere.conversationId, member.userId)).toBeNull();

  // An uppercase spelling of the conversation is the same conversation (ADR 0056).
  const uppercased = await post(
    advancePath(conversationIdScalar.parse(mine.conversationId).toUpperCase()),
    { conversationId: mine.conversationId, readThrough: '1', sharedThrough: '1' },
    member.cookie,
  );
  expect(uppercased.status).toBe(200);

  const wrongMethod = await fetch(`${origin}${advancePath(mine.conversationId)}`, {
    headers: { cookie: member.cookie },
  });
  expect(wrongMethod.status).toBe(405);
  expect(errorEnvelope.parse(await wrongMethod.json()).error.code).toBe('methodNotAllowed');
});

test('a position the database cannot store exactly is a 400, not a 500 and not a rounded row', async () => {
  // `Number('9007199254740993')` is `9007199254740992`, silently. A watermark stored
  // one position behind renders as a message that never turns blue, and nothing
  // afterwards can tell it from a correct one — so the boundary refuses it instead.
  const { conversationId } = await conversationWithMessages(1);

  const response = await post(
    advancePath(conversationId),
    { conversationId, readThrough: '9007199254740993', sharedThrough: '1' },
    member.cookie,
  );

  expect(response.status).toBe(400);
  const envelope = errorEnvelope.parse(await response.json());
  if (envelope.error.code !== 'invalidRequest') throw new Error('unreachable');
  expect(envelope.error.fields?.map((field) => field.path)).toEqual(['readThrough']);
  expect(await storedReceiptRow(conversationId, member.userId)).toBeNull();
});

test('a body that is not JSON, and a path that is not a conversation, are 400 and 404', async () => {
  const { conversationId } = await conversationWithMessages(0);

  const notJson = await fetch(`${origin}${advancePath(conversationId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member.cookie },
    body: 'not json at all',
  });
  expect(notJson.status).toBe(400);
  expect(errorEnvelope.parse(await notJson.json()).error.code).toBe('invalidRequest');

  const stranger = await fetch(`${origin}${advancePath('not-a-uuid')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member.cookie },
    body: JSON.stringify({ conversationId, readThrough: '1', sharedThrough: '1' }),
  });
  expect(stranger.status).toBe(404);
  expect(errorEnvelope.parse(await stranger.json()).error.code).toBe('notFound');
});

test('the request schemas and the endpoints agree on what these writes are', async () => {
  // A cheap consistency check, and the kind that rots: the bodies above are built by
  // hand, so this asserts the hand-built shapes are the ones the routes accept.
  const { conversationId, positions } = await conversationWithMessages(1);
  const position = positions[0]!;

  const send = sendMessageRequest.parse({
    conversationId,
    id: newMessageId(),
    body: 'a message to have something to acknowledge',
    attachments: [],
  });
  expect(send.conversationId).toBe(conversationId);

  const advanced = await post(
    advancePath(conversationId),
    { conversationId, readThrough: position, sharedThrough: position },
    member.cookie,
  );
  expect(advanced.status).toBe(200);
  expect(receiptAdvanceResponse.safeParse(await advanced.json()).success).toBe(true);

  const acked = await post(ackPath(conversationId), { conversationId, deliveredThrough: position }, member.cookie);
  expect(acked.status).toBe(200);
  expect(deliveryAckResponse.safeParse(await acked.json()).success).toBe(true);
});

afterAll(() => {
  server.stop(true);
  // Deliberately NOT `testDb.stop()` — the fixture is a process-lifetime singleton
  // shared by every test file in the run.
});