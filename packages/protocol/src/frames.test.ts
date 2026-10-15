/**
 * The send request, the reconnect cursor, the two write-frame bodies, and the
 * split between a message's STORED state and what the interface renders for it.
 *
 * The through-line: each of these is a place where the schema used to be looser
 * than the decision it encodes. A send request that did not say which conversation
 * it belonged to, a reconnect with no cursor, a receipt frame with no REST
 * equivalent, and an enum that claimed to know whether a message had been read.
 * A schema that accepts anything is worse than no schema, so most of what follows
 * is the rejection half.
 *
 *     bun test packages/protocol
 */
import { describe, expect, test } from 'bun:test';
import {
  catchUpPage,
  catchUpQuery,
  deliveryAckRequest,
  historyQuery,
  PAGE_SIZE,
  receiptAdvanceRequest,
  sendMessageRequest,
  sendMessageResponse,
  serverFrame,
  clientFrame,
  type SendMessageRequest,
} from './frames.ts';
import {
  deriveRenderedMessageState,
  message,
  messageState,
  renderedMessageState,
} from './conversation.ts';
import { conversationId, messageId, seq, seqFromBigInt } from './scalars.ts';

/** A real UUIDv7 — `messageId` is branded on the format, so a fake would not parse. */
const MESSAGE_ID = '018f3b5e-9a1c-7c2e-8f4a-1b2c3d4e5f60';
/** A second one, for the same reason. The version nibble (position 15) must be 7. */
const MESSAGE_ID_2 = '3c2d4e5f-6071-7b8c-9d0e-1f2a3b4c5d6e';
/** A well-formed UUID that is NOT a v7. Used where a message id must be refused. */
const UUID_V4 = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e';
const CONVERSATION_ID = '2b1c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e';

const attachment = { mediaId: '4d3e5f60-7182-4c9d-a0e1-2a3b4c5d6e7f', variant: 'thumb', width: 80, height: 80 } as const;

/**
 * A branded position. `seq` is branded so a plain string cannot be passed where a
 * position belongs, and `expect().toBe()` is typed against the branded type — so
 * comparing to a raw string is a compile error, which is the brand doing its job
 * rather than an obstacle to it.
 */
const S = (value: string) => seq.parse(value);

/** Built through the schemas, so a fixture cannot drift from what the schema accepts. */
const VALID_BODY: SendMessageRequest = {
  conversationId: conversationId.parse(CONVERSATION_ID),
  id: messageId.parse(MESSAGE_ID),
  body: 'hello',
  attachments: [],
};

