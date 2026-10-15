/**
 * Gate P2 — typing never exceeds one event per 2 seconds, expires without a
 * server round trip, is never persisted, and a stale frame is discarded by its
 * receiver.
 *
 * Pure functions, so no socket, no server, and no clock that is not an
 * argument. `nowMs` is always passed in — a test that waited out a real
 * throttle would be a test that takes longer than the guarantee it proves.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import {
  freshEmitter,
  isTypingFresh,
  shouldEmitTyping,
  TYPING_EXPIRY_MS,
  TYPING_THROTTLE_MS,
} from './typing.ts';

test('the numbers are stated once, and they are the designed ones', () => {
  expect(TYPING_THROTTLE_MS).toBe(2_000);
  // The throttle is ADR 0006's; the expiry is judgment, recorded in typing.ts.
  expect(TYPING_EXPIRY_MS).toBe(5_000);
});

describe('P2 — at most one event per 2 seconds, and only on change', () => {
  test('a burst of keystrokes emits once', () => {
    let emitter = freshEmitter();
    const emitted: string[] = [];
    const texts = ['h', 'he', 'hel', 'hell', 'hello'];
    texts.forEach((text, index) => {
      const answer = shouldEmitTyping(emitter, 1_000 + index * 100, text);
      emitter = answer.emitter;
      if (answer.emit) emitted.push(text);
    });
    expect(emitted).toEqual(['h']);
  });

  test('unchanged text emits nothing, however long it has been', () => {
    let emitter = freshEmitter();
    const first = shouldEmitTyping(emitter, 0, 'hello');
    expect(first.emit).toBe(true);
    emitter = first.emitter;
    // Ten seconds later, same text: nothing. The receiver already shows it.
    expect(shouldEmitTyping(emitter, 10_000, 'hello').emit).toBe(false);
  });

  test('changed text after the window emits again', () => {
    let emitter = freshEmitter();
    emitter = shouldEmitTyping(emitter, 0, 'a').emitter;
    const throttled = shouldEmitTyping(emitter, 1_999, 'ab');
    expect(throttled.emit).toBe(false);
    emitter = throttled.emitter;
    // Measured against what was TYPED, not what was sent: the throttled 'ab'
    // updated lastText without emitting, so at the window edge it takes a new
    // change — 'abc' — to emit. Re-reporting 'ab' itself emits nothing.
    expect(shouldEmitTyping(emitter, 2_000, 'ab').emit).toBe(false);
    expect(shouldEmitTyping(emitter, 2_000, 'abc').emit).toBe(true);
  });

  test('an identical re-report emits nothing', () => {
    // A duplicate keystroke event, or a composition event that changed nothing:
    // the text equals what was last typed, so there is nothing to say.
    let emitter = freshEmitter();
    emitter = shouldEmitTyping(emitter, 0, 'hello').emitter;
    expect(shouldEmitTyping(emitter, 100, 'hello').emit).toBe(false);
    expect(shouldEmitTyping(emitter, 10_000, 'hello').emit).toBe(false);
  });
});

describe('P2 — expiry is the receiver\u2019s business, and stale frames die', () => {
  test('a fresh frame is alive', () => {
    expect(isTypingFresh(1_000, 1_500)).toBe(true);
  });

  test('a frame older than the expiry is discarded however it arrived', () => {
    // Live, replayed after a reconnect, or duplicated — the receiver cannot
    // tell and must not care. "Priya was typing" from before the partition is
    // not a hint about the present.
    expect(isTypingFresh(1_000, 1_000 + TYPING_EXPIRY_MS)).toBe(false);
    expect(isTypingFresh(1_000, 1_000 + TYPING_EXPIRY_MS + 60_000)).toBe(false);
  });
});

describe('P2 — never persisted', () => {
  test('typing.ts reaches for no store, no table, no socket', async () => {
    // Structural, in this repo's idiom: the guarantee "typing is never stored"
    // is a property of what this module CAN touch, not of what it happens to
    // touch today. A future import of the store fails here rather than
    // introducing a write nobody reviews. Matched as imports, not words — the
    // module's own comments name Dexie to explain its absence.
    const source = await Bun.file(new URL('./typing.ts', import.meta.url)).text();
    expect(source).not.toMatch(/from ['"]\.\/store\.ts['"]/);
    expect(source).not.toMatch(/from ['"]dexie['"]/);
    expect(source).not.toMatch(/#db\./);
    expect(source).not.toMatch(/new (WebSocket|EventSource)\(/);
    expect(source).not.toMatch(/\.fetch\(/);
  });
});
