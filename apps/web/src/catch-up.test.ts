/**
 * **Gate G4, client half — the catch-up loop, the cursor, and `COUNT(*)`
 * reconciliation.**
 *
 * ADR 0005 pairs the one line of advisory lock with an independent net underneath
 * it, and says the net is there *because* the lock is fragile. This file is that
 * net.
 *
 * The two halves, and both are proved by breaking them below:
 *
 *   - **the cursor advances only past rows that actually persisted.** A row this
 *     client refused to record must leave the cursor BELOW it, or the gap becomes
 *     silent and permanent (`message-lifecycle.md` §10).
 *   - **a permanently skipped row is detected by `COUNT(*)` and recovered.**
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import {
  PAGE_SIZE,
  catchUpPage as catchUpPageSchema,
  historyPage as historyPageSchema,
  message as messageSchema,
  seq as seqScalar,
  type ConversationId,
  type UserId,
} from '@vartalap/protocol';
import { catchUp, reconcileConversation } from './catch-up.ts';
import { FakeTransport, type SeedMessage } from './fake-transport.ts';
import { mintMessageId } from './message-id.ts';
import { createStore, type MessageStore } from './store.ts';
import type { Transport } from './transport.ts';

const CONVERSATION = '2b1c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' as ConversationId;
const OTHER = '5e4f6071-8293-4b0d-8e1f-2a3b4c5d6e7f' as ConversationId;
const PEER = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e' as UserId;
const ME = '4d3e5f60-7182-4a9d-a0e1-2b3c4d5e6f70' as UserId;

/**
 * `Seq` is branded and `expect().toBe()` is typed against the brand, so a raw string
 * would not compile — which is the brand doing its job. The protocol's own tests use
 * the same one-liner.
 */
const S = (value: string) => seqScalar.parse(value);

let databases = 0;
async function freshStore(): Promise<MessageStore> {
  databases += 1;
  return createStore(`vartalap-g4-${databases}`).open();
}

/** `count` messages in one conversation, at positions `from` upwards. */
function conversation(count: number, from = 1, conversationId: string = String(CONVERSATION)): SeedMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: mintMessageId(1_760_000_000_000 + index),
    conversationId,
    authorId: String(PEER),
    body: `message ${from + index}`,
    seq: from + index,
  }));
}

const held = (store: MessageStore, conversationId = String(CONVERSATION)): Promise<string[]> =>
  store.rowsFor(conversationId).then((rows) => rows.map((row) => row.body).sort());

// ═══════════════════════════════════════════════════════════════════════════

