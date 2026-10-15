import { z } from 'zod';
import { conversationId, mediaId, messageId, seq, userId, handle, type Seq } from './scalars.ts';
import { attachment, member, message, sendPermission, type Message } from './conversation.ts';

/**
 * Reading, delivery and presence — three signals with different clocks, different
 * durability, and different rules about who may see them.
 *
 * The property that catches people: **a receipt has TWO positions** (ADR 0010).
 * `readThrough` always advances and is yours alone. `sharedThrough` advances only
 * while you are sharing, and "Seen" is computed over it. A single boolean cannot
 * express "frozen at where it was when I turned sharing off", and getting that wrong
 * reveals the entire gap the member spent hiding the moment they turn it back on.
 */
export const receipt = z.object({
  conversationId,
  userId,
  /** Always advances when the conversation is opened. Drives YOUR unread count. */
  readThrough: seq,
  /** Advances only while sharing. What everyone else's "Seen" reads. */
  sharedThrough: seq,
  sharing: z.boolean(),
});

export type Receipt = z.infer<typeof receipt>;

export const delivery = z.object({
  conversationId,
  userId,
  /** Set when a frame arrived and was persisted. Any ONE device is enough. */
  deliveredThrough: seq,
});

export type Delivery = z.infer<typeof delivery>;

/**
 * Presence is a fact about a CONNECTION, never about a running timer. Browsers
 * throttle JavaScript timers in background tabs, so a client heartbeat reports a
 * user offline while they are sitting right there — the worst failure a green dot
 * can have. WebSocket keepalives run at the protocol level and are not throttled.
 *
 * Resolution: 45 seconds. "Connected now" means connected within the last 45
 * seconds, and the glossary says so. See ADR 0006.
 */
export const presence = z.object({
  userId,
  online: z.boolean(),
});

export type Presence = z.infer<typeof presence>;

/**
 * Typing is a user gesture that expires — never durable. A frame carries when it
 * was emitted so a receiver can discard one older than its expiry; if typing were
 * stored, a reconnect would faithfully replay "Priya was typing" from last Tuesday
 * and it would stop being a hint. See ADR 0006 and the concept doc.
 */
export const typing = z.object({
  conversationId,
  userId,
  /** Milliseconds since epoch — used only to discard a stale frame. */
  at: z.number().int().nonnegative(),
});

export type Typing = z.infer<typeof typing>;

/**
 * "Seen", derived and never stored:
 *
 *   Seen under M  ⇔  ∀ m ∈ currentMembers(M), m ≠ me, shares(m):
 *                       receipt[m].sharedThrough >= seq(M)
 *
 * Nothing in the schema says "under the last outgoing message" — it falls out,
 * because a member's own sends never advance their own receipt.
 */
export const seenUnder = z.object({
  conversationId,
  /** The message the marker hangs under. Always an outgoing message. */
  messageId: messageId,
  at: seq,
});

export type SeenUnder = z.infer<typeof seenUnder>;

/** The unread count is derived from the receipt, never stored (GLOSSARY). */
export const unreadCount = z.object({
  conversationId,
  count: z.number().int().nonnegative(),
});

export type UnreadCount = z.infer<typeof unreadCount>;

/**
 * Blobs are what Centrifugo carries. Every field is redundant on purpose: a frame
 * that must be routed to a channel needs to say which conversation it belongs to,
 * because `packages/protocol` is shared with a native client that may not share our
 * channel model, and a frame that does not say where it goes is a bug that can only
 * appear on a platform nobody has built yet. See ADR 0011.
 */
export const serverFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.created'), conversationId, message }),
  z.object({ type: z.literal('message.ack'), conversationId, messageId, seq }),
  z.object({ type: z.literal('receipt.advanced'), conversationId, userId, readThrough: seq, sharedThrough: seq }),
  z.object({ type: z.literal('presence.changed'), userId, online: z.boolean() }),
  z.object({ type: z.literal('typing.started'), conversationId, userId, at: z.number().int().nonnegative() }),
  z.object({ type: z.literal('typing.stopped'), conversationId, userId }),
]);

