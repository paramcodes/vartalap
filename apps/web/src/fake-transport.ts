/**
 * The transport double. **Tests only** — `store-structure.test.ts` fails if any
 * non-test file imports this.
 *
 * Why there is one at all: every test in `apps/web` runs headless against this
 * rather than against `apps/realtime`. That is what makes the package fast and
 * independent of a database, and it is also what keeps it clear of the sign-up
 * budget — Better Auth allows exactly three sign-ups per test run before
 * answering `429` (decision-index trap 17), and a client test that signed up per
 * test would die partway through on a limit that has nothing to do with what it
 * is testing.
 *
 * ── what this file is allowed to get wrong on purpose ──────────────────────
 *
 * It models the server's CONTRACT, not its implementation: positions are
 * allocated from one counter in ascending order, `totalCount` is a real `COUNT(*)`
 * over the conversation, a `before` page is descending and an `after` page is
 * ascending, and a repeated idempotency key answers `deduplicated: true` with the
 * original row.
 *
 * The one thing it will also do on demand is **lie**, and that is the point of
 * `skipOnCatchUp`: a permanently skipped row is a server or relay bug, and the
 * client's `COUNT(*)` net only exists to catch one. A double that cannot produce
 * the bug cannot prove the net detects it.
 */
import {
  catchUpPage as catchUpPageSchema,
  historyPage as historyPageSchema,
  message as messageSchema,
  messageId as messageIdScalar,
  seq as seqScalar,
  sendMessageResponse,
  type CatchUpPage,
  type CatchUpQuery,
  type ErrorBody,
  type HistoryPage,
  type HistoryQuery,
  type Message,
  type SendMessageRequest,
  type SendMessageResponse,
  type Seq,
} from '@vartalap/protocol';
import { compareSeq } from './store.ts';
import type { SendAnswer, Transport } from './transport.ts';

export interface SeedMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt?: string;
  /** Pin the position instead of taking the next one. Used to build a gap. */
  readonly seq?: number;
}

/**
 * Positions never served by `catchUp`, whatever the cursor. The shape of the
 * `message-lifecycle.md` §10 bug: a row the client should have received and never
 * will, while the pages around it arrive normally and the cursor sails past.
 */
export interface FakeTransportOptions {
  /** The member "sending" through this double. It is never taken from the body. */
  readonly authorId: string;
}

export class FakeTransport implements Transport {
  readonly #rows: { readonly seq: Seq; readonly message: Message }[] = [];
  readonly #authorId: string;
  #next = 1;
  readonly #gaps = new Set<string>();
  readonly #failures: ErrorBody[] = [];

  /** Every request this double was asked to make, for asserting on them. */
  readonly sentRequests: SendMessageRequest[] = [];
  readonly catchUpQueries: CatchUpQuery[] = [];
  readonly historyQueries: HistoryQuery[] = [];

  constructor(options: FakeTransportOptions) {
    this.#authorId = options.authorId;
  }

  /**
   * Put rows on the "server", assigning positions from one ascending counter —
   * the global sequence, which is the whole reason the client has one cursor.
   */
  seed(messages: readonly SeedMessage[]): this {
    for (const message of messages) {
      const seq = seqScalar.parse(String(message.seq ?? this.#next));
      this.#next = Math.max(this.#next, Number(seq) + 1);
      this.#rows.push({
        seq,
        message: messageSchema.parse({
          id: messageIdScalar.parse(message.id),
          conversationId: message.conversationId,
          authorId: message.authorId,
          body: message.body,
          attachments: [],
          seq,
          createdAt: message.createdAt ?? '2026-10-15T09:00:00.000Z',
        }),
      });
    }
    this.#rows.sort((left, right) => compareSeq(left.seq, right.seq));
    return this;
  }

  /** Make `catchUp` permanently skip these positions. `history` still serves them. */
  gap(...positions: readonly number[]): this {
    for (const position of positions) this.#gaps.add(String(position));
    return this;
  }

  /** Queue one refusal per send, in order. An empty queue accepts everything. */
  failNext(...errors: readonly ErrorBody[]): this {
    this.#failures.push(...errors);
    return this;
  }

  /** What a queued send was answered with, without sending it. */
  peekSent(index: number): SendMessageRequest | undefined {
    return this.sentRequests[index];
  }

  /** The wire Message sitting at a position, for driving the LIVE path. */
  messageAt(position: number): Message | undefined {
    return this.#rows.find((row) => String(row.seq) === String(position))?.message;
  }

  // ── the interface ─────────────────────────────────────────────────────────

  async sendMessage(request: SendMessageRequest): Promise<SendAnswer> {
    this.sentRequests.push(request);

    const refused = this.#failures.shift();
    if (refused !== undefined) return { kind: 'refused', status: 200, error: refused };

    // The dedupe the real server does: the primary key is the client's UUID, so a
    // retry cannot create a second message, and the answer carries the ORIGINAL
    // row including its position (ADR 0004, `message-lifecycle.md` §6).
    const existing = this.#rows.find((row) => row.message.id === request.id);
    if (existing !== undefined) return { kind: 'accepted', response: accepted(existing.message, true) };

    const seq = seqScalar.parse(String(this.#next));
    this.#next += 1;
    const message = messageSchema.parse({
      id: request.id,
      conversationId: request.conversationId,
      authorId: this.#authorId,
      body: request.body,
      attachments: request.attachments,
      seq,
      createdAt: request.clientCreatedAt ?? new Date().toISOString(),
    });
    this.#rows.push({ seq, message });
    this.#rows.sort((left, right) => compareSeq(left.seq, right.seq));
    return { kind: 'accepted', response: accepted(message, false) };
  }

  async catchUp(query: CatchUpQuery): Promise<CatchUpPage> {
    this.catchUpQueries.push(query);
    const after = Number(query.after);
    const visible = this.#rows.filter((row) => Number(row.seq) > after && !this.#gaps.has(String(row.seq)));
    return catchUpPageSchema.parse({
      messages: visible.slice(0, query.limit).map((row) => row.message),
      // With NO cursor applied, and ignoring the gap — a relay that drops a frame
      // still knows what the head is.
      latestSeq: seqScalar.parse(String(this.#rows[this.#rows.length - 1]?.seq ?? '0')),
    });
  }

  async history(query: HistoryQuery): Promise<HistoryPage> {
    this.historyQueries.push(query);
    const conversationId = String(query.conversationId);
    // The whole conversation, gaps included: `history` is a different query on the
    // server and it is what reconciliation reaches for.
    const conversation = this.#rows.filter((row) => String(row.message.conversationId) === conversationId);
    const latestSeq = seqScalar.parse(String(conversation[conversation.length - 1]?.seq ?? '0'));

    const forwards = query.after !== undefined;
    const cursor = forwards ? Number(query.after) : query.before === undefined ? Infinity : Number(query.before);
    const wanted = conversation
      .filter((row) => (forwards ? Number(row.seq) > cursor : Number(row.seq) < cursor))
      // Backwards is DESC — the real `readHistory` answers newest-first.
      .sort((left, right) => compareSeq(left.seq, right.seq) * (forwards ? 1 : -1));

    return historyPageSchema.parse({
      messages: wanted.slice(0, query.limit).map((row) => row.message),
      latestSeq,
      totalCount: conversation.length,
    });
  }
}

function accepted(message: Message, deduplicated: boolean): SendMessageResponse {
  return sendMessageResponse.parse({ message, deduplicated });
}