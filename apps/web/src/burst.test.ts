/**
 * The transcript's drawing rules: a divider terminates a run, the four burst
 * states narrow only inline-end corners, and `Seen` may hang nowhere but the
 * last outgoing message.
 */
import { describe, expect, test } from 'bun:test';
import { seq as seqScalar } from '@vartalap/protocol';
import { mintMessageId } from './message-id.ts';
import { bubbleClasses, burstState, dividerAfter, dayLabel, isLastOutgoing } from './burst.ts';
import type { MessageRow } from './store.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const PRIYA = '22222222-2222-4222-8222-222222222222';

const T0 = Date.UTC(2026, 9, 13, 9, 0, 0);
const EARLIER = Date.UTC(2026, 9, 12, 9, 0, 0);

function row(body: string, author: string, atMs: number, position: number | null): MessageRow {
  return {
    id: mintMessageId(atMs),
    conversationId: '33333333-3333-4333-8333-333333333333',
    authorId: author,
    body,
    attachments: [],
    seq: position === null ? null : seqScalar.parse(String(position)),
    state: position === null ? 'queued' : null,
    createdAt: atMs,
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
  };
}

describe('dividers', () => {
  const rows = [row('yesterday', PRIYA, EARLIER, 1), row('today', ME, T0, 2)];

  test('a date boundary sits between the last row of one day and the first of the next', () => {
    expect(dividerAfter(rows, 0)).toBe(true);
    expect(dividerAfter(rows, 1)).toBe(false);
  });

  test('same-day neighbours carry no divider', () => {
    const run = [row('one', PRIYA, T0, 1), row('two', PRIYA, T0 + 60_000, 2)];
    expect(dividerAfter(run, 0)).toBe(false);
  });

  test('a label reads as Today, Yesterday, or a full date', () => {
    expect(dayLabel(T0, T0 + 3_600_000)).toBe('Today');
    expect(dayLabel(EARLIER, T0)).toBe('Yesterday');
    expect(dayLabel(Date.UTC(2025, 9, 14), T0)).toBe('14 October 2025');  });
});

describe('burst states', () => {
  test('a run of three from one author is first, middle, last', () => {
    const rows = [
      row('one', PRIYA, T0, 1),
      row('two', PRIYA, T0 + 60_000, 2),
      row('three', PRIYA, T0 + 120_000, 3),
    ];
    expect(rows.map((_, index) => burstState(rows, index))).toEqual(['first', 'middle', 'last']);
  });

  test('a divider terminates the run — two authors either side is two runs', () => {
    const rows = [
      row('yesterday', PRIYA, EARLIER, 1),
      row('today', PRIYA, T0, 2),
      row('next', PRIYA, T0 + 60_000, 3),
    ];
    expect(rows.map((_, index) => burstState(rows, index))).toEqual(['single', 'first', 'last']);
  });

  test('an author change starts a new single', () => {
    const rows = [row('mine', ME, T0, 1), row('theirs', PRIYA, T0 + 60_000, 2)];
    expect(rows.map((_, index) => burstState(rows, index))).toEqual(['single', 'single']);
  });

  test('middle and last are identical, per ADR 0002', () => {
    expect(bubbleClasses('middle')).toBe(bubbleClasses('last'));
    expect(bubbleClasses('single')).not.toBe(bubbleClasses('middle'));
  });
});

describe('where Seen may hang', () => {
  const rows = [row('theirs', PRIYA, T0, 1), row('mine one', ME, T0 + 60_000, 2), row('mine two', ME, T0 + 120_000, 3)];

  test('only the newest outgoing message is the last outgoing', () => {
    const lastOutgoing = rows.filter((candidate) => isLastOutgoing(rows, candidate, ME));
    expect(lastOutgoing.map((candidate) => candidate.body)).toEqual(['mine two']);
  });

  test('with no outgoing message at all, nothing qualifies', () => {
    expect(rows.some((candidate) => isLastOutgoing(rows, candidate, ME))).toBe(true);
    const incoming = [row('theirs', PRIYA, T0, 1), row('theirs two', PRIYA, T0 + 60_000, 2)];
    expect(incoming.some((candidate) => isLastOutgoing(incoming, candidate, ME))).toBe(false);
  });
});