describe('the send request', () => {
  const valid = VALID_BODY;

  test('carries the conversation, like every other payload in the file', () => {
    // Ruling: `sendMessageRequest` is posted to
    // /api/conversations/{conversationId}/messages, and the body says so as well as
    // the path. The redundancy is the same insurance every frame carries.
    const parsed = sendMessageRequest.parse(valid);
    expect(parsed).toEqual(valid);
    expect(String(parsed.conversationId)).toBe(CONVERSATION_ID);
  });

  test('a body with no conversation is rejected rather than inferred from the path', () => {
    // If the body could omit it, the router would fill it in — and then a client
    // bug that sent a message to the wrong conversation would be invisible.
    expect(sendMessageRequest.safeParse({ id: MESSAGE_ID, body: 'hello', attachments: [] }).success).toBe(false);
  });

  test('the id is the identity AND the idempotency key, so it is not optional', () => {
    // One generated value doing two jobs (ADR 0004). A missing id means a server-
    // assigned one, which is a different system: it would make a retry land twice.
    expect(sendMessageRequest.safeParse({ ...valid, id: undefined }).success).toBe(false);
  });

  test('rejects an id that is not a UUIDv7 and a body over 8192 characters', () => {
    expect(sendMessageRequest.safeParse({ ...valid, id: 'not-a-uuid' }).success).toBe(false);
    expect(sendMessageRequest.safeParse({ ...valid, id: '018f3b5e-9a1c-7c2e-8f4a' }).success).toBe(false);
    // A well-formed UUID whose version nibble is not 7. `messageId` says "v7" in
    // its error message and in its brand, so a v4 has to be refused rather than
    // passed under a promise it does not keep.
    expect(sendMessageRequest.safeParse({ ...valid, id: UUID_V4 }).success).toBe(false);
    expect(sendMessageRequest.safeParse({ ...valid, body: 'x'.repeat(8193) }).success).toBe(false);

    // `attachments` is a list, never absent — `[]` means no attachments, and a
    // missing key means a client that is not on the version we think it is.
    expect(sendMessageRequest.safeParse({ ...valid, attachments: undefined }).success).toBe(false);
  });

  test('a client-supplied position is stripped, never honoured', () => {
    // The client can never set, influence or predict a `seq` (ADR 0004). Unknown
    // keys are stripped rather than rejected, so this has to be asserted: a schema
    // that passed `seq` through would let a client place its own message.
    const parsed = sendMessageRequest.parse({ ...valid, seq: '9', authorId: OTHER_ID });
    expect(parsed).toEqual(valid);
    expect('seq' in parsed).toBe(false);
    expect('authorId' in parsed).toBe(false);
  });

  test('the client clock is carried, and omitting it is a choice rather than an accident', () => {
    // `message.client_created_at` is `NOT NULL` with no default, and three
    // documents call it the CLIENT's clock (ADR 0005, `message-ordering.md`, and
    // trap 16 in the decisions index) — so the wire has to be able to carry it.
    //
    // Optional, and that is a compromise rather than a decision: a send that omits
    // it is not a `400`, it stores the server's stamp instead. What the schema
    // must NOT do is reject the field, because that would have made the column's
    // documented meaning unexpressible and pushed the server into inventing one.
    //
    // Display only and never a sort key (ADR 0005), so a clock an hour fast cannot
    // reorder a transcript. The wrong value is a message shown at the wrong time,
    // which is the property the column already accepts.
    const parsed = sendMessageRequest.parse({ ...valid, clientCreatedAt: '2026-10-15T09:30:00.000Z' });
    expect(parsed.clientCreatedAt).toBe('2026-10-15T09:30:00.000Z');

    // Absent stays absent — a defaulted `''` would be a lie the server would store.
    expect('clientCreatedAt' in sendMessageRequest.parse(valid)).toBe(false);

    // And it is a datetime, so nonsense is refused rather than written.
    expect(sendMessageRequest.safeParse({ ...valid, clientCreatedAt: 'yesterday' }).success).toBe(false);
    expect(sendMessageRequest.safeParse({ ...valid, clientCreatedAt: 1761000000000 }).success).toBe(false);
  });

  test('a media attachment parses, and one that has not been derived yet does not', () => {
    expect(sendMessageRequest.safeParse({ ...valid, attachments: [attachment] }).success).toBe(true);
    // ADR 0008: media is referenced only once the worker has flipped it to `ready`,
    // so a variant that is not one of the three derived sizes is not an attachment.
    expect(
      sendMessageRequest.safeParse({ ...valid, attachments: [{ ...attachment, variant: 'original' }] })
        .success,
    ).toBe(false);
  });

  test('the response says whether this was a retry, and a false is kept', () => {
    const row = message.parse({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      authorId: OTHER_ID,
      body: 'hello',
      attachments: [],
      seq: '41',
      createdAt: '2026-10-15T09:00:00.000Z',
    });

    expect(sendMessageResponse.parse({ message: row, deduplicated: true }).deduplicated).toBe(true);
    expect(sendMessageResponse.parse({ message: row, deduplicated: false }).deduplicated).toBe(false);
    // Absent is not "not deduplicated" — it is a response shape nobody agreed on.
    expect(sendMessageResponse.safeParse({ message: row }).success).toBe(false);
  });
});

