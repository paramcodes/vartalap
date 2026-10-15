/**
 * Optimistic send: steps 1–4 of `composer-and-sending.md`, and the queue they
 * leave behind.
 *
 * The property under test is a timing property, which makes it awkward to assert
 * directly: **the row is durable before any network call exists**. So the
 * assertions are about what the store holds the instant `queueSend` resolves — and
 * `queueSend` cannot reach the network, because it does not hold a transport.
 *
 *     bun test apps/web
 */
import { describe, expect, test } from 'bun:test';
import { seq as seqScalar, type ConversationId, type ErrorBody, type UserId } from '@vartalap/protocol';
import { FakeTransport } from './fake-transport.ts';
import { mintMessageId } from './message-id.ts';
import { transcript } from './render.ts';
import { BACKOFF_LADDER, backoffDelay, canSend, flushQueue, queueSend } from './send.ts';
import { createStore, type MessageStore } from './store.ts';

const CONVERSATION = '2b1c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' as ConversationId;
const ME = '4d3e5f60-7182-4a9d-a0e1-2b3c4d5e6f70' as UserId;
const ALLOWED = { allowed: true } as const;

const CLOCK = 1_760_000_000_000;

/** `Seq` is branded; this is the protocol tests' own one-liner for comparing to one. */
const S = (value: string) => seqScalar.parse(value);

let databases = 0;
async function freshStore(): Promise<MessageStore> {
  databases += 1;
  return createStore(`vartalap-send-${databases}`).open();
}

const send = (store: MessageStore, text: string, now = CLOCK) =>
  queueSend({ store, conversationId: CONVERSATION, authorId: ME, permission: ALLOWED, text, now });

// ═══════════════════════════════════════════════════════════════════════════

