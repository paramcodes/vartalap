/**
 * UUIDv7, and nothing else.
 *
 * The message's identity and its idempotency key are ONE value (ADR 0004), and it
 * is minted here, on the client, before any request exists. `messageId` in
 * `@vartalap/protocol` refuses anything whose version nibble is not `7`, so a
 * value that came from `crypto.randomUUID()` — a v4 — would be rejected at the
 * boundary by the code that sends it. That check is the reason this file exists
 * rather than a one-line call: the brand is load-bearing and the generator has to
 * keep it.
 *
 * **It is never an order.** The 48-bit timestamp is the *client's* clock, clients
 * skew, and a user can set theirs (ADR 0005, `message-ordering.md`). What the
 * timestamp legitimately buys is the one thing `message-lifecycle.md` §1 says it
 * buys: *"a stable tiebreak for rendering a queue that has not been assigned
 * positions yet"*. That is `render.ts`'s use and this file's only promise.
 *
 * ── the counter, and why it is here and not there ───────────────────────────
 *
 * `rand_a`'s 12 bits hold a per-millisecond counter, so two sends inside one
 * millisecond order correctly by id. Without it they would tie on `createdAt` and
 * fall to the id tiebreak on pure randomness — two messages typed in the same
 * millisecond could render in the wrong order locally until the server placed
 * them.
 *
 * It is scoped to THIS module instance, which in a browser means this tab. A
 * second tab's ids in the same millisecond order arbitrarily. That is not
 * fixable from here and does not need to be: `seq` places them, and until then the
 * only cost is which of two same-millisecond queued sends draws first.
 *
 * **The counter is not a monotonicity guarantee anyone may rely on.** RFC 9562
 * scopes same-millisecond monotonicity to a single generator, and this one is
 * per tab. A counter that looks like a clock is an invitation to sort by it, and
 * ADR 0005 forbids that three times over.
 */
import { messageId as messageIdScalar, type MessageId } from '@vartalap/protocol';

/** `rand_a` is 12 bits. A rollover inside one millisecond is handled below. */
const RAND_A_MASK = 0xfff;

/** Variant `10`, shifted into place. The version nibble is a literal `7`. */
const VARIANT_10 = 0b10;
const VERSION_NIBBLE = '7';

/** Module state for the counter. Never exported — nothing else may know of it. */
let lastMillis = -1;
let counter = 0;

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

/**
 * Mint one UUIDv7.
 *
 * `nowMillis` is a parameter so a test can pin the clock; production passes
 * nothing and gets `Date.now()`. It is **not** a sort key anywhere downstream —
 * it is the value this id happens to carry.
 */
export function mintMessageId(nowMillis: number = Date.now()): MessageId {
  let millis = Math.max(0, Math.floor(nowMillis));

  // The generator's own clock is never moved backwards, even if the member's is.
  // A backwards jump would otherwise reset the counter against a timestamp this
  // module has already used. It costs nothing: the timestamp is not an order.
  if (millis > lastMillis) {
    lastMillis = millis;
    counter = 0;
  }

  let randA: number;
  if (millis === lastMillis) {
    counter += 1;
    if (counter > RAND_A_MASK) {
      // 4096 ids inside one millisecond. RFC 9562 §6.2 method 1: step the
      // timestamp forward one millisecond rather than reuse a counter value.
      millis = lastMillis + 1;
      lastMillis = millis;
      counter = 0;
    }
    randA = counter;
  } else {
    // A clock that jumped backwards. The timestamp stays honest about when this id
    // was minted, and the 62 random bits are what make it unique.
    const seed = crypto.getRandomValues(new Uint8Array(2));
    randA = (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & RAND_A_MASK;
  }

  // 62 bits of `rand_b` out of 64: the top two are the variant and are not
  // random. Eight bytes render as sixteen hex characters, four of which are the
  // fourth group and twelve the fifth.
  const tail = crypto.getRandomValues(new Uint8Array(8));
  let randB = '';
  for (const byte of tail) randB += hex(byte, 2);
  randB = hex(((parseInt(randB.slice(0, 2), 16) & 0x3f) | (VARIANT_10 << 6)), 2) + randB.slice(2);

  const time = millis.toString(16).padStart(12, '0');

  // Parsed, not asserted. The version nibble is the whole reason this is not
  // `crypto.randomUUID()`, and a generator that drifted would throw here rather
  // than send a value the server's schema refuses.
  return messageIdScalar.parse(
    `${time.slice(0, 8)}-${time.slice(8, 12)}-${VERSION_NIBBLE}${hex(randA, 3)}-${randB.slice(0, 4)}-${randB.slice(4)}`,
  );
}