describe('the reconnect cursor', () => {
  test('is required, and keyed on a global position', () => {
    const parsed = catchUpQuery.parse({ after: '0' });
    expect(parsed.after).toBe(S('0'));
    expect(parsed.limit).toBe(PAGE_SIZE);

    // No `after` is a client with nothing to catch up, which is a different request
    // (history) — and it would silently return the whole transcript.
    expect(catchUpQuery.safeParse({}).success).toBe(false);
    expect(catchUpQuery.safeParse({ after: undefined }).success).toBe(false);
  });

  test('rejects a position that is not a non-negative decimal string', () => {
    for (const after of ['-1', '1.5', 'abc', '', '1e3', ' 1', '+1', '01']) {
      expect(catchUpQuery.safeParse({ after }).success).toBe(false);
    }
    // A JS number would lose precision above 2^53 without error, so the type is a
    // string and a number is not quietly coerced into one.
    expect(catchUpQuery.safeParse({ after: 1 }).success).toBe(false);
  });

  test('the page size is a constant, on both queries, and it is bounded', () => {
    expect(PAGE_SIZE).toBe(50);
    expect(historyQuery.parse({ conversationId: CONVERSATION_ID }).limit).toBe(PAGE_SIZE);
    expect(catchUpQuery.parse({ after: '0' }).limit).toBe(PAGE_SIZE);

    expect(catchUpQuery.safeParse({ after: '0', limit: 0 }).success).toBe(false);
    expect(catchUpQuery.safeParse({ after: '0', limit: 101 }).success).toBe(false);
  });

  test('a page carries rows and the newest visible position, and no conversation', () => {
    // The page spans conversations — that is the whole reason `seq` is global — so
    // a per-conversation field would be a lie and a per-conversation `after` would
    // be the design ADR 0005 replaced.
    const page = catchUpPage.parse({
      messages: [
        {
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          authorId: OTHER_ID,
          body: 'one',
          attachments: [],
          seq: '90',
          createdAt: '2026-10-15T09:00:00.000Z',
        },
        {
          id: MESSAGE_ID_2,
          conversationId: OTHER_ID,
          authorId: MESSAGE_ID,
          body: 'two',
          attachments: [],
          seq: '91',
          createdAt: '2026-10-15T09:01:00.000Z',
        },
      ],
      latestSeq: '91',
    });

    expect(page.messages).toHaveLength(2);
    expect(page.messages.map((m) => String(m.conversationId))).toEqual([
      CONVERSATION_ID,
      OTHER_ID,
    ]);
    expect(page.latestSeq).toBe(S('91'));

    expect(catchUpPage.safeParse({ messages: [], latestSeq: '91', conversationId: CONVERSATION_ID }).success).toBe(true);
    expect(catchUpPage.safeParse({ messages: [] }).success).toBe(false);
  });
});

describe('the two write-frame request bodies', () => {
  test('delivery ack states an ABSOLUTE position, named for the column', () => {
    const parsed = deliveryAckRequest.parse({ conversationId: CONVERSATION_ID, deliveredThrough: '128' });
    expect(parsed.deliveredThrough).toBe(S('128'));

    // A delta would still parse here and would quietly break `GREATEST` in the
    // upsert, which is the failure ADR 0010 says would not fail loudly. There is no
    // runtime guard against that here and there cannot be; the comment is the guard.
    expect(deliveryAckRequest.safeParse({ conversationId: CONVERSATION_ID, deliveredThrough: 12 }).success).toBe(false);
    expect(deliveryAckRequest.safeParse({ conversationId: CONVERSATION_ID, deliveredThrough: '-1' }).success).toBe(false);
    expect(deliveryAckRequest.safeParse({ conversationId: CONVERSATION_ID }).success).toBe(false);
  });

  test('receipt advance states BOTH positions absolutely, and `sharing` is not one of them', () => {
    const parsed = receiptAdvanceRequest.parse({
      conversationId: CONVERSATION_ID,
      readThrough: '200',
      sharedThrough: '150',
    });
    // Frozen while sharing is off, resumed from the frozen value (ADR 0010). A
    // schema that accepted only one of them could not express "frozen", which is
    // the entire reason a second stored position exists.
    expect(parsed.readThrough).toBe(S('200'));
    expect(parsed.sharedThrough).toBe(S('150'));

    expect(
      receiptAdvanceRequest.safeParse({ conversationId: CONVERSATION_ID, readThrough: '200' }).success,
    ).toBe(false);
    // `sharing` is a settings change with its own transport (ADR 0022), not an advance.
    expect(
      receiptAdvanceRequest.safeParse({
        conversationId: CONVERSATION_ID,
        readThrough: '200',
        sharedThrough: '200',
        sharing: true,
      }).success,
    ).toBe(true);
  });

  test('the REST body carries what the socket frame carries, and neither carries a device', () => {
    // Any ONE device acknowledging is enough — "she has it somewhere" is the fact a
    // sender wants, and per-device delivery is unfixable by construction because a
    // powered-off device may never acknowledge (ADR 0004, `message-receipts.md`).
    expect(clientFrame.safeParse({ type: 'delivery.acked', conversationId: CONVERSATION_ID, seq: '5' }).success).toBe(true);
    expect(clientFrame.safeParse({ type: 'delivery.acked', conversationId: CONVERSATION_ID, seq: '5', deviceId: 'x' }).success).toBe(true);

    // And the frame a sender receives is per MEMBER, so it names who.
    expect(
      serverFrame.safeParse({ type: 'receipt.advanced', conversationId: CONVERSATION_ID, userId: OTHER_ID, readThrough: '7', sharedThrough: '7' })
        .success,
    ).toBe(true);
  });
});

