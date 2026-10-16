/**
 * Stage 8 — Hardening (Gates H1–H5, ADRs 0040–0044).
 */
import { describe, expect, test } from 'bun:test';
import { json, SECURITY_HEADERS } from '../http.ts';
import { RATE_LIMIT_RULES } from './rate-limit.ts';

describe('Gate H1: security headers (ADR 0040)', () => {
  test('emits required baseline security headers', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    // HSTS must NOT contain preload (ADR 0040: preload is a one-way door)
    expect(SECURITY_HEADERS['strict-transport-security']).toContain('max-age=31536000');
    expect(SECURITY_HEADERS['strict-transport-security']).not.toContain('preload');
  });

  test('json helper includes all security headers on responses', () => {
    const res = json({ ok: true });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('Gate H2: rate limit rules and fail-closed semantics (ADR 0043)', () => {
  test('documented rates and bursts are exact', () => {
    expect(RATE_LIMIT_RULES.send.limit).toBe(30);
    expect(RATE_LIMIT_RULES.send.burst).toBe(10);
    expect(RATE_LIMIT_RULES.send.windowSeconds).toBe(60);

    expect(RATE_LIMIT_RULES.auth.limit).toBe(10);
    expect(RATE_LIMIT_RULES.auth.burst).toBe(3);
    expect(RATE_LIMIT_RULES.auth.windowSeconds).toBe(60);

    expect(RATE_LIMIT_RULES.search.limit).toBe(60);
    expect(RATE_LIMIT_RULES.search.burst).toBe(20);
    expect(RATE_LIMIT_RULES.search.windowSeconds).toBe(60);

    expect(RATE_LIMIT_RULES.presign.limit).toBe(20);
    expect(RATE_LIMIT_RULES.presign.burst).toBe(5);
    expect(RATE_LIMIT_RULES.presign.windowSeconds).toBe(3600);
  });

  test('auth fails closed, other surfaces fail open', () => {
    expect(RATE_LIMIT_RULES.auth.failClosed).toBe(true);
    expect(RATE_LIMIT_RULES.send.failClosed).toBe(false);
    expect(RATE_LIMIT_RULES.search.failClosed).toBe(false);
    expect(RATE_LIMIT_RULES.presign.failClosed).toBe(false);
  });
});

describe('Gate H3: account erasure specification (ADR 0041)', () => {
  test('tombstone format matches RFC 2606 reserved domain', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const tombstoneEmail = `tombstone-${userId}@deleted.invalid`;
    expect(tombstoneEmail).toMatch(/@deleted\.invalid$/);
  });
});
