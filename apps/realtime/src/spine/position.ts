/**
 * `Seq` → the number a `bigint(…, { mode: 'number' })` column takes, and the one
 * guard that rule needs.
 *
 * ── why this exists at all ─────────────────────────────────────────────────────
 *
 * `seq` is a **decimal string** on the wire (`scalars.ts`) because a bigint does not
 * survive JSON: `JSON.parse` of a bare number past 2^53 loses precision without
 * error, and the protocol refuses to lose it anywhere else — `frames.test.ts` asserts
 * `2^60` precisely so two neighbouring positions cannot compare equal.
 *
 * The columns, though, are `bigint(…, { mode: 'number' })`. That is the one place the
 * value crosses into a JavaScript number, and it has two ceilings:
 *
 *   1. **2^53** — `Number('9007199254740993')` is `9007199254740992`. A watermark
 *      stored one message behind where the member actually read, with no error, no
 *      warning, and no way to tell afterwards. It renders as a message that refuses
 *      to turn blue, forever.
 *   2. **2^63 − 1** — beyond it the bind fails inside Postgres as SQLSTATE `22003`
 *      and leaves a `500` on the wire, which says "our fault" about a client bug.
 *
 * Neither is reachable in v1 — 2^53 messages is nine quadrillion — and both are
 * exactly the kind of failure that is silent rather than loud, so they are refused
 * here rather than absorbed. `docs/plans/stage-3.md`'s rule is that a unit which
 * discovers a decision is missing writes the decision down; this is the small one,
 * and it is a boundary because the value came from a client.
 *
 * **The check is a round trip, not a magnitude comparison.** `Number.isSafeInteger`
 * would pass `2^60` — exactly representable, and no rounding — while `1n + 2^60n` is
 * not, and magnitude alone would refuse the first and accept a hundred near-misses
 * around it. Comparing `BigInt(Number(value))` with `BigInt(value)` asks the only
 * question that matters: does the number still say what the string said?
 *
 * **One copy of that arithmetic, three callers.** The two spine write paths each turn
 * a `null` here into a loud failure, and the two routes each turn it into a `400`
 * naming the field. They are one rule about one column type; four separate
 * implementations of it is four places to get it subtly differently wrong.
 */
import type { Seq } from '@vartalap/protocol';

/** The stored value, or `null` when the column cannot hold it exactly. */
export function storedPosition(value: Seq): number | null {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return null;
  // Exact round trip. `BigInt` of a non-integer number throws, and `Number` of a
  // decimal string with no fraction always yields an integer or `Infinity`, both of
  // which are handled above — so this never throws for a value `Seq` accepted.
  return BigInt(asNumber) === BigInt(value) ? asNumber : null;
}