describe('stored state versus rendered state', () => {
  test('the stored enum is the three states a row can know with no network', () => {
    expect(messageState.options).toEqual(['queued', 'inFlight', 'failed']);

    // The old enum's other three are all derived, and none of them is stored:
    // `sent` is `seq !== null`, and `delivered` / `read` are member watermarks.
    for (const derived of ['pending', 'sent', 'delivered', 'read']) {
      expect(messageState.safeParse(derived).success).toBe(false);
    }
  });

  test('the rendered enum is wider, and still carries no "seen"', () => {
    // Five sources, four renderings, one indicator (`composer-and-sending.md`).
    // "Seen" is interface copy: it appears in no schema, no protocol, no model.
    expect(renderedMessageState.options).toEqual([
      'queued',
      'inFlight',
      'sent',
      'delivered',
      'read',
      'failed',
    ]);
    for (const banned of ['seen', 'pending', 'seenAt', 'lastSeen']) {
      expect(renderedMessageState.safeParse(banned).success).toBe(false);
    }
  });

  const at = (position: string | null, delivered: string | null, read: string | null) => ({
    state: 'queued' as const,
    position: position === null ? null : seq.parse(position),
    deliveredThrough: delivered === null ? null : seq.parse(delivered),
    readThrough: read === null ? null : seq.parse(read),
  });

  test('no position means the row is still local, and an open request is distinguishable', () => {
    expect(deriveRenderedMessageState(at(null, null, null))).toBe('queued');
    expect(deriveRenderedMessageState({ ...at(null, null, null), state: 'inFlight' })).toBe('inFlight');
  });

  test('a position means committed, and the watermarks say how far it travelled', () => {
    expect(deriveRenderedMessageState(at('40', null, null))).toBe('sent');
    expect(deriveRenderedMessageState(at('40', '40', null))).toBe('delivered');
    expect(deriveRenderedMessageState(at('40', '40', '40'))).toBe('read');
  });

  test('a watermark at or past the position counts, and one short of it does not', () => {
    // `>=`, not `>`: a device that has persisted the frame has persisted THAT one.
    expect(deriveRenderedMessageState(at('40', '39', null))).toBe('sent');
    expect(deriveRenderedMessageState(at('40', '41', '40'))).toBe('read');
    // Read is checked FIRST, and the reason is that reading implies having: a
    // member who has read it has necessarily received it. `read_through >=
    // delivered_through` always holds (ADR 0004), so this pair is unreachable in
    // practice — and when it somehow arrives, "read" is the truthful rendering
    // rather than the one that second-guesses the receipt.
    expect(deriveRenderedMessageState(at('40', '39', '40'))).toBe('read');
  });

  test('positions past 2^53 compare correctly, which is the whole reason they are strings', () => {
    // If these were JS numbers, 41 and 40 at this magnitude would be the same value
    // and the comparison would silently pass. They are compared as bigints.
    const huge = seqFromBigInt(2n ** 60n);
    const justBelow = seqFromBigInt(2n ** 60n - 1n);

    expect(deriveRenderedMessageState({ state: 'queued', position: huge, deliveredThrough: justBelow, readThrough: null }))
      .toBe('sent');
    expect(deriveRenderedMessageState({ state: 'queued', position: huge, deliveredThrough: huge, readThrough: justBelow }))
      .toBe('delivered');
  });

  test('a failure outranks everything, including a position', () => {
    // A definitive rejection is terminal: no later frame changes it, and the row is
    // waiting on the member, not on the server.
    expect(deriveRenderedMessageState({ ...at('40', '40', '40'), state: 'failed' })).toBe('failed');
    expect(deriveRenderedMessageState({ ...at(null, null, null), state: 'failed' })).toBe('failed');
  });

  test('a row whose position arrived mid-flight renders as sent, not in flight', () => {
    // The server's answer is the truth. Reporting `inFlight` once the position is
    // known would be the protocol claiming a request is open when it has closed.
    expect(deriveRenderedMessageState({ ...at('40', null, null), state: 'inFlight' })).toBe('sent');
  });

  test('a positioned row stores NO state, and that is not a fourth state', () => {
    // ADR 0061. The stored enum is the set of things a browser can know before
    // the server answers; once a position exists there is nothing left to know
    // locally, and a row has to be able to say so without inventing a value.
    //
    // The alternative was a committed row carrying a stale `'queued'` — which
    // puts a message nobody should send back into the send queue, because the
    // send queue IS `messages where state = 'queued'`.
    expect(deriveRenderedMessageState({ ...at('40', null, null), state: null })).toBe('sent');
    expect(deriveRenderedMessageState({ ...at('40', '40', '40'), state: null })).toBe('read');

    // And the enum itself is unchanged: three values, none of which is `sent`.
    expect(messageState.options).toEqual(['queued', 'inFlight', 'failed']);
    expect(messageState.safeParse(null).success).toBe(false);
  });
});
