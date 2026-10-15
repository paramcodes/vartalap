/**
 * Typing: a user gesture that expires, not a fact about the world (ADR 0006).
 *
 * Pure functions, and that is load-bearing rather than stylistic. The throttle
 * decision ("may this keystroke emit?") and the freshness decision ("is this
 * frame still alive?") are computable from their arguments alone, which is what
 * makes them testable without a socket, a server, or a clock that is not
 * injected. The composer (stage 6) holds the `TypingEmitter` state; the
 * transcript holds no typing state at all, because there is nothing to store.
 *
 * ── never persisted ────────────────────────────────────────────────────────
 *
 * Nothing in this file imports the store, Dexie, or any table, and
 * `typing.test.ts` asserts the source stays that way. If typing were durable a
 * reconnect would faithfully replay "Priya was typing" from last Tuesday and
 * it would stop being a hint. Every frame carries `at` (ms epoch) and the
 * receiver discards one older than its expiry — which is also what makes a
 * reconnect safe without any server coordination.
 *
 * ── the numbers ────────────────────────────────────────────────────────────
 *
 * Throttle: at most one event every **2 seconds**, and only when the text
 * actually changed (ADR 0006 — decided, not judged).
 *
 * Expiry: **5 seconds** of silence clears the indicator, on the receiver.
 * Judgment, recorded as such: the sender emits at most every 2s while typing,
 * so 5s of silence means at least two missed emissions — died, not paused. A
 * server-side timer is wrong because the sender may simply have closed their
 * tab, and a server that "clears" typing for someone who left is inventing a
 * fact (concept doc).
 *
 * Fan-out rides the socket, which does not exist yet — recorded unwritten in
 * `docs/plans/stage-4.md`. The frame shapes already exist in protocol
 * (`typing.started` / `typing.stopped`, both directions); this file decides
 * when they may be emitted and when they must be ignored, which is the part
 * that survives the socket arriving.
 */

/** At most one event per conversation per this long. ADR 0006, decided. */
export const TYPING_THROTTLE_MS = 2_000;

/** Silence this long clears the indicator, on the receiver. Judgment, recorded. */
export const TYPING_EXPIRY_MS = 5_000;

/** What the composer holds per conversation. Nothing else holds anything. */
export interface TypingEmitter {
  /** `at` of the last emitted frame, or `null` before the first keystroke. */
  readonly lastEmittedAt: number | null;
  /** The text the last emission described. */
  readonly lastText: string;
}

export const freshEmitter = (): TypingEmitter => ({ lastEmittedAt: null, lastText: '' });

/**
 * May this keystroke emit?
 *
 * Yes iff the text actually changed AND the throttle window since the last
 * emission has passed. A burst of keystrokes emits once; holding a key emits
 * nothing after the first; deleting back to an already-described text emits
 * nothing — the receiver already shows what that text meant.
 *
 * The returned state is the state to hold regardless of the answer: an
 * unemitted keystroke still updates `lastText`, so a later change is measured
 * against what the member actually typed rather than what was last sent.
 */
export function shouldEmitTyping(
  emitter: TypingEmitter,
  nowMs: number,
  text: string,
): { readonly emit: boolean; readonly emitter: TypingEmitter } {
  const next: TypingEmitter = { lastEmittedAt: emitter.lastEmittedAt, lastText: text };
  if (text === emitter.lastText) return { emit: false, emitter: next };
  if (emitter.lastEmittedAt !== null && nowMs - emitter.lastEmittedAt < TYPING_THROTTLE_MS) {
    return { emit: false, emitter: next };
  }
  return { emit: true, emitter: { lastEmittedAt: nowMs, lastText: text } };
}

/**
 * Is this frame still alive? The receiver-side discard.
 *
 * A frame older than the expiry is ignored however it arrived — live, replayed
 * after a reconnect, or duplicated. `at` is compared as sender wall-clock
 * against receiver wall-clock, which is approximate across devices and does not
 * need to be exact: the expiry is a hint lifetime, not a contract, and a
 * boundary dispute of a few hundred milliseconds either way changes nothing a
 * member can see.
 */
export function isTypingFresh(frameAtMs: number, nowMs: number): boolean {
  return nowMs - frameAtMs < TYPING_EXPIRY_MS;
}
