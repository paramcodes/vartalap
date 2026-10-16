/**
 * Drawing: transcript order, and what is read.
 *
 * No component lives here — stage 6 writes the surface. These are the two rules
 * that a component would otherwise re-decide, and the second one is the one the
 * ADR 0010 hazard exists for.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import { seq as seqScalar, seqFromBigInt, type ConversationId, type Message, type UserId } from '@vartalap/protocol';
import { mintMessageId } from './message-id.ts';
import { renderedStateOf, transcript } from './render.ts';
import { createStore, type MessageRow, type MessageStore } from './store.ts';

const CONVERSATION = '2b1c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' as ConversationId;
const ME = '4d3e5f60-7182-4a9d-a0e1-2b3c4d5e6f70' as UserId;
const PRIYA = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e' as UserId;
const SAM = '6f708192-a3b4-4c1e-9f2a-3b4c5d6e7f80' as UserId;

/** `Seq` is branded; this is the protocol tests' own one-liner for comparing to one. */
const S = (value: string) => seqScalar.parse(value);

let databases = 0;
async function freshStore(): Promise<MessageStore> {
  databases += 1;
  return createStore(`vartalap-render-${databases}`).open();
}

/** A stored row, with only the fields a test cares about stated out loud. */
function row(over: Partial<MessageRow> & Pick<MessageRow, 'seq' | 'createdAt'>): MessageRow {
  return {
    id: mintMessageId(over.createdAt),
    conversationId: String(CONVERSATION),
    authorId: String(ME),
    body: 'body',
    attachments: [],
    state: over.seq === null ? 'queued' : null,
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
    ...over,
  };
}

const bodies = (rows: readonly MessageRow[]): string[] => rows.map((each) => each.body);

// ═══════════════════════════════════════════════════════════════════════════

