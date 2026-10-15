/**
 * T1's client half: titles derive, previews follow the newest-held rule, the
 * badge caps without lying, and the timestamp rounds per the concept table.
 * Ordering itself is the server's (`list.test.ts`) — the client renders array
 * order and these tests pin everything around it.
 */
import { describe, expect, test } from 'bun:test';
import { conversationListItem, seq as seqScalar } from '@vartalap/protocol';
import {
  badgeLabel,
  badgeText,
  deriveTitle,
  formatTime,
  hueOf,
  initialsOf,
  pickPreview,
  rowPreview,
} from './list.ts';
import type { MessageRow } from './store.ts';

function item(overrides: Record<string, unknown> = {}) {
  return conversationListItem.parse({
    conversationId: '11111111-1111-4111-8111-111111111111',
    kind: 'direct',
    title: null,
    lastSeq: '5',
    unreadCount: 0,
    muted: false,
    presence: [],
    peers: [
      {
        conversationId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        displayName: 'Priya Raman',
        avatarMediaId: null,
        leftAt: null,
        mutedAt: null,
      },
    ],
    permission: { allowed: true },
    ...overrides,
  });
}

function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '01911111-1111-7111-9111-111111111111',
    conversationId: '11111111-1111-4111-8111-111111111111',
    authorId: '22222222-2222-4222-8222-222222222222',
    body: 'hello',
    attachments: [],
    seq: seqScalar.parse('5'),
    state: null,
    createdAt: 1_000,
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
    ...overrides,
  };
}

describe('deriveTitle', () => {
  test('a direct title is the peer display name, never a stored title', () => {
    expect(deriveTitle(item(), 'viewer')).toBe('Priya Raman');
  });

  test('a group title is the stored one', () => {
    expect(deriveTitle(item({ kind: 'group', title: 'Study group', peers: undefined }), 'viewer')).toBe(
      'Study group',
    );
  });
});

describe('pickPreview', () => {
  test('a queued send previews even under positioned messages', () => {
    const preview = pickPreview([
      row({ body: 'old news', seq: seqScalar.parse('9'), state: null, createdAt: 100 }),
      row({ body: 'just typed', seq: null, state: 'queued', createdAt: 200 }),
    ]);
    expect(preview).toEqual({ kind: 'queued', text: 'just typed' });
  });

  test('otherwise the highest position wins', () => {
    const preview = pickPreview([
      row({ body: 'old', seq: seqScalar.parse('7'), createdAt: 100 }),
      row({ body: 'new', seq: seqScalar.parse('9'), createdAt: 50 }),
    ]);
    expect(preview).toEqual({ kind: 'message', text: 'new' });
  });

  test('nothing held reads as No messages yet', () => {
    expect(pickPreview([])).toEqual({ kind: 'empty', text: 'No messages yet' });
  });

  test('a pair you blocked previews as a sentence', () => {
    const blocked = item({ permission: { allowed: false, reason: 'blocked_by_me' } });
    expect(rowPreview(blocked, [row({ body: 'are you around later' })])).toEqual({
      kind: 'locked',
      text: 'You blocked this conversation.',
    });
  });
});

describe('badge', () => {
  test('zero renders nothing, ninety-nine renders, hundreds cap', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });

  test('the accessible name carries the true number', () => {
    expect(badgeLabel(1)).toBe('1 unread message');
    expect(badgeLabel(140)).toBe('140 unread messages');
  });
});

describe('formatTime', () => {
  // Tuesday 2026-10-13 12:00 UTC.
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);

  test('under an hour reads as nothing', () => {
    expect(formatTime(now - 10 * 60_000, now)).toBeNull();
  });

  test('earlier today reads as the time', () => {
    expect(formatTime(now - 3 * 3_600_000, now)).toBe('9:00 AM');
  });

  test('yesterday reads as Yesterday', () => {
    expect(formatTime(now - 26 * 3_600_000, now)).toBe('Yesterday');
  });

  test('earlier this week reads as the weekday', () => {
    expect(formatTime(now - 3 * 86_400_000, now)).toBe('Saturday');
  });

  test('earlier this year reads as day month', () => {
    expect(formatTime(Date.UTC(2026, 4, 3, 9, 0, 0), now)).toBe('3 May');
  });

  test('last year is numeric and unambiguous', () => {
    expect(formatTime(Date.UTC(2025, 9, 14, 9, 0, 0), now)).toBe('14/10/2025');
  });
});

describe('avatar', () => {
  test('initials take first and last words', () => {
    expect(initialsOf('Priya Raman')).toBe('PR');
    expect(initialsOf('plato')).toBe('P');
  });

  test('the hue is stable per id', () => {
    expect(hueOf('abc')).toBe(hueOf('abc'));
    expect(hueOf('abc')).toBeGreaterThanOrEqual(0);
  });
});