describe('G4 — the cursor', () => {
  test('a brand-new browser has no cursor, and `0` means everything', async () => {
    // `catchUpQuery.after` is REQUIRED, so "no cursor" cannot be expressed as a
    // missing parameter — and `0` is a real position that sits before the first
    // message, because `seq` starts at 1 (ADR 0045).
    const store = await freshStore();
    expect(await store.cursor()).toBe(S('0'));

    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(3));
    await catchUp(store, transport);

    expect(transport.catchUpQueries[0]?.after).toBe(S('0'));
    expect(await held(store)).toHaveLength(3);
  });

  test('the loop ends on a short page, and not one request later than it has to', async () => {
    // Fifty rows is a screen and a half of a busy conversation (ADR 0005).
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(120));

    const result = await catchUp(store, transport);

    expect(result.caughtUp).toBe(true);
    expect(result.pages).toBe(3); // 50 + 50 + 20
    expect(await held(store)).toHaveLength(120);
    // The three requests walked the keyset: 0, then the last position of the page
    // before it. `OFFSET` is never used anywhere, and this is what proves it.
    expect(transport.catchUpQueries.map((query) => String(query.after))).toEqual(['0', '50', '100']);
    expect(transport.catchUpQueries.every((query) => query.limit === PAGE_SIZE)).toBe(true);
  });

  test('one cursor for the whole account, not one per conversation', async () => {
    // `seq` is a SINGLE GLOBAL column, which is the entire payoff: positions
    // compare across conversations, so reconnect is one query rather than one per
    // conversation. A per-conversation cursor is the design ADR 0005 replaced.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed([
      ...conversation(2, 1),
      ...conversation(2, 3, String(OTHER)),
    ]);

    const result = await catchUp(store, transport);

    expect(result.caughtUp).toBe(true);
    expect(result.pages).toBe(1);
    expect(transport.catchUpQueries).toHaveLength(1);
    expect(result.cursor).toBe(S('4'));
    expect(await store.conversationsWithPositionedRows()).toHaveLength(2);
  });

  test('a second catch-up asks from where the first one stopped', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(2));
    await catchUp(store, transport);

    transport.seed(conversation(3, 3));
    const second = await catchUp(store, transport);

    expect(second.caughtUp).toBe(true);
    expect(second.cursor).toBe(S('5'));
    expect(transport.catchUpQueries[1]?.after).toBe(S('2'));
    expect(await held(store)).toHaveLength(5);
  });

  test('the cursor never moves backwards, whatever a caller asks for', async () => {
    // Two tabs in one browser profile share one Dexie, and a slower tab must not be
    // able to pull the cursor back under the faster one.
    const store = await freshStore();
    await store.moveCursorTo(seqScalar.parse('500'));
    expect(await store.moveCursorTo(seqScalar.parse('499'))).toBe(S('500'));
    expect(await store.cursor()).toBe(S('500'));
    expect(await store.moveCursorTo(seqScalar.parse('501'))).toBe(S('501'));
  });

  test('a row this client refuses STOPS the cursor at the hole', async () => {
    // The guarantee is the LONGEST CONTIGUOUS PREFIX of persisted rows, not "the
    // last row on the page". Advancing past a page whose second row was refused
    // would swallow the rest — which were written, so nobody would notice, and the
    // refused one, which was not.
    //
    // The refusal is a position two client ids already claim, which means the
    // transport or the server is wrong; the client's correct answer is to decline
    // the row and leave the gap reachable.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5));

    // Position 2 is already held here, under a DIFFERENT id — as it would be after
    // a corrupted write or a relay that re-keyed a frame.
    const squatter = messageSchema.parse({
      id: mintMessageId(1_760_000_900_000),
      conversationId: CONVERSATION,
      authorId: PEER,
      body: 'position 2, other id',
      attachments: [],
      seq: '2',
      createdAt: '2026-10-15T09:00:00.000Z',
    });
    expect(await store.applyReceived(squatter)).toEqual({ persisted: true });

    const result = await catchUp(store, transport);

    expect(result.caughtUp).toBe(false);
    expect(result.stoppedAt?.reason).toBe('seqClaimedByAnotherMessage');
    // The cursor is BELOW the hole. Positions 3, 4 and 5 were never processed, so
    // the next catch-up is offered them again rather than inheriting them as
    // delivered-and-forgotten.
    expect(result.cursor).toBe(S('1'));
    expect(await held(store)).toEqual(['message 1', 'position 2, other id']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('G4 — COUNT(*) reconciliation', () => {
  test('a permanently skipped row makes TWO NUMBERS disagree, and nothing else would say', async () => {
    // The bug this net exists for, stated as the detector. The relay drops message
    // 3 of 5 on its way to this client; the pages around it arrive normally, the
    // cursor sails past, and the transcript looks complete.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5));

    // Catch-up, minus the dropped row — the four that did arrive.
    const page = await transport.catchUp({ after: S('0'), limit: PAGE_SIZE });
    for (const message of [...page.messages.slice(0, 2), ...page.messages.slice(3)]) {
      await store.applyReceived(message);
    }

    // ⚠️ This is the detector, and it is a COMPARISON rather than an anomaly score.
    // Span-versus-count is unsound (ADR 0005): a rolled-back transaction burns its
    // sequence value, so a conversation's messages can legitimately be 1, 2, 4, 5
    // with nothing at all wrong — which is exactly the state this client is in.
    const authoritative = await transport.history({ conversationId: CONVERSATION, limit: PAGE_SIZE });
    const heldNow = await store.positionedCount(String(CONVERSATION));
    expect(heldNow).toBe(4);
    expect(authoritative.totalCount).toBe(5);
    expect(heldNow).not.toBe(authoritative.totalCount);
  });

  test('…and the RECOVERY finds it, from the lowest seq this browser holds', async () => {
    // `history` is a different query on the server and it serves the row the
    // catch-up query dropped. That is the entire difference between the fast path
    // and the net under it.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5)).gap(3);

    const result = await catchUp(store, transport);

    // A recovery happened, which can only mean the two counts disagreed.
    expect(result.reconciled[0]?.agreed).toBe(true);
    expect(result.reconciled[0]?.rowsRecovered).toBe(1);
    expect(result.caughtUp).toBe(true);
    expect(await held(store)).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5']);
    // Nothing to shout about: the net fired, found the gap, and closed it.
    expect(await store.discrepancies()).toHaveLength(0);
  });

  test('the recovery starts at the FLOOR, not at the cursor', async () => {
    // Paging forward from where the client already has everything, rather than
    // from where its cursor is. The cursor is PAST the gap — that is what makes the
    // gap permanent — so a recovery that started there would find nothing.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5)).gap(3);
    await catchUp(store, transport);

    const recovery = transport.historyQueries.at(-1);
    expect(recovery?.after).toBe(S('1')); // the lowest position this browser holds
    expect(String(recovery?.conversationId)).toBe(String(CONVERSATION));
  });

  test('a queued send is not counted, so every send in flight is not a discrepancy', async () => {
    // `COUNT(*)` counts committed messages and nothing else. Counting the local
    // optimistic row would make the client's count one HIGHER than the server's
    // the moment anybody pressed send, and the net would cry wolf on the most
    // ordinary action in the product.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(3));
    await catchUp(store, transport);

    await store.applyLocalSend({
      id: mintMessageId(1_760_000_999_000),
      conversationId: String(CONVERSATION),
      authorId: String(ME),
      body: 'not on the server yet',
      attachments: [],
      createdAt: 1_760_000_999_000,
    });

    const report = await reconcileConversation(store, transport, String(CONVERSATION));
    expect(report.agreed).toBe(true);
    expect(report.held).toBe(3);
    expect(report.expected).toBe(3);
  });

  test('a gap BELOW the floor is RECORDED, not retried and not discarded', async () => {
    // A member added to a long conversation receives its older history through
    // `readHistory`, not through catch-up, so the forward recovery cannot walk
    // downwards to what is missing. This client is behind and will stay behind.
    //
    // Three things it must NOT do, and each is a refusal of a tempting
    // alternative: retry on a loop (a battery drain on the member's worst day),
    // discard (it does not know WHICH rows are wrong), or claim to be caught up.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5)).gap(1, 2, 3);

    const result = await catchUp(store, transport);

    expect(result.caughtUp).toBe(false);
    expect(result.reconciled[0]?.agreed).toBe(false);
    // `rowsRecovered: 0` is what distinguishes this from the gap the net CAN reach:
    // the recovery ran and there was nothing forward of the floor to find.
    expect(result.reconciled[0]?.rowsRecovered).toBe(0);

    // It records the discrepancy where a human can see it.
    const discrepancies = await store.discrepancies();
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]).toMatchObject({ conversationId: String(CONVERSATION), held: 2, expected: 5 });

    // And it keeps what it holds. Nothing was deleted.
    expect(await held(store)).toEqual(['message 4', 'message 5']);

    // One round, not a loop: the recovery made one attempt and stopped.
    const recoveries = transport.historyQueries.filter((query) => query.after !== undefined);
    expect(recoveries).toHaveLength(1);
  });

  test('a discrepancy stops shouting the moment the counts agree again', async () => {
    // A net that cries wolf is muted inside a week, and then it is not a net.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed(conversation(5));
    await catchUp(store, transport);

    // A gap opens up underneath this client — a version of the relay that drops a
    // page's worth of frames.
    await store.noteDiscrepancy({
      conversationId: String(CONVERSATION),
      held: 5,
      expected: 5,
      rowsRecovered: 0,
      notedAt: 0,
    });
    expect(await store.discrepancies()).toHaveLength(1);

    // It heals.
    expect((await catchUp(store, transport)).reconciled[0]?.agreed).toBe(true);
    expect(await store.discrepancies()).toHaveLength(0);
  });

  test('reconciliation runs for every conversation this browser holds a position in', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).seed([
      ...conversation(2, 1),
      ...conversation(3, 3, String(OTHER)),
    ]).gap(4);

    const result = await catchUp(store, transport);

    expect(result.reconciled.map((report) => report.conversationId).sort()).toEqual([
      String(CONVERSATION),
      String(OTHER),
    ]);
    // The healthy one agrees; the broken one was recovered from its floor of 3.
    const healthy = result.reconciled.find((report) => report.conversationId === String(CONVERSATION));
    const broken = result.reconciled.find((report) => report.conversationId === String(OTHER));
    expect(healthy?.agreed).toBe(true);
    expect(broken?.agreed).toBe(true);
    expect(broken?.rowsRecovered).toBe(1);
  });

  test('a page that cannot move the cursor stops the loop instead of spinning', async () => {
    // The server's `seq > after` keyset cannot produce this. It is here because a
    // loop that cannot terminate on a client's worst day is a battery drain nobody
    // can debug from a phone — so the guard is a test, not a hope.
    const store = await freshStore();
    const seeded = conversation(PAGE_SIZE);
    const page = seeded.map((seed) =>
      messageSchema.parse({
        id: seed.id,
        conversationId: CONVERSATION,
        authorId: PEER,
        body: seed.body,
        attachments: [],
        seq: String(seed.seq),
        createdAt: '2026-10-15T09:00:00.000Z',
      }),
    );
    // The cursor is already PAST this page, and the server's head is far above it:
    // so every row persists, the cursor does not move, and the page is full. That
    // is the state that must not become an infinite loop.
    await store.moveCursorTo(seqScalar.parse('100'));

    let asked = 0;
    const stubborn: Transport = {
      async sendMessage(): Promise<never> {
        throw new Error('this test never sends');
      },
      // Honest about the count, so reconciliation has nothing to complain about and
      // the only thing under test is the loop.
      async history() {
        return historyPageSchema.parse({ messages: [], latestSeq: '200', totalCount: PAGE_SIZE });
      },
      async catchUp() {
        asked += 1;
        return catchUpPageSchema.parse({ messages: page, latestSeq: '200' });
      },
    };

    const result = await catchUp(store, stubborn);

    expect(asked).toBe(1);
    expect(result.caughtUp).toBe(false);
    expect(result.stoppedAt?.reason).toBe('pageMadeNoProgress');
  });
});