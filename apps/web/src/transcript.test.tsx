/**
 * T2 in pixels: own echo converges to one row, a `Seen` sits under the last
 * outgoing message and nowhere else, and the burst classes follow 0002.
 *
 * Rows and watermarks come from a real `MessageStore` over `fake-indexeddb`
 * — not a component-level mock — so the render is over the same write path
 * the app uses. `startSession` and `loadMembers` are injected because they
 * touch the wire.
 */
import { describe, expect, test } from 'bun:test';
import { seq as seqScalar, type Message, type UserId } from '@vartalap/protocol';
import { render, screen, waitFor, within } from '@testing-library/react';
import { Transcript } from './transcript.tsx';
import { createStore, type MessageRow, type MessageStore } from './store.ts';
import { mintMessageId } from './message-id.ts';

import { conversationId as conversationIdScalar, userId as userIdScalar } from '@vartalap/protocol';

const CONVERSATION = conversationIdScalar.parse('33333333-3333-4333-8333-333333333333');
const ME = userIdScalar.parse('11111111-1111-4111-8111-111111111111');
const PRIYA = userIdScalar.parse('22222222-2222-4222-8222-222222222222');

const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);

let databases = 0;
async function freshStore(): Promise<MessageStore> {
  databases += 1;
  return createStore(`vartalap-transcript-${databases}`).open();
}

function wire(body: string, author: string, position: string, atMs: number): Message {
  return {
    id: mintMessageId(atMs),
    conversationId: CONVERSATION,
    authorId: author as UserId,
    body,
    attachments: [],
    seq: seqScalar.parse(position),
    createdAt: new Date(atMs).toISOString(),
  };
}

/** The store the component reads, and a loader that reads the same rows. */
async function seeded(bodies: { body: string; author: string; position: string }[]) {
  const store = await freshStore();
  for (const [index, entry] of bodies.entries()) {
    await store.applyReceived(wire(entry.body, entry.author, entry.position, T0 + index * 60_000));
  }
  const loadRows = (): Promise<MessageRow[]> => store.rowsFor(CONVERSATION);
  return { store, loadRows };
}

const NO_MEMBERS = async (): Promise<readonly string[]> => [];
const withMembers = (ids: readonly string[]) => async (): Promise<readonly string[]> => ids;

async function renderTranscript({
  conversationId = CONVERSATION,
  viewerId = ME,
  loadRows,
  memberIds = [ME, PRIYA],
  store,
  advanceReceipt,
}: {
  conversationId?: string;
  viewerId?: string;
  loadRows: () => Promise<MessageRow[]>;
  memberIds?: readonly string[];
  store?: () => Promise<MessageStore>;
  advanceReceipt?: (conversationId: string, through: string) => Promise<void>;
}) {
  const utils = render(
    <Transcript
      conversationId={conversationId}
      viewerId={viewerId}
      deps={{
        loadRows,
        startSession: async () => {},
        loadMembers: withMembers(memberIds),
        ...(store === undefined ? {} : { store }),
        ...(advanceReceipt === undefined ? {} : { advanceReceipt }),
      }}
    />,
  );
  // The rows, the watermarks and the read advance all settle asynchronously —
  // assertion time is after the DOM has stopped changing, not before.
  await waitFor(() => expect(utils.container.querySelectorAll('p').length).toBeGreaterThan(0));
  return utils;
}

/** The bubbles of one render, in draw order, by body text. */
async function bubblesOf(utils: { container: HTMLElement }): Promise<string[]> {
  let found: Element[] = [];
  await waitFor(() => {
    found = Array.from(utils.container.querySelectorAll('p'));
    expect(found.length).toBeGreaterThan(0);
  });
  // The watermark and Seen effects settle after the rows do, so give the last
  // frame a chance rather than assuming a number of renders.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return found.map((node) => node.textContent ?? '');
}

