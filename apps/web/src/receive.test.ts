/**
 * **Gate G3 — one receive write path.** The gate that rots.
 *
 * `message-lifecycle.md` §8: *"One write path, no exceptions. The same function
 * writes a message whether it arrived live over the socket, came back from
 * catch-up pagination, or is the sender's own message echoing home with the
 * position it was missing."* And on why: *"A frame carrying your own message is
 * the normal case, not the edge case — so code that treats it as an insert
 * duplicates the message in the transcript. And it is invisible until someone
 * sends from two tabs."*
 *
 * Three properties, and each one is proved by breaking it and watching it fail:
 *
 *   1. an own-echo arriving TWICE must not create a second row;
 *   2. a frame arriving for a row whose `seq` is already set must not overwrite it;
 *   3. a live frame and a catch-up row for the same message converge on ONE row.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import { message as messageSchema, seq as seqScalar, type ConversationId, type Message, type UserId } from '@vartalap/protocol';
import { catchUp } from './catch-up.ts';
import { FakeTransport } from './fake-transport.ts';
import { receiveFrame } from './live.ts';
import { mintMessageId } from './message-id.ts';
import { queueSend, flushQueue } from './send.ts';
import { createStore, type MessageRow, type MessageStore } from './store.ts';

const CONVERSATION = '2b1c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' as ConversationId;
const PEER = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e' as UserId;
const ME = '4d3e5f60-7182-4a9d-a0e1-2b3c4d5e6f70' as UserId;

const ALLOWED = { allowed: true } as const;

/** `Seq` is branded; this is the protocol tests' own one-liner for comparing to one. */
const S = (value: string) => seqScalar.parse(value);

let databases = 0;
/** A store nobody else has touched — the "brand-new browser" every test starts from. */
async function freshStore(): Promise<MessageStore> {
  databases += 1;
  return createStore(`vartalap-g3-${databases}`).open();
}

/** The optimistic write, run through the real send path rather than around it. */
async function queue(store: MessageStore, body: string, now: number): Promise<string> {
  const outcome = await queueSend({
    store,
    conversationId: CONVERSATION,
    authorId: ME,
    permission: ALLOWED,
    text: body,
    now,
  });
  if (outcome.kind !== 'queued') throw new Error(`the send was refused: ${outcome.reason}`);
  return outcome.id;
}