describe('the transcript never moves a message', () => {
  test('positioned rows come first, in seq order', () => {
    const sorted = transcript([
      row({ seq: seqScalar.parse('3'), createdAt: 1, body: 'three' }),
      row({ seq: seqScalar.parse('1'), createdAt: 3, body: 'one' }),
      row({ seq: seqScalar.parse('2'), createdAt: 2, body: 'two' }),
    ]);
    expect(bodies(sorted)).toEqual(['one', 'two', 'three']);
  });

  test('unpositioned rows sort AFTER everything positioned, by client time', () => {
    // `composer-and-sending.md` §2, verbatim: "unsent messages simply sort after
    // everything that has been positioned, ordered among themselves by client
    // creation time."
    //
    // The queued send has the EARLIEST client clock and still draws last, which is
    // the point: there is no provisional position to interpolate, and a message
    // that renders in one place and then visibly moves reads as a bug.
    const sorted = transcript([
      row({ seq: null, createdAt: 1, body: 'typed first, queued' }),
      row({ seq: seqScalar.parse('90'), createdAt: 50, body: 'positioned' }),
      row({ seq: null, createdAt: 2, body: 'typed second, queued' }),
    ]);
    expect(bodies(sorted)).toEqual(['positioned', 'typed first, queued', 'typed second, queued']);
  });

  test('two queued sends inside one millisecond keep the order they were typed in', () => {
    // The UUIDv7 tiebreak. The counter in `rand_a` is what makes two ids in the
    // same millisecond order correctly rather than arbitrarily.
    //
    // The clock is pinned AHEAD of the generator's own, because it holds its clock
    // forward and never backwards — a timestamp behind takes the backwards-clock
    // branch, which is correct and would make this test about the clock instead of
    // about the tiebreak.
    const millis = Math.max(Date.now(), 1_760_000_000_000) + 3_600_000;
    const first = mintMessageId(millis);
    const second = mintMessageId(millis);
    expect(first < second).toBe(true);

    const sorted = transcript([
      row({ id: second, seq: null, createdAt: 7, body: 'second' }),
      row({ id: first, seq: null, createdAt: 7, body: 'first' }),
    ]);
    expect(bodies(sorted)).toEqual(['first', 'second']);
  });

  test('positions above 2^53 order correctly, and a lexical index would not', () => {
    // `seq` is a decimal string here for the same reason it is on the wire, and the
    // sort is in JavaScript over bigints. An IndexedDB string index sorts
    // `'100' < '9'`, and that is why `store.ts` says the `seq` index is for
    // `equals()` lookups only and never for ORDER BY.
    const nine = seqScalar.parse('9');
    const hundred = seqScalar.parse('100');
    expect(bodies(transcript([row({ seq: hundred, createdAt: 1, body: 'hundred' }), row({ seq: nine, createdAt: 2, body: 'nine' })]))).toEqual([
      'nine',
      'hundred',
    ]);
    expect(hundred < nine).toBe(true); // …and the string comparison is what would not

    // Past 2^53 a JavaScript number cannot even hold the two values apart, so this
    // is the case where a number-keyed store would not merely misorder but lose a
    // position entirely.
    const huge = seqFromBigInt(2n ** 60n);
    const justBelow = seqFromBigInt(2n ** 60n - 1n);
    expect(
      bodies(transcript([row({ seq: huge, createdAt: 1, body: 'huge' }), row({ seq: justBelow, createdAt: 2, body: 'just below' })])),
    ).toEqual(['just below', 'huge']);
    expect(Number(huge) === Number(justBelow)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('what is read is decided over shared_through, never read_through', () => {
  /** Priya has read privately: `read_through` ran ahead, `shared_through` froze. */
  const priyaHidingTheGap = {
    conversationId: String(CONVERSATION),
    userId: String(PRIYA),
    readThrough: seqScalar.parse('900'),
    sharedThrough: seqScalar.parse('100'),
  };

  test('a frozen shared_through says NOT read, even though read_through is far past', async () => {
    // This is the whole of ADR 0010. `read_through` keeps advancing while sharing is
    // off — it has to, or the unread badge breaks — so it is always AHEAD of where
    // Priya left off, and anything another member can see must never read it.
    const store = await freshStore();
    await store.applyReceipt(priyaHidingTheGap);

    const at = seqScalar.parse('200');
    expect(
      await store.isReadByOthers({
        conversationId: String(CONVERSATION),
        viewerId: String(ME),
        currentMemberIds: [String(ME), String(PRIYA)],
        at,
      }),
    ).toBe(false);

    // And the thing that WOULD broadcast the gap is still readable — by Priya, for
    // Priya. It is the unread count's only reader and it has exactly one argument:
    // the member who owns it.
    expect(await store.ownReadThrough(String(CONVERSATION), String(PRIYA))).toBe(S('900'));
    expect(await store.ownReadThrough(String(CONVERSATION), String(ME))).toBeNull();
  });

  test('a shared_through at the position IS read, because the comparison is `>=`', async () => {
    const store = await freshStore();
    await store.applyReceipt({ ...priyaHidingTheGap, sharedThrough: seqScalar.parse('200') });
    expect(
      await store.isReadByOthers({
        conversationId: String(CONVERSATION),
        viewerId: String(ME),
        currentMemberIds: [String(ME), String(PRIYA)],
        at: seqScalar.parse('200'),
      }),
    ).toBe(true);
  });

  test('every CURRENT member has to have read it, not one of them', async () => {
    const store = await freshStore();
    await store.applyReceipt({ ...priyaHidingTheGap, sharedThrough: seqScalar.parse('200') });
    // Sam has said nothing at all, so the answer is no. Reading this as "some member"
    // would mark a message read because ONE of two people read it.
    const answer = await store.isReadByOthers({
      conversationId: String(CONVERSATION),
      viewerId: String(ME),
      currentMemberIds: [String(ME), String(PRIYA), String(SAM)],
      at: seqScalar.parse('200'),
    });
    expect(answer).toBe(false);

    await store.applyReceipt({
      conversationId: String(CONVERSATION),
      userId: String(SAM),
      readThrough: seqScalar.parse('200'),
      sharedThrough: seqScalar.parse('200'),
    });
    expect(
      await store.isReadByOthers({
        conversationId: String(CONVERSATION),
        viewerId: String(ME),
        currentMemberIds: [String(ME), String(PRIYA), String(SAM)],
        at: seqScalar.parse('200'),
      }),
    ).toBe(true);
  });

  test("a member's own sends never satisfy it", async () => {
    // `message-lifecycle.md` §9: "A member's own sends never advance their own
    // receipt, so their watermark can never satisfy the condition for their own
    // message." That is why the marker goes under the LAST OUTGOING message and
    // never under an incoming one — and it is a property of the predicate, not of
    // the interface.
    const store = await freshStore();
    await store.applyReceipt({
      conversationId: String(CONVERSATION),
      userId: String(ME),
      readThrough: seqScalar.parse('9999'),
      sharedThrough: seqScalar.parse('9999'),
    });
    expect(
      await store.isReadByOthers({
        conversationId: String(CONVERSATION),
        viewerId: String(ME),
        currentMemberIds: [String(ME)],
        at: seqScalar.parse('1'),
      }),
    ).toBe(false);
  });

  test('no membership means no read indicator, which is the safe direction', async () => {
    // "Every member has read it" is vacuously true over an empty set, and an empty
    // membership here means the caller has not reduced it yet — not that nobody read
    // anything. Failing open would print `Seen` under a message nobody has seen.
    const store = await freshStore();
    expect(
      await store.isReadByOthers({
        conversationId: String(CONVERSATION),
        viewerId: String(ME),
        currentMemberIds: [],
        at: seqScalar.parse('1'),
      }),
    ).toBe(false);
  });

  test('a watermark never regresses, under any arrival order', async () => {
    // The client's copy has to be monotone too: a local copy that went backwards
    // would render a `Seen` that disappears. `GREATEST` on the server (ADR 0010) and
    // this are the same mechanism, and they answer to the same four arrival orders.
    const store = await freshStore();
    const advance = (readThrough: string, sharedThrough: string) =>
      store.applyReceipt({
        conversationId: String(CONVERSATION),
        userId: String(PRIYA),
        readThrough: seqScalar.parse(readThrough),
        sharedThrough: seqScalar.parse(sharedThrough),
      });

    await advance('80', '60');
    await advance('20', '30'); // an out-of-order frame
    const receipt = await store.receiptFor(String(CONVERSATION), String(PRIYA));
    expect(receipt?.readThrough).toBe(S('80'));
    expect(receipt?.sharedThrough).toBe(S('60'));

    await advance('80', '60'); // and a duplicate
    expect((await store.receiptFor(String(CONVERSATION), String(PRIYA)))?.sharedThrough).toBe(S('60'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('what gets drawn for a row', () => {
  test('the stored state carries an unpositioned row and nothing carries a committed one', () => {
    const nothingRead = { ownReadThrough: null, deliveredThrough: null };
    const delivered = { ownReadThrough: null, deliveredThrough: seqScalar.parse('250') };

    const queued = row({ seq: null, createdAt: 1, state: 'queued' });
    expect(renderedStateOf(queued, nothingRead)).toBe('queued');
    expect(renderedStateOf({ ...queued, state: 'inFlight' }, nothingRead)).toBe('inFlight');
    // A definitive refusal outranks everything, including a watermark.
    expect(renderedStateOf({ ...queued, state: 'failed' }, delivered)).toBe('failed');

    const committed = row({ seq: seqScalar.parse('200'), createdAt: 1 });
    expect(renderedStateOf(committed, nothingRead)).toBe('sent');
    expect(renderedStateOf(committed, delivered)).toBe('delivered');
    // `ownReadThrough` is the VIEWER's own position about themselves. It says "I have
    // read this", never "somebody else has".
    expect(renderedStateOf(committed, { ownReadThrough: seqScalar.parse('200'), deliveredThrough: null })).toBe('read');
  });

  test('the local delivery watermark is the highest position this browser holds', async () => {
    // "A frame arrived at this member's client and was persisted" — which is exactly
    // what a delivery acknowledgement reports, so the client already knows it. It is
    // derived rather than stored, which is a second thing this database refuses to
    // hold.
    const store = await freshStore();
    // A wire Message, because `applyReceived` takes one and nothing else may.
    const at = (position: string, body: string): Message => ({
      id: mintMessageId(Number(position)),
      conversationId: CONVERSATION,
      authorId: PRIYA,
      body,
      attachments: [],
      seq: seqScalar.parse(position),
      createdAt: new Date(0).toISOString(),
    });
    await store.applyReceived(at('40', 'earlier'));
    await store.applyReceived(at('90', 'later'));

    expect(await store.heldThrough(String(CONVERSATION))).toBe(S('90'));
    // And an unpositioned row moves it not at all.
    await store.applyLocalSend({
      id: mintMessageId(1),
      conversationId: String(CONVERSATION),
      authorId: String(ME),
      body: 'queued',
      attachments: [],
      createdAt: 1,
    });
    expect(await store.heldThrough(String(CONVERSATION))).toBe(S('90'));
  });
});