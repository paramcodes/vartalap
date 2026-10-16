/**
 * UUIDv7, which is the message's identity AND its idempotency key — one value, two
 * jobs (ADR 0004). If the generator drifts, every send in the product is refused at
 * the boundary, so this is worth its own file.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import { messageId } from '@vartalap/protocol';
import { mintMessageId } from './message-id.ts';

/**
 * A clock comfortably AHEAD of anything the generator has seen.
 *
 * The generator holds its own clock forward and never backwards, so a test that
 * pins a timestamp behind the one the last test used takes the backwards-clock
 * branch — correctly. Reaching past it keeps each test about the property it names
 * rather than about which test ran before it.
 */
const AHEAD = Math.max(Date.now(), 1_760_000_000_000) + 3_600_000;

describe('UUIDv7', () => {
  test('the version nibble is 7 and the variant is 10', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = mintMessageId(AHEAD);
      // `messageId` refuses anything else, so this passing means the brand held —
      // but the shape is asserted directly too, because the brand could be widened.
      expect(id[14]).toBe('7');
      expect(id[19]).toMatch(/[89ab]/);
      expect(() => messageId.parse(id)).not.toThrow();
    }
  });

  test('a UUIDv4 would be REFUSED, which is the reason this file exists', () => {
    const v4 = '3c2d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e';
    expect(() => messageId.parse(v4)).toThrow();
    // And `crypto.randomUUID()` is a v4, so it cannot be what mints a message id.
    expect(crypto.randomUUID()[14]).toBe('4');
  });

  test('the 48-bit timestamp is the clock it was given', () => {
    const millis = AHEAD + 10;
    const hex = millis.toString(16).padStart(12, '0');
    const id = mintMessageId(millis);
    expect(id.slice(0, 8)).toBe(hex.slice(0, 8));
    expect(id.slice(9, 13)).toBe(hex.slice(8, 12));
  });

  test('ids minted inside one millisecond order correctly', () => {
    // The counter in `rand_a`. Without it two sends in one millisecond would tie on
    // `createdAt` and fall to an arbitrary id order — two messages drawn in the
    // wrong order until the server placed them.
    const ids = Array.from({ length: 200 }, () => mintMessageId(AHEAD + 20));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a counter rollover steps the timestamp rather than reusing a value', () => {
    // RFC 9562 §6.2 method 1. 4096 ids is far past what a person produces and is
    // exactly the case where the alternative is a duplicated timestamp AND counter,
    // which is a duplicated id.
    const ids = Array.from({ length: 4_200 }, () => mintMessageId(AHEAD + 30));
    expect(new Set(ids).size).toBe(4_200);
  });

  test('a clock that jumps backwards produces unique ids and never goes back', () => {
    // The generator's own clock is held. A member who sets their clock back gets an
    // id whose timestamp is honest and whose uniqueness comes from the 62 random
    // bits — which is all identity ever needed from it.
    const first = mintMessageId(AHEAD + 40);
    const backwards = Array.from({ length: 20 }, () => mintMessageId(AHEAD - 10_000));
    expect(new Set(backwards).size).toBe(20);
    expect(backwards).not.toContain(first);
    // And the clock recovers: a later call is ordered after the earlier one.
    expect(mintMessageId(AHEAD + 41) > first).toBe(true);
  });
});