describe('step 1 — canSend', () => {
  test('an empty body is not sendable, and the send button is disabled for it', () => {
    // A held Enter key sends an empty string the moment the composer clears.
    expect(canSend({ permission: ALLOWED, text: '' })).toEqual({ allowed: false, reason: 'empty' });
    expect(canSend({ permission: ALLOWED, text: '   ' })).toEqual({ allowed: false, reason: 'empty' });
  });

  test('a ready attachment is sendable on its own, and an unready one is nothing', () => {
    // ADR 0052: pressing send sends the text and every attachment that is READY.
    // A tile still uploading stays in the tray and is not part of the payload.
    expect(canSend({ permission: ALLOWED, text: '', readyAttachmentCount: 1 })).toEqual({ allowed: true });
    expect(canSend({ permission: ALLOWED, text: '', readyAttachmentCount: 0 })).toEqual({
      allowed: false,
      reason: 'empty',
    });
  });

  test('a locked conversation names WHY, and the four reasons stay distinct', () => {
    // `blocked_by_me` and `blocked_by_them` say opposite things and the composer's
    // copy depends on which, so a boolean would throw away the answer.
    for (const reason of ['blocked_by_me', 'blocked_by_them', 'not_a_member', 'too_many_members'] as const) {
      expect(canSend({ permission: { allowed: false, reason }, text: 'hello' })).toEqual({
        allowed: false,
        reason,
      });
    }
    // And a permission is consulted before the body: a stranger gets told they
    // cannot write here rather than that their composer is empty.
    expect(canSend({ permission: { allowed: false, reason: 'not_a_member' }, text: '' })).toEqual({
      allowed: false,
      reason: 'not_a_member',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('steps 2–4 — the local write, before any network call', () => {
  test('the row exists with seq null, state queued, and the draft is gone', async () => {
    const store = await freshStore();
    await store.setDraft(String(CONVERSATION), 'what I was typing', CLOCK - 5_000);

    const outcome = await send(store, 'what I was typing');
    expect(outcome.kind).toBe('queued');

    const rows = await store.queuedSends();
    expect(rows).toHaveLength(1);
    // `sent` is `seq !== null` and is NOT stored (ADR 0060). A provisional
    // position interpolated from client time would make this row MOVE once the
    // server answered, and "a message that visibly moves reads as a bug even
    // when it is behaving correctly".
    expect(rows[0]?.seq).toBeNull();
    expect(rows[0]?.state).toBe('queued');
    expect(rows[0]?.body).toBe('what I was typing');

    // The draft cleared in the SAME transaction as the row. Not on success — a
    // send can fail, and a member who watched their text vanish into a bubble
    // marked `Not sent` is a loss they will not forgive (ADR 0049).
    expect(await store.draftFor(String(CONVERSATION))).toBeUndefined();
  });

  test('one UUIDv7 is the identity AND the idempotency key, and every retry reuses it', async () => {
    const store = await freshStore();
    // One refusal, so the first attempt stays queued and there IS a retry to make.
    const transport = new FakeTransport({ authorId: String(ME) }).failNext({
      code: 'unauthenticated',
      message: 'sign in',
      retryable: true,
    });
    const outcome = await send(store, 'once');
    if (outcome.kind !== 'queued') throw new Error('the send was refused');

    // A real v7, because `messageId` refuses anything else at the boundary.
    expect(outcome.id[14]).toBe('7');

    await flushQueue(store, transport, { now: () => CLOCK });
    await flushQueue(store, transport, { now: () => CLOCK + 10_000_000 });

    // Both requests carried the SAME key. That is the only reason a retry is safe
    // rather than a second message, and it is what makes the server answer `200`
    // with the original row and its position.
    expect(transport.sentRequests).toHaveLength(2);
    expect(transport.peekSent(0)?.id).toBe(outcome.id);
    expect(transport.peekSent(1)?.id).toBe(outcome.id);
    // And the content did not change between them — `composer-and-sending.md`'s
    // "Nothing is ever partially dropped, and nothing is edited".
    expect(transport.peekSent(1)?.body).toBe('once');
  });

  test('nothing is written at all when the send is refused', async () => {
    const store = await freshStore();
    await store.setDraft(String(CONVERSATION), 'unsent text', CLOCK);

    const outcome = await queueSend({
      store,
      conversationId: CONVERSATION,
      authorId: ME,
      permission: { allowed: false, reason: 'blocked_by_them' },
      text: 'hello',
      now: CLOCK,
    });

    expect(outcome).toEqual({ kind: 'refused', reason: 'blocked_by_them' });
    // A member who pressed send in a locked conversation must not lose the draft.
    expect((await store.draftFor(String(CONVERSATION)))?.text).toBe('unsent text');
    expect(await store.queuedSends()).toHaveLength(0);
  });

  test('the send queue is a QUERY over the one table, and it empties when it succeeds', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) });

    const first = await send(store, 'one');
    const second = await send(store, 'two', CLOCK + 1);
    expect(await store.queuedSends()).toHaveLength(2);
    expect((await store.rowsFor(String(CONVERSATION))).length).toBe(2);

    await flushQueue(store, transport, { now: () => CLOCK + 100 });

    // Same table, same rows — the rows did not MOVE anywhere. A committed message
    // carries `state: null`, and IndexedDB does not index `null`, so it has left
    // the `state` index and cannot appear in the queue.
    expect(await store.queuedSends()).toHaveLength(0);
    const rows = await store.rowsFor(String(CONVERSATION));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seq).sort()).toEqual([S('1'), S('2')]);
    expect(rows.every((row) => row.state === null)).toBe(true);
    expect(first.kind).toBe('queued');
    expect(second.kind).toBe('queued');
  });

  test('an in-flight row survives a reload, and reclaims itself', async () => {
    // A reload kills every POST the browser had open. A row left `inFlight` would
    // sit in the queue forever looking like a request that is still running — and
    // the send queue is supposed to outlive a page reload (GLOSSARY).
    const store = await freshStore();
    await send(store, 'interrupted');
    await store.markInFlight((await store.queuedSends())[0]!.id);
    expect(await store.queuedSends()).toHaveLength(0);

    expect(await store.reclaimInFlight()).toBe(1);
    expect(await store.queuedSends()).toHaveLength(1);
    // The idempotency key was untouched, so the retry is recognised rather than
    // duplicated — including if the original request DID land.
    expect((await store.queuedSends())[0]?.attempts).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('step 6 — flushing, and the retry classification', () => {
  const rateLimited: ErrorBody = { code: 'rateLimited', message: 'slow down', retryable: true, retryAfterSeconds: 4 };
  const conflict: ErrorBody = { code: 'idempotencyConflict', message: 'key reused', retryable: false, conflictingFields: ['body'] };
  const unauthenticated: ErrorBody = { code: 'unauthenticated', message: 'sign in', retryable: true };

  test('a retryable refusal backs off and stays queued, forever', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).failNext(unauthenticated);
    const outcome = await send(store, 'waiting');
    if (outcome.kind !== 'queued') throw new Error('the send was refused');

    await flushQueue(store, transport, { now: () => CLOCK, random: () => 0.5 });

    // Still queued, still visible, still the member's message. `401` is retryable
    // because the message is fine and re-authentication re-flushes the queue.
    const rows = await store.queuedSends();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(outcome.id);
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.nextAttemptAt).toBe(CLOCK + 1_000);

    // And a row that is not due is not sent — the backoff means something.
    const later = await flushQueue(store, transport, { now: () => CLOCK + 500 });
    expect(later.accepted).toHaveLength(0);
    expect(later.notDue).toBe(1);
    expect(transport.sentRequests).toHaveLength(1);
  });

  test('`Retry-After` is honoured AND resets the ladder', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).failNext(rateLimited, rateLimited, rateLimited);
    await send(store, 'throttled');

    await flushQueue(store, transport, { now: () => CLOCK, random: () => 0.5 });
    expect((await store.queuedSends())[0]?.nextAttemptAt).toBe(CLOCK + 4_000);
    // The server answered, so this was a policy refusal and not a struggling
    // network: the ladder starts again rather than climbing to the cap.
    expect((await store.queuedSends())[0]?.attempts).toBe(0);

    await flushQueue(store, transport, { now: () => CLOCK + 4_000, random: () => 0.5 });
    expect((await store.queuedSends())[0]?.attempts).toBe(0);
  });

  test('a terminal refusal is `failed`, visible, and never discarded', async () => {
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) }).failNext(conflict);
    const outcome = await send(store, 'the bytes that were rejected');
    if (outcome.kind !== 'queued') throw new Error('the send was refused');

    const report = await flushQueue(store, transport, { now: () => CLOCK });
    expect(report.failed).toEqual([outcome.id]);

    // Still in the table. The member is looking at a bubble marked `Not sent`
    // with `Try again` and `Delete` — a message somebody pressed send on is never
    // discarded by the system.
    const row = await store.messageById(outcome.id);
    expect(row?.state).toBe('failed');
    expect(row?.seq).toBeNull();
    expect(row?.failureCode).toBe('idempotencyConflict');
    expect(row?.failureDetail).toContain('key reused');
    // And it has LEFT the send queue: retrying a client bug cannot help.
    expect(await store.queuedSends()).toHaveLength(0);
  });

  test('no timeout anywhere converts a queued send into a failed one', async () => {
    // Rejected by the composer document and worth a test: a message that has been
    // waiting two days has not failed, it has not been ANSWERED, and rendering it
    // as an error states something the system does not know.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) });
    const outcome = await send(store, 'two days old');
    if (outcome.kind !== 'queued') throw new Error('the send was refused');
    await flushQueue(store, transport, { now: () => CLOCK });
    await store.releaseToQueued(outcome.id, Number.MAX_SAFE_INTEGER);

    const rows = await store.queuedSends();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('queued');
    expect(rows[0]?.failureCode).toBeNull();
  });

  test('the backoff ladder is the documented one, capped, with ±20% jitter', () => {
    // Judgement, not measurement — `composer-and-sending.md` says so itself.
    expect(BACKOFF_LADDER).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 60_000]);

    // `random` is the injection point, so the bounds are exact rather than flaky.
    expect(backoffDelay(0, 0)).toBe(800);
    expect(backoffDelay(0, 0.5)).toBe(1_000);
    expect(backoffDelay(0, 0.999)).toBe(1_200);
    expect(backoffDelay(5, 0.5)).toBe(60_000);
    // Capped: a hundred failures still back off one minute.
    expect(backoffDelay(100, 0.5)).toBe(60_000);
    // And every rung is inside ±20% of its nominal value.
    for (const [index, rung] of BACKOFF_LADDER.entries()) {
      for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = backoffDelay(index, random);
        expect(delay).toBeGreaterThanOrEqual(rung * 0.8);
        expect(delay).toBeLessThanOrEqual(rung * 1.2);
      }
    }
  });

  test('a deduplicated retry answers with the original row and its position', async () => {
    // ADR 0059's middle row — the ordinary case, a retry after a timeout where the
    // first request probably succeeded. The client reconciles from its own response
    // rather than waiting for an echo of itself.
    const store = await freshStore();
    const transport = new FakeTransport({ authorId: String(ME) });
    const outcome = await send(store, 'probably landed');
    if (outcome.kind !== 'queued') throw new Error('the send was refused');

    await flushQueue(store, transport, { now: () => CLOCK });
    // Put it back in the queue the way a reload would, and send it again.
    await store.releaseToQueued(outcome.id, 0);
    const second = await flushQueue(store, transport, { now: () => CLOCK });
    expect(second.accepted).toEqual([outcome.id]);

    expect(await store.rowsFor(String(CONVERSATION))).toHaveLength(1);
    expect((await store.messageById(outcome.id))?.seq).toBe(S('1'));
  });

  test('a position a JSON number could not carry still orders correctly', async () => {
    // `seq` is a decimal STRING on this side for the same reason it is on the wire:
    // a number above 2^53 loses precision with no error, and a position that stops
    // ordering is the failure this column exists to prevent. Two positions one
    // apart above 2^59 are the same JavaScript number, so this is the case where
    // a number-keyed store would put one message in the wrong place.
    const store = await freshStore();
    const at = (big: bigint, body: string) => ({
      id: mintMessageId(Number(big % 1_000_000n) + 1),
      conversationId: CONVERSATION,
      authorId: ME,
      body,
      attachments: [],
      seq: seqScalar.parse(big.toString()),
      createdAt: new Date(CLOCK).toISOString(),
    });

    const higher = at(2n ** 60n, 'higher');
    const lower = at(2n ** 60n - 1n, 'lower');
    expect(await store.applyReceived(higher)).toEqual({ persisted: true });
    expect(await store.applyReceived(lower)).toEqual({ persisted: true });

    expect(transcript(await store.rowsFor(String(CONVERSATION))).map((row) => row.body)).toEqual(['lower', 'higher']);
  });
});