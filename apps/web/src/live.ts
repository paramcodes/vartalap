/**
 * Live frames, from the socket into the store.
 *
 * **This is call site one of three** for the one receive write path
 * (`message-lifecycle.md` §8, gate G3). The other two are a catch-up page row in
 * `catch-up.ts` and a send response in `send.ts`. `store-structure.test.ts` fails
 * the build if that stops being true, so "one write path" is a property of the
 * module graph rather than a thing somebody has to remember.
 *
 * There is no socket client here. Centrifugo lands in a later stage and the seam
 * is this function: whatever carries the frames calls it, and nothing else in
 * `apps/web` touches a frame.
 *
 * ── what does NOT come through here ────────────────────────────────────────
 *
 * **Presence and typing are never stored.** Not as an optimisation, not as a
 * fallback — `message-lifecycle.md` gives three reasons and they are what stop
 * somebody adding a `last_seen_at` for a settings screen in six months and
 * making the hard part unfixable without a migration. The stored value would be
 * wrong the instant it was written, and presence is not about a historical row.
 */
import {
  conversationId as conversationIdScalar,
  message as messageSchema,
  messageId as messageIdScalar,
  userId as userIdScalar,
  type Message,
  type ServerFrame,
} from '@vartalap/protocol';
import { type MessageRow, type ReceiveOutcome, type MessageStore } from './store.ts';

export type FrameOutcome =
  /** A Message was written — or refused, and `outcome` says so. */
  | { readonly kind: 'message'; readonly outcome: ReceiveOutcome }
  /** A Receipt advanced. Monotone, on both positions. */
  | { readonly kind: 'receipt' }
  /**
   * A delivery watermark moved. Stored monotone via `applyDelivery` — the local
   * copy of "she has it somewhere", which is what the sender's `Sent` renders
   * from. Keyed by member like `receipts`, one position and no branch, because
   * delivery is a fact about arrival rather than a disclosure (ADR 0010).
   */
  | { readonly kind: 'delivery' }
  /** Presence and typing. Never durable, so there is nothing to write. */
  | { readonly kind: 'ephemeral' }
  /**
   * `message.ack` named a message this browser does not hold. That is not an
   * error — it is an ack for a send from another tab, or one whose row was
   * discarded — and it is reported rather than thrown so the socket can carry on.
   */
  | { readonly kind: 'unknownMessage' };

/**
 * Write one live frame.
 *
 * `receipt.advanced` goes to `applyReceipt`, which is a different write with a
 * different justification: a Receipt is a member's record and is keyed by MEMBER,
 * not by message, so it is not a second message write path and it is not one.
 */
export async function receiveFrame(store: MessageStore, frame: ServerFrame): Promise<FrameOutcome> {
  switch (frame.type) {
    case 'message.created':
      return { kind: 'message', outcome: await store.applyReceived(frame.message) };

    case 'receipt.advanced':
      await store.applyReceipt(frame);
      return { kind: 'receipt' };

    case 'delivery.acked':
      await store.applyDelivery(frame);
      return { kind: 'delivery' };

    case 'message.ack': {
      /**
       * The third frame type that names a message, and the awkward one: it carries
       * `{ conversationId, messageId, seq }` and **no body**, so there is no
       * Message to hand the receive path.
       *
       * No server path emits it yet — the relay publishes `message.created`
       * verbatim (ADR 0057) — so this is the shape it will have to take. The
       * answer is to rebuild the wire Message from the row this browser already
       * holds and hand THAT to `applyReceived`, which is a read plus a reuse and
       * not a second write path. The alternative — a `positionAcknowledged(id,
       * seq)` method on the store — would be exactly the second write path gate
       * G3 exists to make impossible, and it would be one that wrote a position
       * with no body behind it.
       */
      const held = await store.messageById(String(frame.messageId));
      if (held === undefined) return { kind: 'unknownMessage' };
      return { kind: 'message', outcome: await store.applyReceived(rehydrate(held, String(frame.seq))) };
    }

    case 'presence.changed':
    case 'typing.started':
    case 'typing.stopped':
      return { kind: 'ephemeral' };
  }
}

/**
 * A held row plus a position, back into the wire shape `applyReceived` takes.
 *
 * Built through the schemas rather than cast, so a row whose fields have drifted
 * fails here instead of producing a frame-shaped object that writes the wrong
 * thing. The content is the client's OWN row — an update never rewrites content,
 * because editing is out of v1 and nothing arriving over the wire may change what
 * somebody wrote.
 */
function rehydrate(row: MessageRow, position: string): Message {
  return messageSchema.parse({
    id: messageIdScalar.parse(row.id),
    conversationId: conversationIdScalar.parse(row.conversationId),
    authorId: userIdScalar.parse(row.authorId),
    body: row.body,
    attachments: row.attachments,
    seq: position,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}