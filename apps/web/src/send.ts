/**
 * The send path, from the keystroke to the server's answer.
 *
 * `composer-and-sending.md` gives seven steps. This file owns 1–4 and 6–7, and
 * the interesting property is where it stops:
 *
 * | step | what | where |
 * |---|---|---|
 * | 1 | `canSend()` is consulted | here |
 * | 2 | one **UUIDv7** minted — identity *and* idempotency key | `message-id.ts` |
 * | 3 | the row is written with `seq: null`, `state: 'queued'` | `store.applyLocalSend`, in one transaction |
 * | 4 | the draft is cleared, **in the same transaction** | same |
 * | 5 | the composer empties | stage 6 — it reads the table, not this file |
 * | 6 | the `POST` is issued | `flushQueue` |
 * | 7 | `200` → the position is set, the row snaps into place | `flushQueue`, through the ONE receive path |
 *
 * **`queueSend` does not touch the network.** That is the whole reason the row is
 * durable: by the time a request exists, the member's message is already in
 * IndexedDB, so a closed tab, a dead network or a process kill costs a retry and
 * not a message. Step 5 — the composer emptying — is stage 6's, and stage 6 does
 * it by re-rendering from the table, because "the interface must render from the
 * table, not from local component state" (`message-lifecycle.md` §8, Tabs).
 *
 * ── the backoff ladder ─────────────────────────────────────────────────────
 *
 * `1s → 2s → 5s → 10s → 30s → 60s`, capped, **±20% jitter**, and every number in
 * it is engineering judgement — `composer-and-sending.md` says so itself and the
 * repo records unverified things as unverified. The jitter is not decoration: two
 * devices coming back onto the same connection at the same instant would otherwise
 * retry in lockstep and re-create the thundering herd the cap exists to prevent.
 *
 * ⚠️ **No timeout anywhere converts a queued send into a failed one.** A message
 * that has been waiting two days has not failed — it has not been ANSWERED, which
 * is a different thing, and rendering that as an error states something the system
 * does not know. The only terminal state is a definitive refusal the server
 * actually sent. `flushQueue` therefore never times a row out; it returns and lets
 * the caller come back.
 */
import {
  conversationId as conversationIdScalar,
  messageId as messageIdScalar,
  type Attachment,
  type ConversationId,
  type MessageId,
  type SendBlockReason,
  type SendPermission,
} from '@vartalap/protocol';
import { mintMessageId } from './message-id.ts';
import type { MessageStore } from './store.ts';
import type { Transport } from './transport.ts';

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1 — may this be sent at all?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Step 1's answer, and the two reasons there are two.
 *
 * `empty` is a composer guard, not a server one — a held Enter key sends an empty
 * string the moment the composer clears. The other four are `sendPermission`'s
 * and they are the server's to decide (ADR 0007); they are named here rather than
 * collapsed into a boolean because `blocked_by_me` and `blocked_by_them` say
 * opposite things and the composer's copy depends on which.
 */
export type CanSend =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'empty' | SendBlockReason };

/**
 * The one predicate, called from the send path AND from the composer, so the
 * disabled send button and the `Enter` handler can never disagree about whether
 * there is anything to send.
 *
 * Media is out of scope here, so `readyAttachmentCount` is a parameter rather
 * than a query: the rule it implements is *"pressing send sends the text and
 * every attachment that is ready"*, and the tray that owns "ready" is stage 6's.
 */