/** A `message.created` frame carrying a row, as the relay would publish it. */
function createdFrame(row: MessageRow): Message {
  return messageSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    authorId: row.authorId,
    body: row.body,
    attachments: row.attachments,
    seq: row.seq,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

const rowsOf = async (store: MessageStore): Promise<MessageRow[]> => store.rowsFor(String(CONVERSATION));

// ═══════════════════════════════════════════════════════════════════════════

describe('G3 — an own-echo updates the optimistic row and never inserts a second one', () => {
  test('the same echo, delivered twice, leaves exactly one row', async () => {
    const store = await freshStore();
    const id = await queue(store, 'on my way', 1_760_000_000_000);

    // The optimistic row exists before anything has been sent.
    const before = await rowsOf(store);
    expect(before).toHaveLength(1);
    expect(before[0]?.seq).toBeNull();
    expect(before[0]?.state).toBe('queued');

    // The relay publishes the message back to the sender's own client. That is the
    // NORMAL case, not an edge case.
    const frame = createdFrame({ ...(before[0] as MessageRow), seq: seqScalar.parse('9001') });
    expect((await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: frame })).kind).toBe('message');

    // …and it is published twice, because the relay is at-least-once ON PURPOSE
    // (ADR 0057) and a duplicate publish has to be harmless.
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: frame });

    const after = await rowsOf(store);
    expect(after).toHaveLength(1);
    // And the update landed on the SAME row: it has a position and has left the
    // send queue. An insert would have left two rows, or left this one queued.
    expect(after[0]?.id).toBe(id);
    expect(after[0]?.seq).toBe(S('9001'));
    expect(after[0]?.state).toBeNull();
    expect(await store.queuedSends()).toHaveLength(0);
  });

  test('an echo for a row this browser does not hold inserts it, once', async () => {
    // The other half of "upsert on the client id": a message from somebody else has
    // no optimistic row, and the insert branch is where it starts.
    const store = await freshStore();
    const message = messageSchema.parse({
      id: mintMessageId(1_760_000_000_000),
      conversationId: CONVERSATION,
      authorId: PEER,
      body: 'from Priya',
      attachments: [],
      seq: '41',
      createdAt: '2026-10-15T09:00:00.000Z',
    });
    const frame = { type: 'message.created', conversationId: CONVERSATION, message } as const;

    await receiveFrame(store, frame);
    await receiveFrame(store, frame);

    const rows = await rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authorId).toBe(String(PEER));
    expect(rows[0]?.seq).toBe(S('41'));
  });

  test('an id already held is never a second row, whatever the position it carries', async () => {
    const store = await freshStore();
    const id = await queue(store, 'hello', 1_760_000_000_000);
    const held = (await rowsOf(store))[0] as MessageRow;

    // Same id, a DIFFERENT position. The server does not do this — `seq` is its
    // primary key — so the client must not end up believing it either.
    const frame = createdFrame({ ...held, seq: seqScalar.parse('77') });
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: frame });
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: frame });

    const rows = await rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.seq).toBe(S('77'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('G3 — a received frame never overwrites a position that is already set', () => {
  test('a frame for a positioned row changes nothing at all', async () => {
    const store = await freshStore();
    const id = await queue(store, 'first', 1_760_000_000_000);
    const held = (await rowsOf(store))[0] as MessageRow;

    await receiveFrame(store, {
      type: 'message.created',
      conversationId: CONVERSATION,
      message: createdFrame({ ...held, seq: seqScalar.parse('500') }),
    });
    expect((await store.messageById(id))?.seq).toBe(S('500'));

    // A second frame for the same row, carrying a position the server could never
    // have assigned. The guarantee is "if and only if it is currently null", and
    // there is no "unless it looks newer" clause.
    await receiveFrame(store, {
      type: 'message.created',
      conversationId: CONVERSATION,
      message: createdFrame({ ...held, seq: seqScalar.parse('400') }),
    });

    const row = await store.messageById(id);
    expect(row?.seq).toBe(S('500'));
  });

  test('a frame never rewrites what somebody wrote', async () => {
    // An update writes `seq` and `state`. Nothing else. Editing is out of v1 and
    // nothing arriving over the wire may change the content of a message.
    const store = await freshStore();
    const id = await queue(store, 'what I actually typed', 1_760_000_000_000);
    const held = (await rowsOf(store))[0] as MessageRow;

    const tampered = messageSchema.parse({
      ...createdFrame({ ...held, seq: seqScalar.parse('500') }),
      body: 'what you would like it to say',
    });
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: tampered });

    expect((await store.messageById(id))?.body).toBe('what I actually typed');
  });

  test('two client ids claiming one position: the second is refused, and says so', async () => {
    // `seq` is the server's PRIMARY KEY, so this is a transport or server bug. The
    // client's correct answer is to refuse the row and leave the gap visible —
    // which is what lets the `COUNT(*)` net find it — rather than write two
    // messages onto one ordering.
    const store = await freshStore();
    const mine = messageSchema.parse({
      id: mintMessageId(1_760_000_001_000),
      conversationId: CONVERSATION,
      authorId: ME,
      body: 'mine',
      attachments: [],
      seq: '9000',
      createdAt: '2026-10-15T09:00:00.000Z',
    });
    expect(await store.applyReceived(mine)).toEqual({ persisted: true });

    const impostor = messageSchema.parse({ ...mine, id: mintMessageId(1_760_000_002_000), body: 'not mine' });
    expect(await store.applyReceived(impostor)).toEqual({
      persisted: false,
      reason: 'seqClaimedByAnotherMessage',
    });

    const rows = await rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('mine');
  });

  test('a frame with no position is refused: it is not something to store', async () => {
    const store = await freshStore();
    const unpositioned = messageSchema.parse({
      id: mintMessageId(1_760_000_003_000),
      conversationId: CONVERSATION,
      authorId: PEER,
      body: 'no position',
      attachments: [],
      seq: null,
      createdAt: '2026-10-15T09:00:00.000Z',
    });
    expect(await store.applyReceived(unpositioned)).toEqual({ persisted: false, reason: 'notServerPositioned' });
    expect(await rowsOf(store)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('G3 — a live frame and a catch-up row converge on one row', () => {
  const seedThree = (): FakeTransport =>
    new FakeTransport({ authorId: String(ME) }).seed([
      { id: mintMessageId(1_760_000_010_000), conversationId: CONVERSATION, authorId: String(PEER), body: 'one', seq: 1 },
      { id: mintMessageId(1_760_000_011_000), conversationId: CONVERSATION, authorId: String(PEER), body: 'two', seq: 2 },
      { id: mintMessageId(1_760_000_012_000), conversationId: CONVERSATION, authorId: String(PEER), body: 'three', seq: 3 },
    ]);

  test('the socket wins the race for one message and catch-up delivers all three', async () => {
    // Not a coincidence of this test: it is every reconnect. A client catches up to
    // a position, the socket reconnects, and the relay re-publishes what it thinks
    // nobody has (ADR 0057 is at-least-once on purpose).
    const transport = seedThree();
    const store = await freshStore();

    const live = transport.messageAt(2);
    if (live === undefined) throw new Error('the seed did not land at position 2');
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: live });

    const result = await catchUp(store, transport);

    expect(result.caughtUp).toBe(true);
    const rows = await rowsOf(store);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.seq).sort()).toEqual([S('1'), S('2'), S('3')]);
    // Message 2 came by both routes and is one row, written once.
    expect(rows.filter((row) => row.seq === '2')).toHaveLength(1);
  });

  test('catch-up first, then the same message live: still one row', async () => {
    const transport = seedThree();
    const store = await freshStore();

    expect((await catchUp(store, transport)).caughtUp).toBe(true);
    const live = transport.messageAt(2);
    if (live === undefined) throw new Error('the seed did not land at position 2');
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: live });

    expect(await rowsOf(store)).toHaveLength(3);
  });

  test('a send response and the echo that follows it are one row', async () => {
    // The third call site. ADR 0059's middle row is why it exists at all: a retry
    // the server recognises answers `200` with the ORIGINAL row and its position,
    // and then the relay publishes it. Two routes, one message, and the member
    // must not see it twice.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) });
    const id = await queue(store, 'one row only', 1_760_000_020_000);

    const flushed = await flushQueue(store, transport, { now: () => 1_760_000_020_500 });
    expect(flushed.accepted).toEqual([id]);

    const accepted = transport.messageAt(1);
    if (accepted === undefined) throw new Error('the send was not accepted');
    await receiveFrame(store, { type: 'message.created', conversationId: CONVERSATION, message: accepted });

    const rows = await rowsOf(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.seq).toBe(S('1'));
    expect(await store.queuedSends()).toHaveLength(0);
  });
});

