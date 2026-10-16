/**
 * T1 in pixels: a muted conversation with unread still listed with both
 * marks, a zero-position conversation sorted as positionless, and a blocked
 * pair's row rendering the locked affordance. Server order is rendered, never
 * re-sorted — these tests pin what the states render as.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { seq as seqScalar } from '@vartalap/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from './app.tsx';
import type { MessageRow } from './store.ts';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => cleanup());
const CONVERSATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONVERSATION_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PEER = '22222222-2222-4222-8222-222222222222';
function member(displayName: string) {
  return {
    conversationId: CONVERSATION_A,
    userId: PEER,
    displayName,
    avatarMediaId: null,
    leftAt: null,
    mutedAt: null,
  };
}
const ITEMS = [
  {
    conversationId: CONVERSATION_A,
    kind: 'direct',
    title: null,
    lastSeq: '12',
    unreadCount: 2,
    muted: true,
    presence: [{ userId: PEER, online: true }],
    peers: [member('Priya Raman')],
    permission: { allowed: true },
  },
  {
    conversationId: CONVERSATION_B,
    kind: 'group',
    title: 'Study group',
    lastSeq: '9',
    unreadCount: 0,
    muted: false,
    presence: [],
    permission: { allowed: true },
  },
  {
    conversationId: CONVERSATION_C,
    kind: 'direct',
    title: null,
    lastSeq: '0',
    unreadCount: 0,
    muted: false,
    presence: [{ userId: PEER, online: false }],
    peers: [member('Third Wheel')],
    permission: { allowed: true },
  },
  {
    conversationId: CONVERSATION_D,
    kind: 'direct',
    title: null,
    lastSeq: '3',
    unreadCount: 0,
    muted: false,
    presence: [],
    peers: [member('Blocked Beth')],
    permission: { allowed: false, reason: 'blocked_by_me' },
  },
];
function testFetch() {
  return (async (input: string) => {
    if (typeof input === 'string' && input === '/api/conversations') {
      return new Response(JSON.stringify(ITEMS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}
function testRows(): (conversationId: string) => Promise<MessageRow[]> {
  const base: MessageRow = {
    id: '01911111-1111-7111-9111-111111111111',
    conversationId: CONVERSATION_A,
    authorId: PEER,
    body: 'are you around later',
    attachments: [],
    seq: seqScalar.parse('12'),
    state: null,
    createdAt: Date.UTC(2026, 9, 1, 9, 41, 0),
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
  };
  return async (conversationId: string) =>
    conversationId === CONVERSATION_A ? [{ ...base, conversationId }] : [];
}
async function renderList() {
  render(
    <MemoryRouter>
      <App
        deps={{ viewerId: 'viewer-1', fetch: testFetch() }}
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        testDeps={{ loadRows: testRows() }}
      />
    </MemoryRouter>,
  );
  const articles = await screen.findAllByRole('article');
  return articles;
}
describe('conversation list', () => {
  test('renders server order with positions 1..4', async () => {
    const articles = await renderList();
    expect(articles.map((article) => article.getAttribute('aria-posinset'))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(articles[0]!.getAttribute('aria-setsize')).toBe('4');
  });
  test('a muted conversation keeps its unread badge and gains a glyph', async () => {
    const articles = await renderList();
    const muted = within(articles[0]!);
    expect(muted.getByText('Priya Raman')).toBeDefined();
    const badge = muted.getByLabelText('2 unread messages');
    expect(badge.textContent).toBe('2');
    expect(muted.getByLabelText('Muted')).toBeDefined();
    expect(muted.getByText('are you around later')).toBeDefined();
  });
  test('a zero-position conversation renders as positionless, not missing', async () => {
    const articles = await renderList();
    const quiet = within(articles[2]!);
    expect(quiet.getByText('Third Wheel')).toBeDefined();
    expect(quiet.getByText('No messages yet')).toBeDefined();
    expect(quiet.queryByLabelText(/unread messages/)).toBeNull();
  });
  test("a blocked pair's row renders the locked affordance", async () => {
    const articles = await renderList();
    const locked = within(articles[3]!);
    expect(locked.getByText('You blocked this conversation.')).toBeDefined();
    expect(locked.getByLabelText('You blocked this conversation')).toBeDefined();
  });
});