export type ServerFrame = z.infer<typeof serverFrame>;

export const clientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delivery.acked'), conversationId, seq }),
  z.object({ type: z.literal('receipt.advanced'), conversationId, readThrough: seq, sharedThrough: seq }),
  z.object({ type: z.literal('presence.heartbeat'), at: z.number().int().nonnegative() }),
  z.object({ type: z.literal('typing.started'), conversationId, at: z.number().int().nonnegative() }),
  z.object({ type: z.literal('typing.stopped'), conversationId }),
]);

export type ClientFrame = z.infer<typeof clientFrame>;

/**
 * Sending is an HTTP POST, not a socket frame. A socket write has no defined
 * failure: if the connection drops mid-emit the client cannot tell whether the
 * message landed, and every retry is a coin flip. See ADR 0004.
 *
 * `POST /api/conversations/{conversationId}/messages` — and `conversationId` is in
 * the body AS WELL AS the path. That looks like waste and is the same argument that
 * puts the conversation on every frame: a payload that does not say which
 * conversation it belongs to is a bug that can only ever appear on a platform nobody
 * has built yet, because the router would have had to fill it in.
 *
 * The body's `id` is the message id AND the idempotency key. Re-sending it with the
 * same content returns 200 with the original (including its `seq`); re-sending it
 * with DIFFERENT content is a buggy client and gets a 409, because that is the one
 * case where being lenient hides a real bug. What "the same content" means — the
 * four compared fields — is decided in ADR 0059 and lives in `sendConflictField`.
 */
export const sendMessageRequest = z.object({
  conversationId,
  id: messageId,
  body: z.string().max(8192),
  attachments: z.array(attachment),
});

export type SendMessageRequest = z.infer<typeof sendMessageRequest>;

export const sendMessageResponse = z.object({
  message,
  /** True when this was a retry of an already-accepted send. */
  deduplicated: z.boolean(),
});

export type SendMessageResponse = z.infer<typeof sendMessageResponse>;

/**
 * Fifty rows is roughly a screen and a half of a busy conversation. The exact
 * number matters less than it being a constant — a client cannot ask for a
 * different page size, because a size it negotiated with one endpoint and not
 * another is a gap it has to explain.
 */
export const PAGE_SIZE = 50;

/**
 * Catch-up and history. Backwards is history; forwards is what a member scrolled up
 * in the middle of a conversation needs in order to reach the present. Both keyset,
 * never OFFSET — under concurrent inserts, page three is not the same fifty rows it
 * was a second ago. See ADR 0005.
 */
export const historyQuery = z.object({
  conversationId,
  /** Omit for the newest page. */
  before: seq.optional(),
  /** Omit to page towards the present. */
  after: seq.optional(),
  limit: z.number().int().min(1).max(100).default(PAGE_SIZE),
});

export type HistoryQuery = z.infer<typeof historyQuery>;

export const historyPage = z.object({
  messages: z.array(message),
  /** The conversation's current max position — lets a client assert it is caught up. */
  latestSeq: seq,
  /** Authoritative count, so a client can detect a permanently skipped row. */
  totalCount: z.number().int().nonnegative(),
});

export type HistoryPage = z.infer<typeof historyPage>;

/**
 * Reconnect. ONE cursor for the whole account, and that is the entire payoff of
 * `seq` being a single global column: positions compare across conversations, so
 * catching up is one query rather than one per conversation (ADR 0005).
 *
 * Note what this does NOT carry: a `conversationId`. A per-conversation catch-up is
 * the design ADR 0005 replaced, and a schema that still asked for one would let it
 * back in.
 */
export const catchUpQuery = z.object({
  /**
   * The account cursor — the global position the client has durably persisted PAST.
   * Required, not optional: a client with no cursor has nothing to catch up, and
   * `'0'` is the honest way to say "everything from the beginning".
   *
   * It advances only past rows that were actually persisted. A frame that failed to
   * write must not move it, or the gap becomes silent and permanent.
   */
  after: seq,
  limit: z.number().int().min(1).max(100).default(PAGE_SIZE),
});

