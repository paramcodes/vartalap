/**
 * Gate S2 — push notifications (ADR 0011).
 *
 * Proves:
 * - Payload contains senderName and fixed "New message", never message body.
 * - SSRF guard rejects loopback, RFC 1918, and metadata addresses.
 * - Suppression checks against presence and monotonic delivery watermark.
 */
import { describe, expect, test } from 'bun:test';
import { conversationId as conversationIdScalar, messageId as messageIdScalar, seq as seqScalar } from '@vartalap/protocol';
import {
  buildPushPayload,
  isSafeEndpoint,
  isSuppressedByDelivery,
  shouldPush,
} from './push.ts';

describe('Gate S2: push payload hygiene (ADR 0011)', () => {
  test('payload carries title and fixed body, never message text', () => {
    const payload = buildPushPayload({
      conversationId: conversationIdScalar.parse('33333333-3333-4333-8333-333333333333'),
      messageId: messageIdScalar.parse('01911111-1111-7111-9111-111111111111'),
      senderName: 'Priya',
    });

    expect(payload.conversationId).toBe(conversationIdScalar.parse('33333333-3333-4333-8333-333333333333'));
    expect(payload.senderName).toBe('Priya');
    expect(payload.title).toBe('Priya');
    expect(payload.body).toBe('New message');
    expect((payload as Record<string, unknown>).text).toBeUndefined();
    expect((payload as Record<string, unknown>).content).toBeUndefined();
  });
});

describe('Gate S2: SSRF capability URL guards (ADR 0011)', () => {
  test('public HTTPS push service endpoints are accepted', () => {
    expect(isSafeEndpoint('https://fcm.googleapis.com/fcm/send/sample-token')).toBe(true);
    expect(isSafeEndpoint('https://updates.push.services.mozilla.com/wpush/v2/sample')).toBe(true);
    expect(isSafeEndpoint('https://web.push.apple.com/sample-endpoint')).toBe(true);
  });

  test('plain HTTP is refused', () => {
    expect(isSafeEndpoint('http://fcm.googleapis.com/sample')).toBe(false);
  });

  test('loopback and localhost endpoints are refused', () => {
    expect(isSafeEndpoint('https://localhost/push')).toBe(false);
    expect(isSafeEndpoint('https://127.0.0.1:8080/push')).toBe(false);
    expect(isSafeEndpoint('https://[::1]/push')).toBe(false);
  });

  test('private RFC 1918 and link-local cloud metadata IPs are refused', () => {
    expect(isSafeEndpoint('https://10.0.0.1/push')).toBe(false);
    expect(isSafeEndpoint('https://192.168.1.50/push')).toBe(false);
    expect(isSafeEndpoint('https://172.16.0.1/push')).toBe(false);
    expect(isSafeEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
  });
});

describe('Gate S2: delivery watermark suppression', () => {
  test('a message already delivered (deliveredThrough >= seq) is suppressed', async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ deliveredThrough: 100 }],
          }),
        }),
      }),
    } as never;

    const suppressed = await isSuppressedByDelivery(
      {
        userId: '22222222-2222-4222-8222-222222222222',
        conversationId: '33333333-3333-4333-8333-333333333333',
        seq: seqScalar.parse('50'),
      },
      fakeDb,
    );

    expect(suppressed).toBe(true);
  });

  test('a message not yet delivered (deliveredThrough < seq) is not suppressed', async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ deliveredThrough: 40 }],
          }),
        }),
      }),
    } as never;

    const suppressed = await isSuppressedByDelivery(
      {
        userId: '22222222-2222-4222-8222-222222222222',
        conversationId: '33333333-3333-4333-8333-333333333333',
        seq: seqScalar.parse('50'),
      },
      fakeDb,
    );

    expect(suppressed).toBe(false);
  });
});