export function canSend(input: {
  readonly permission: SendPermission;
  readonly text: string;
  readonly readyAttachmentCount?: number;
}): CanSend {
  if (!input.permission.allowed) return { allowed: false, reason: input.permission.reason };
  const ready = input.readyAttachmentCount ?? 0;
  if (input.text.trim() === '' && ready === 0) return { allowed: false, reason: 'empty' };
  return { allowed: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// STEPS 2–4 — the local write. No network.
// ═══════════════════════════════════════════════════════════════════════════

export interface QueueSendInput {
  readonly store: MessageStore;
  readonly conversationId: ConversationId;
  /** The authenticated member. Never taken from the body. */
  readonly authorId: string;
  readonly permission: SendPermission;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  /** Injected so a test can pin the clock; production passes nothing. */
  readonly now?: number;
}

export type QueueSendOutcome =
  /** `id` is branded, because it is about to be both an identity and a key. */
  | { readonly kind: 'queued'; readonly id: MessageId }
  | { readonly kind: 'refused'; readonly reason: 'empty' | SendBlockReason };

/**
 * Steps 1–4. Returns as soon as the row is durable.
 *
 * **Step 2 mints ONE value and it does two jobs** — the message's identity and
 * its idempotency key. A retry of this send reuses it, which is the only reason
 * retrying is safe: the server recognises the repeat and answers `200` with the
 * original row and its position rather than creating a second message (ADR 0004,
 * `message-lifecycle.md` §6).
 *
 * **Nothing here writes a provisional position.** `seq` stays `null` until the
 * server assigns one, and there is no function in this package that could assign
 * one — which is what makes "a message that renders in one place and then visibly
 * moves" impossible rather than merely discouraged.
 *
 * Refused means **nothing was written**: not the row, not the draft. A member who
 * pressed send on an empty composer, or in a conversation they cannot write to,
 * must not lose what they had typed.
 */
export async function queueSend(input: QueueSendInput): Promise<QueueSendOutcome> {
  // Every attachment handed in is a ready one: the tray owns "ready" and a tile
  // that is still uploading stays in the tray (ADR 0052).
  const verdict = canSend({
    permission: input.permission,
    text: input.text,
    readyAttachmentCount: input.attachments?.length ?? 0,
  });
  if (!verdict.allowed) return { kind: 'refused', reason: verdict.reason };

  const id = mintMessageId(input.now ?? Date.now());

  // Steps 3 and 4, in ONE transaction. `applyLocalSend` is where that happens and
  // where the reason is written down.
  await input.store.applyLocalSend({
    id,
    conversationId: String(input.conversationId),
    authorId: input.authorId,
    body: input.text,
    attachments: input.attachments ?? [],
    createdAt: input.now ?? Date.now(),
  });

  return { kind: 'queued', id };
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 6–7 — flushing. Backoff, classification, and the ONE receive path.
// ═══════════════════════════════════════════════════════════════════════════

/** `1s → 2s → 5s → 10s → 30s → 60s`, capped. See the header: judgement, not data. */
export const BACKOFF_LADDER: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** `±20%`. The cap exists to stop a herd; the jitter is what keeps it a cap. */
const JITTER = 0.2;

/**
 * How long before the next attempt, given how many have already failed.
 *
 * `attempts` is the row's counter BEFORE this failure, so the first failure backs
 * off one second and the cap is reached after five. `random` is injected for the
 * test; it is expected in `[0, 1)`.
 */
export function backoffDelay(attempts: number, random: number = Math.random()): number {
  const index = Math.min(Math.max(attempts, 0), BACKOFF_LADDER.length - 1);
  const base = BACKOFF_LADDER[index] ?? 60_000;
  return Math.round(base * (1 - JITTER + random * JITTER * 2));
}

export interface FlushOptions {
  /** Injected so a test can pin the clock. */
  readonly now?: () => number;
  /** Injected so a test can pin the jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface FlushReport {
  readonly accepted: readonly string[];
  readonly retryScheduled: readonly string[];
  readonly failed: readonly string[];
  /** Rows the queue is holding that are not yet due. */
  readonly notDue: number;
}

/**
 * Flush the send queue: one request at a time, oldest queued send first.
 *
 * **Sequential, and that is a decision rather than a shortcut.** The server
 * serialises inserts within a conversation anyway (ADR 0005), so concurrency buys
 * nothing inside one conversation and buys a pile of interleaved failure states
 * across the whole queue. Stage 6 can parallelise per conversation if a queue ever
 * gets deep enough to notice; this unit proves the state machine.
 *
 * **Retryability is read off the envelope and never off a status code.** The
 * envelope carries it as a `z.literal` per branch precisely so a client cannot
 * mirror a status table the server can contradict (ADR 0059). A refusal marked
 * retryable leaves the row `queued`; a terminal one moves it to `failed`, where it
 * stays visible with `Not sent`, `Try again` and `Delete` — **a message somebody
 * pressed send on is never discarded by the system.**
 *
 * `401` is retryable and the row stays queued: re-authentication re-flushes the
 * queue, and the message is fine.
 */
export async function flushQueue(
  store: MessageStore,
  transport: Transport,
  options: FlushOptions = {},
): Promise<FlushReport> {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;

  const queued = await store.queuedSends();
  const accepted: string[] = [];
  const retryScheduled: string[] = [];
  const failed: string[] = [];
  let notDue = 0;

  for (const row of queued) {
    if (row.nextAttemptAt > now()) {
      notDue += 1;
      continue;
    }

    // The request is open. This is the state the composer renders at full opacity
    // with no text beside it, and it is the difference between "waiting for a
    // window" and "waiting for an answer".
    await store.markInFlight(row.id);

    const answer = await transport.sendMessage({
      // Re-branded at the boundary rather than stored branded. IndexedDB hands back
      // a plain `string`, and parsing on the way OUT means a corrupted local row
      // fails here instead of being POSTed as junk the server cannot read.
      conversationId: conversationIdScalar.parse(row.conversationId),
      // The identity AND the idempotency key, unchanged across every retry. One
      // value, two jobs (ADR 0004).
      id: messageIdScalar.parse(row.id),
      body: row.body,
      attachments: [...row.attachments],
      clientCreatedAt: new Date(row.createdAt).toISOString(),
    });

    if (answer.kind === 'accepted') {
      /**
       * Step 7, and **the third of the three call sites of the one receive write
       * path**. ADR 0059's middle row is why this exists rather than waiting for
       * an echo: a retry that the server recognises answers `200` with the
       * ORIGINAL row including its position, so the client reconciles from its own
       * response instead of hoping the socket remembers.
       *
       * `deduplicated` is deliberately not branched on. Both `200`s carry the same
       * row with its position, and the position is the only thing this store was
       * missing — whether the row was just created or recovered changes nothing
       * that is stored here.
       */
      const outcome = await store.applyReceived(answer.response.message);
      // A refused row is left `inFlight`. It is not silently retried and it is not
      // failed: the server sent a position this client could not record, and that
      // is `COUNT(*)` reconciliation's problem, not a member-facing one.
      if (outcome.persisted) accepted.push(row.id);
      continue;
    }

    if (answer.kind === 'unreachable') {
      /**
       * Ambiguous by construction: the message may well have committed and the
       * response was lost. Backing off and retrying is the only safe answer, and
       * the idempotency key is what makes it safe rather than a second message.
       */
      await store.releaseToQueued(row.id, now() + backoffDelay(await store.attemptsOf(row.id), random()));
      retryScheduled.push(row.id);
      continue;
    }

    if (answer.error.retryable) {
      // A `429` carrying `Retry-After` RESETS the ladder — the server answered, so
      // this was a policy refusal and not a struggling network.
      const retryAfter = answer.error.code === 'rateLimited' ? answer.error.retryAfterSeconds : undefined;
      if (retryAfter !== undefined) {
        await store.releaseToQueued(row.id, now() + retryAfter * 1_000);
        await store.resetAttempts(row.id);
      } else {
        await store.releaseToQueued(row.id, now() + backoffDelay(await store.attemptsOf(row.id), random()));
      }
      retryScheduled.push(row.id);
      continue;
    }

    // Terminal. `409`, `400`, `413`, `422` — the composer's own test is "could
    // retrying these identical bytes plausibly produce a different status?", and
    // for these the answer is no, forever.
    await store.markFailed(row.id, answer.error.code, detailOf(answer.error));
    failed.push(row.id);
  }

  return { accepted, retryScheduled, failed, notDue };
}

/**
 * The sentence the `Not sent` strip shows. **Never parsed** — it is for a human,
 * and `code` is what the machine reads.
 */
function detailOf(error: {
  readonly message: string;
  readonly fields?: readonly { readonly message: string }[] | undefined;
}): string {
  if (error.fields === undefined || error.fields.length === 0) return error.message;
  return `${error.message}: ${error.fields.map((field) => field.message).join('; ')}`;
}