/**
 * The sink — where a relayed frame is published TO. ADR 0057, "the sink is an
 * interface, not Centrifugo".
 *
 * ── why this is an interface and not a broker client ──────────────────────────
 *
 * Centrifugo is not installed in this repository and is not stage 3; the map puts
 * it at stage 7 at the earliest. The temptation that follows from that is to write
 * the relay against a stub of Centrifugo's API and call the relay done — which
 * proves nothing, because the interesting property of the relay is not *what* it
 * calls, it is **that it keeps going when the call fails and that a kill mid-batch
 * loses nothing**. Both are properties of the loop, and both are only testable if
 * the destination is something a test can make fail on purpose.
 *
 * So the seam is deliberately the smallest one that carries those two properties:
 *
 *     publish(frame, context) → Promise<void>
 *
 * One method, and **throwing is the only failure signal.** There is no status code,
 * no result object, no `accepted: boolean`. A sink that returns normally has
 * accepted the frame; a sink that throws has not. Every branch in the relay is a
 * branch on that, and a sink implementation cannot express a third state that the
 * relay would then have to guess about — which is how "did it publish?" becomes an
 * unanswerable question two layers down.
 *
 * ── why `context` exists, and what it must not become ─────────────────────────
 *
 * The frame already says which conversation it belongs to (ADR 0011), so a sink
 * needs nothing else to route it. `context` is there for **diagnostics**: which
 * outbox row this publish is, so a log line names the row an operator can go and
 * look at, and so a test can say "the third frame of the batch" without guessing
 * from a timestamp.
 *
 * It is deliberately NOT a channel name, a shard, or a routing decision. Deciding
 * where a frame goes is the sink's job; a context object that carried the answer
 * would move that decision back into the relay, which is the wrong side of the one
 * interface this file owns.
 */
import type { ServerFrame } from '@vartalap/protocol';

/**
 * What the sink is told about the row it is publishing, beyond the frame itself.
 *
 * Every field is a fact already in the table — this is a join of two columns the
 * relay read in the same statement, not new information and not authority. A sink
 * that disagrees with the row it was given has a bug; the relay is the only thing
 * that reads the row.
 */
export interface SinkContext {
  /** `outbox.id`. The row that becomes `published_at` if this call returns. */
  readonly outboxId: number;
  /**
   * `outbox.message_seq`, and therefore the frame's position — **or `null` for a
   * frame that is not about a message.**
   *
   * Nullable because `outbox.message_seq` is: the outbox carries receipt advances and
   * delivery acks as well as messages (ADR 0003, ADR 0011), and neither has a
   * position. `null` says "this row publishes a frame with no message behind it" and
   * is NOT a failure — the routing column is `conversation_id`, which is `NOT NULL` for
   * every frame type.
   *
   * It is `null` exactly when the frame carries no message, and it is never `null` for
   * a `message.created`: the database says so (`outbox_message_created_needs_message_seq`).
   */
  readonly messageSeq: number | null;
  /** `outbox.conversation_id`. Denormalised on the row; equals the frame's. */
  readonly conversationId: string;
}

/**
 * The destination. One method, and ADR 0057's guarantee is a property of the
 * **caller**, not of this: at-least-once means the relay may call `publish` twice
 * for the same row, and a sink must therefore tolerate a duplicate frame. Centrifugo
 * does — it is a fan-out, not a queue with a cursor — and so does the recording
 * sink below, which appends.
 *
 * ⚠️ **Do not add deduplication here, and do not add it to the relay either.** The
 * tempting fix for "the relay might publish twice" is a seen-set, an idempotency key
 * on the publish call, or a `published_at` check that is not `IS NULL`. All three
 * are the exactly-once machinery ADR 0057 explicitly rejected, and the reason is
 * that they cannot close the gap anyway: a relay killed after the sink accepted and
 * before the transaction committed cannot know whether it published, so any
 * "have I published this?" check either guesses (and can drop a frame nobody will
 * ever detect missing) or asks the sink (and needs exactly the broker-side state
 * that does not exist yet).
 *
 * **The duplicates are the price of not losing messages, and the client already pays
 * them.** `message.id` is a client-generated UUIDv7 that is simultaneously the
 * identity and the idempotency key (ADR 0004/0005), and stage 3.G requires one
 * receive write path — live frame, catch-up row, own-echo — that **upserts** on it.
 * A duplicate frame that upserts is free. An at-most-once relay that drops one frame
 * is a silent hole. See ADR 0057, "The delivery guarantee is at-least-once,
 * deliberately".
 */
export interface PublishSink {
  /**
   * Publish one frame.
   *
   * Resolve ⇒ accepted. Reject ⇒ **not** accepted, and the relay leaves `published_at`
   * NULL, increments `attempts` and records the error. Rejecting is therefore a
   * promise to the relay that nothing was delivered; a sink that swallows an error
   * and resolves has converted at-least-once into at-most-once, which is the one
   * failure mode this architecture cannot detect.
   *
   * May be called more than once for the same frame. Must not throw for a reason
   * the relay should treat as anything other than "not delivered".
   */
  publish(frame: ServerFrame, context: SinkContext): Promise<void>;
}

/** One call the recording sink saw. */
export interface RecordedPublish {
  readonly frame: ServerFrame;
  readonly context: SinkContext;
}

/**
 * A sink that remembers instead of sending.
 *
 * **This is a stand-in, and it is standing in for a component that does not exist.**
 * There is no Centrifugo in this repository; the real sink is unwritten and lands
 * with stage 7. What `recordingSink` buys is that the relay's whole contract becomes
 * assertable without one: that it publishes the stored frame verbatim, that it
 * publishes each row at most once per successful poll, that a refusal marks that
 * row and only that row, and that a batch whose transaction never committed is
 * delivered again.
 *
 * Four of those five are about the database rather than the destination, which is
 * the point ADR 0057 makes — "the guarantee above is a property of the relay loop,
 * not of any broker". The fifth, publishing each row once, is the only one that
 * depends on the destination, and it is asserted against this.
 *
 * It never throws. A sink that refuses rows is a *test's* decision, not this
 * object's: production behaviour belongs to the real broker client, and a
 * permanently-failing recording sink in `src/` would be a testing affordance wearing
 * a production label.
 */
export interface RecordingSink extends PublishSink {
  /** Every call, in the order they happened. Duplicates included — deliberately. */
  readonly calls: readonly RecordedPublish[];
  /** Just the frames, in publish order. The readable view for assertions. */
  readonly frames: readonly ServerFrame[];
  readonly count: number;
}

/**
 * The implementation of {@link PublishSink} used when there is nowhere to publish to.
 *
 * Appends and resolves. `ServerFrame` is frozen on the way in so a sink bug that
 * mutates a frame cannot silently change what a later assertion sees — the frame is
 * the same object the client will receive, and two callers holding a mutable copy of
 * it is two sources of truth.
 */
export function recordingSink(): RecordingSink {
  const calls: RecordedPublish[] = [];

  return {
    async publish(frame, context) {
      calls.push({ frame: Object.freeze(structuredClone(frame)) as ServerFrame, context: Object.freeze({ ...context }) });
    },
    get calls() {
      return [...calls];
    },
    get frames() {
      return calls.map((call) => call.frame);
    },
    get count() {
      return calls.length;
    },
  };
}
