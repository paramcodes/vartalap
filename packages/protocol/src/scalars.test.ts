/**
 * The branded scalars, and the one whose error message used to be a lie.
 *
 * `messageId` promised UUIDv7 and validated with `.uuid()`, which matches any hex
 * UUID shape and never reads the version nibble. A v4 passed. That is two failures
 * and the tests below are both of them: a v4 that must be REJECTED, and a
 * rejection whose message has to name the constraint that actually fired. The
 * second is the half that is easy to skip — a fix that stops accepting the wrong
 * thing while leaving an error string claiming a guarantee nobody enforces is the
 * same bug wearing a hat.
 *
 * What is deliberately NOT tested here: ordering. The v7 timestamp is the client's
 * clock, clients skew, and RFC 9562's same-millisecond monotonicity does not
 * survive a connection pool, so `seq` is the order and this value never is (ADR
 * 0005). Validating the version here honours the stated contract; it makes nothing
 * safer. A test asserting "v7 ids sort in commit order" would be asserting a
 * guarantee the repo has already rejected, and it would pass by accident on a
 * single connection.
 *
 *     bun test packages/protocol
 */
import { describe, expect, test } from 'bun:test';
import { conversationId, handle, messageId, seq, seqFromBigInt, userId } from './scalars.ts';

/** Version 7 — the first hex group is a big-endian unix-ms timestamp. */
const V7 = '018f3b5e-9a1c-7c2e-8f4a-1b2c3d4e5f60';

/**
 * The same value with one character changed: position 15 is the version nibble,
 * and `4` there is exactly what `crypto.randomUUID()` produces. Derived rather
 * than typed out so the pair cannot drift apart in any other byte — if these two
 * ever stop being one edit apart, the next test stops meaning what it claims.
 */
const V4 = `${V7.slice(0, 14)}4${V7.slice(15)}`;

/** The message of the first issue, so a failure quotes the string under test. */
function rejectionMessage(candidate: unknown): string {
  const result = messageId.safeParse(candidate);
  if (result.success) throw new Error(`accepted a UUID that is not a v7: ${String(candidate)}`);
  return result.error.issues[0]?.message ?? '';
}

describe('the message id is a UUIDv7, and the check is the version nibble', () => {
  test('a v4 is rejected — it is the case that used to pass', () => {
    // The bug. `.uuid()` never looks at position 15, so a v4 parsed and the
    // caller was told it had an identity key with a v7 timestamp in it.
    expect(messageId.safeParse(V4).success).toBe(false);
    // Not just that one string: every version except 7 must be refused. These are
    // all values `crypto.randomUUID()` and its cousins can produce by accident, and
    // a `5` slipped through a per-string allowlist.
    for (const version of ['0', '1', '2', '3', '4', '5', '6', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']) {
      const uuid = `018f3b5e-9a1c-${version}c2e-8f4a-1b2c3d4e5f60`;
      expect({ uuid, accepted: messageId.safeParse(uuid).success }).toEqual({ uuid, accepted: false });
    }
  });

  test('the version is position 15, and it is the ONLY character that decides', () => {
    // Stated as a fact rather than inferred from the fixtures above: two strings
    // identical except at index 14, one accepted and one not. If the check ever
    // moves to a different character — or starts reading more than one — this
    // fails, and the failure is the whole guarantee leaving the file.
    expect(V7[14]).toBe('7');
    expect(V4[14]).toBe('4');
    expect(messageId.safeParse(V7).success).toBe(true);
    expect(messageId.safeParse(V4).success).toBe(false);
  });

  test('a v7 is accepted, lowercase or not', () => {
    // `String(...)` rather than comparing to the raw fixture: a brand is not a
    // `string`, and the compiler saying so is the brand working, not an obstacle.
    expect(String(messageId.parse(V7))).toBe(V7);
    // Uppercase hex is the same UUID — Postgres normalises it and RFC 9562 does not
    // make it a different value. Refusing it would reject a client that formats in
    // the case the platform handed it.
    const upper = V7.toUpperCase();
    expect(messageId.safeParse(upper).success).toBe(true);
  });

  test('the rejection names the real constraint, not the one that did not fire', () => {
    // Two different failures, two different messages. A string that is not a UUID
    // at all is not a v7 either, so "Invalid uuid" is true; the custom message now
    // appears only where the version is the actual problem, and it says which
    // character to look at.
    expect(rejectionMessage('not-a-uuid')).toBe('Invalid uuid');
    expect(rejectionMessage('018f3b5e-9a1c-7c2e-8f4a')).toBe('Invalid uuid');

    const wrongVersion = rejectionMessage(V4);
    expect(wrongVersion).toContain('UUIDv7');
    expect(wrongVersion).toContain('position 15');
    // The old string — the one that lied — must not be what a caller reads now.
    expect(wrongVersion).not.toBe('must be a UUIDv7');
  });
});

describe('the scalars that are NOT version-specific say nothing about a version', () => {
  test('a v4 id is still a valid user id and conversation id', () => {
    // The ruling is scoped. Only `messageId` is the client-generated UUIDv7 that
    // ADR 0004 makes an idempotency key; `user.id` is `gen_random_uuid()` — a v4 —
    // and rejecting those would break sign-in, because every account in the
    // database has one.
    expect(userId.safeParse(V4).success).toBe(true);
    expect(userId.safeParse(V7).success).toBe(true);
    expect(conversationId.safeParse(V4).success).toBe(true);
  });

  test('a handle is not a UUID at all, so no version check can reach it', () => {
    expect(String(handle.parse('alice_1'))).toBe('alice_1');
    expect(handle.safeParse(V7).success).toBe(false);
    expect(handle.safeParse('Alice').success).toBe(false);
  });

  test('a position is a decimal string and compares as a bigint', () => {
    // The other half of what these scalars exist for: `messages.seq` is a Postgres
    // bigint, which does not survive JSON above 2^53. Past that magnitude a JS
    // number cannot tell these two apart, and the comparison would pass anyway.
    const huge = seqFromBigInt(2n ** 60n);
    const justBelow = seqFromBigInt(2n ** 60n - 1n);
    expect(Number(huge) === Number(justBelow)).toBe(true);
    expect(BigInt(huge) > BigInt(justBelow)).toBe(true);

    for (const bad of ['-1', '1.5', '01', ' 1', '+1', '1e3', '']) {
      expect({ bad, accepted: seq.safeParse(bad).success }).toEqual({ bad, accepted: false });
    }
  });
});