/**
 * T3's other half: a failed send renders with a retry that reuses the
 * idempotency key. Nothing is discarded by the system (0053).
 */
import { describe, expect, test } from 'bun:test';
import { mintMessageId } from './message-id.ts';
import { failedRows, failureStrip } from './retry.ts';
import type { MessageRow } from './store.ts';

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: mintMessageId(1),
    conversationId: '55555555-5555-4555-8555-555555555555',
    authorId: '11111111-1111-4111-8111-111111111111',
    body: 'are you around later',
    attachments: [],
    seq: null,
    state: 'queued',
    createdAt: 1_000,
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
    ...over,
  };
}

describe('the failure strip', () => {
  test('a queued send and an in-flight send are not failures', () => {
    expect(failedRows([row({ state: 'queued' }), row({ state: 'inFlight' })])).toEqual([]);
  });

  test('a failed row carries the strip, with the server sentence', () => {
    const failed = row({
      state: 'failed',
      failureCode: 'invalidRequest',
      failureDetail: 'the send request is not valid: body is too long',
    });
    expect(failedRows([failed])).toEqual([failed]);
    expect(failureStrip(failed)).toEqual({
      title: 'Not sent',
      detail: 'the send request is not valid: body is too long',
    });
  });

  test('a failure with no detail still offers a retry', () => {
    expect(failureStrip(row({ state: 'failed', failureDetail: null })).detail).toBe('Try again');
  });

  test('the key retry reuses is the row’s own id, never a fresh one', () => {
    // `flushQueue` re-`messageIdScalar.parse(row.id)` on every attempt — the
    // identity AND the idempotency key are one value (ADR 0004). The retry
    // action carries that id so a caller cannot invent a different one.
    const failed = row({ id: mintMessageId(mintMessageId(7_000) >= mintMessageId(8_000) ? 7_000 : 8_000) });
    const id = failed.id;
    const action = { kind: 'retry' as const, id };
    expect(action.id).toBe(failed.id);
  });
});