export type CatchUpQuery = z.infer<typeof catchUpQuery>;

export const catchUpPage = z.object({
  messages: z.array(message),
  /**
   * The newest position visible to this member across every conversation they can
   * see, so the loop can stop as soon as the cursor reaches it instead of asking
   * for one more page that comes back short.
   */
  latestSeq: seq,
});

export type CatchUpPage = z.infer<typeof catchUpPage>;

/**
 * The two write frames, as REST bodies. Both already exist as socket frames, and
 * both need an HTTP equivalent because the spine has to be testable without a
 * socket — a receipt advance that can only be driven by a live connection is a
 * receipt advance that is never tested.
 *
 * ⚠️ `readThrough`, `sharedThrough` and `deliveredThrough` are ABSOLUTE positions,
 * never deltas, and this is the only thing in the protocol that would break
 * silently if it changed. `GREATEST` in the upsert is what absorbs out-of-order
 * arrival, two tabs racing, a send queue flushing after a reload, and a device clock
 * jumping backwards — and it absorbs all four ONLY because the client states where
 * it has got to. On deltas the same code still runs and quietly stops working.
 * ADR 0010 records this because the dependency is invisible.
 *
 * `sharing` is not here on purpose: it is a settings change with its own transport
 * (ADR 0022), not an advance.
 */
export const deliveryAckRequest = z.object({
  conversationId,
  /** Absolute. Named for `delivery.delivered_through`; the socket frame calls it `seq`. */
  deliveredThrough: seq,
});

export type DeliveryAckRequest = z.infer<typeof deliveryAckRequest>;

export const receiptAdvanceRequest = z.object({
  conversationId,
  /**
   * Absolute. Always advances. Drives the member's own unread count.
   *
   * ⚠️ **`read_through` is the sending member's OWN position and must never gate a
   * predicate another member observes.** It exists so that member can compute their
   * own unread count, and that is the only reader it has. Anything another member
   * can see is computed over `shared_through` — the indicator that prints `Seen`
   * reads `shared_through` and nothing else (ADR 0010, ADR 0003).
   *
   * The consequence is not a style rule. `read_through` keeps advancing while
   * sharing is off — it has to, or the unread count breaks — so it is always AHEAD
   * of where the member left off, and broadcasting it would reveal the entire gap
   * they spent the time hiding. That is the exact failure the second stored
   * position exists to prevent, and a single convenient field that looks like a
   * position is how it gets reintroduced.
   */
  readThrough: seq,
  /**
   * Absolute. Advances only while sharing, and resumes from its frozen value.
   * See the warning above.
   */
  sharedThrough: seq,
});

export type ReceiptAdvanceRequest = z.infer<typeof receiptAdvanceRequest>;

export const directConversationRequest = z.object({
  /** The other member's Handle. Normalized before lookup. */
  handle: handle,
  displayName: z.string().min(1).max(64).optional(),
});

export type DirectConversationRequest = z.infer<typeof directConversationRequest>;

export const conversationListItem = z.object({
  conversationId,
  kind: z.enum(['direct', 'group']),
  title: z.string().nullable(),
  lastSeq: seq,
  unreadCount: z.number().int().nonnegative(),
  muted: z.boolean(),
  presence: z.array(presence),
  /** Peer members — used to derive a direct conversation's title, never stored. */
  peers: z.array(member).optional(),
  permission: sendPermission,
});

export type ConversationListItem = z.infer<typeof conversationListItem>;

export const mediaRequest = z.object({
  mediaId,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1),
  /** ADVISORY ONLY. R2 cannot enforce this at signing — the worker is the only gate. */
  sizeBytes: z.number().int().positive(),
});

export type MediaRequest = z.infer<typeof mediaRequest>;

export const mediaState = z.enum(['pending', 'ready', 'failed']);
export type MediaState = z.infer<typeof mediaState>;

export { seq, messageId, mediaId, conversationId, userId, handle };