describe('a `delivery.acked` frame records the member\u2019s watermark, monotone', () => {
  test('the frame is stored and readable, keyed by member', async () => {
    const store = await freshStore();
    const outcome = await receiveFrame(store, {
      type: 'delivery.acked',
      conversationId: CONVERSATION,
      userId: PEER,
      seq: S('4'),
    });
    expect(outcome).toEqual({ kind: 'delivery' });
    expect(await store.deliveryFor(String(CONVERSATION), String(PEER))).toEqual({
      conversationId: String(CONVERSATION),
      userId: String(PEER),
      deliveredThrough: S('4'),
    });
  });

  test('a lower re-report does not regress the stored watermark', async () => {
    // The client half of the server's `GREATEST`: out-of-order arrival and two
    // tabs racing are real, and a local copy that went backwards would render a
    // `Sent` that un-sends.
    const store = await freshStore();
    const frame = (seq: string) => ({
      type: 'delivery.acked' as const,
      conversationId: CONVERSATION,
      userId: PEER,
      seq: S(seq),
    });
    await receiveFrame(store, frame('4'));
    await receiveFrame(store, frame('2'));
    expect((await store.deliveryFor(String(CONVERSATION), String(PEER)))?.deliveredThrough).toBe(S('4'));
  });

  test('two members are tracked independently', async () => {
    const store = await freshStore();
    await receiveFrame(store, { type: 'delivery.acked', conversationId: CONVERSATION, userId: PEER, seq: S('4') });
    await receiveFrame(store, { type: 'delivery.acked', conversationId: CONVERSATION, userId: ME, seq: S('2') });
    expect((await store.deliveryFor(String(CONVERSATION), String(PEER)))?.deliveredThrough).toBe(S('4'));
    expect((await store.deliveryFor(String(CONVERSATION), String(ME)))?.deliveredThrough).toBe(S('2'));
  });
});