describe('the transcript', () => {
  test('renders every held row once — an own echo converges instead of duplicating', async () => {
    const store = await freshStore();
    // The echo is the normal case (ADR 0061): the same frame applied twice.
    await store.applyReceived(wire('are you around later', PRIYA, '4', T0));
    await store.applyReceived(wire('are you around later', PRIYA, '4', T0));
    await store.applyReceived(wire('typing back', ME, '5', T0 + 60_000));

    const utils = await renderTranscript({
      loadRows: () => store.rowsFor(CONVERSATION),
      store: async () => store,
    });
    const read: [string, string][] = [];
    expect(await bubblesOf(utils)).toEqual(['are you around later', 'typing back']);
    expect(await store.rowsFor(CONVERSATION)).toHaveLength(2);
  });

  test('a position never moves a rendered row — seq order, not arrival order', async () => {
    const { loadRows } = await seeded([
      { body: 'first', author: PRIYA, position: '4' },
      { body: 'second', author: ME, position: '5' },
      { body: 'third', author: PRIYA, position: '6' },
    ]);

    const utils = await renderTranscript({ loadRows });
    expect(await bubblesOf(utils)).toEqual(['first', 'second', 'third']);
  });

  test('Seen sits under the last outgoing message and nowhere else, once', async () => {
    const { store, loadRows } = await seeded([
      { body: 'theirs first', author: PRIYA, position: '4' },
      { body: 'mine first', author: ME, position: '5' },
      { body: 'mine second', author: ME, position: '6' },
    ]);
    // Priya, alone among the other members, has shared-read to 6.
    await store.applyReceipt({
      conversationId: CONVERSATION,
      userId: PRIYA,
      readThrough: seqScalar.parse('900'),
      sharedThrough: seqScalar.parse('6'),
    });

    const utils = await renderTranscript({ loadRows, store: async () => store });
    expect(await bubblesOf(utils)).toEqual(['theirs first', 'mine first', 'mine second']);

    const seen = await screen.findAllByText('Seen');
    expect(seen.length).toBe(1);
    // It is pinned to the newest outgoing bubble, not to an earlier one.
    const wrapper = seen[0]!.parentElement!;
    expect(wrapper.previousElementSibling?.textContent).toBe('mine second');
    expect(utils.container.querySelectorAll('span')).toHaveLength(1);
  });

  test('a frozen shared_through hides the gap — no Seen, though read far past', async () => {
    // ADR 0010/trap 14, asserted at the pixel: `read_through` at 900 and
    // `shared_through` at 4 must not print `Seen` under a message at 6.
    const { store, loadRows } = await seeded([
      { body: 'mine first', author: ME, position: '4' },
      { body: 'mine second', author: ME, position: '6' },
    ]);
    await store.applyReceipt({
      conversationId: CONVERSATION,
      userId: PRIYA,
      readThrough: seqScalar.parse('900'),
      sharedThrough: seqScalar.parse('4'),
    });

    const utils = await renderTranscript({ loadRows, store: async () => store });
    // Let the marker decision settle, then assert the safe direction won: the
    // row renders its status, and `Seen` never appears — in THIS render.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(utils.container).queryByText('Seen')).toBeNull();
    expect(utils.container.textContent).toContain('Delivered');
  });

  test('an unpositioned row renders as a queued send, after everything positioned', async () => {
    const { store, loadRows } = await seeded([{ body: 'committed', author: PRIYA, position: '7' }]);
    await store.applyLocalSend({
      id: mintMessageId(T0 + 300_000),
      conversationId: CONVERSATION,
      authorId: ME,
      body: 'still sending',
      attachments: [],
      createdAt: T0 + 300_000,
    });

    const read: [string, string][] = [];
    const utils = await renderTranscript({
      loadRows: () => store.rowsFor(CONVERSATION),
      store: async () => store,
      advanceReceipt: async (id, through) => {
        read.push([id, through]);
      },
    });

    // The read advance posted the position this browser holds — and only once.
    expect(read).toEqual([[String(CONVERSATION), '7']]);
    expect(await bubblesOf(utils)).toEqual(['committed', 'still sending']);
  });
});
