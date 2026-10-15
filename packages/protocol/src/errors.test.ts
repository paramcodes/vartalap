/**
 * The error envelope, and the one question a send queue asks of every failure:
 * **retry, or give up?**
 *
 * `composer-and-sending.md` makes that distinction load-bearing — a retryable
 * failure backs off and stays queued, a terminal one becomes a visible `Not sent`
 * row the member can act on — and it forbids deciding it from the status code. So
 * these tests are mostly about proving the envelope REJECTS the answers that would
 * force a client back to status codes: a code claiming the wrong retryability, a
 * code nobody has heard of, a bare envelope with no `retryable` at all.
 *
 *     bun test packages/protocol
 */
import { describe, expect, test } from 'bun:test';
import {
  errorBody,
  errorEnvelope,
  sendConflictField,
  type ErrorBody,
} from './errors.ts';

/** Parse, and hand back the error branch so a failure names the offending code. */
function parse(body: unknown): ErrorBody {
  const result = errorBody.safeParse(body);
  if (!result.success) throw new Error(`rejected: ${JSON.stringify(result.error.issues)}`);
  return result.data;
}

const MESSAGE = 'something went wrong';

describe('retryable and terminal are distinguishable without a status code', () => {
  test('the two branches carry opposite `retryable` literals', () => {
    // The property, stated once and by value: a client reads `.retryable` and stops.
    const retryable = parse({ code: 'rateLimited', message: MESSAGE, retryable: true });
    const terminal = parse({
      code: 'idempotencyConflict',
      message: MESSAGE,
      retryable: false,
      conflictingFields: ['body'],
    });

    expect(retryable.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
    expect(retryable.retryable).not.toBe(terminal.retryable);
  });

  test('every code in the composer table lands on the branch the table gives it', () => {
    // `composer-and-sending.md`: 401/408/425/429/5xx back off and stay queued;
    // 409/400/413/422 are terminal. If a row of that table changes, this fails.
    const expected: Array<[unknown, boolean]> = [
      [{ code: 'unauthenticated', message: MESSAGE, retryable: true }, true],
      [{ code: 'requestTimeout', message: MESSAGE, retryable: true }, true],
      [{ code: 'tooEarly', message: MESSAGE, retryable: true }, true],
      [{ code: 'rateLimited', message: MESSAGE, retryable: true }, true],
      [{ code: 'internal', message: MESSAGE, retryable: true }, true],
      // A block is liftable by the OTHER member without the sender doing anything,
      // which is the clearest "yes, eventually" in the composer's test. So the send
      // stays queued and flushes when it lifts. Overruled once the other way —
      // see ADR 0059; the affordance and the classification are separate concerns.
      [{ code: 'sendBlocked', message: MESSAGE, retryable: true, reason: 'blocked_by_them' }, true],
      [
        { code: 'idempotencyConflict', message: MESSAGE, retryable: false, conflictingFields: ['body'] },
        false,
      ],
      [{ code: 'invalidRequest', message: MESSAGE, retryable: false }, false],
      [{ code: 'payloadTooLarge', message: MESSAGE, retryable: false }, false],
      [{ code: 'unprocessable', message: MESSAGE, retryable: false }, false],
      [{ code: 'notFound', message: MESSAGE, retryable: false }, false],
      [{ code: 'methodNotAllowed', message: MESSAGE, retryable: false }, false],
    ];

    for (const [body, retryable] of expected) {
      expect(parse(body).retryable).toBe(retryable);
    }
  });

  test('a code cannot claim the retryability it does not have', () => {
    // This is why `retryable` is a literal per branch rather than one boolean on the
    // envelope. Written as a boolean field, this parses, and the send queue either
    // retries a client bug forever or abandons a message that needed one more try.
    const contradictions = [
      { code: 'idempotencyConflict', message: MESSAGE, retryable: true },
      { code: 'rateLimited', message: MESSAGE, retryable: false },
      { code: 'unauthenticated', message: MESSAGE, retryable: false },
      { code: 'internal', message: MESSAGE, retryable: false },
      // The one that was actually got wrong: marking a liftable block terminal
      // makes a queued send die over server-side state the member cannot change and
      // did not ask to change.
      { code: 'sendBlocked', message: MESSAGE, retryable: false, reason: 'blocked_by_them' },
    ];

    for (const body of contradictions) {
      expect(errorBody.safeParse(body).success).toBe(false);
    }
  });

  test('an envelope with no retryability at all is rejected', () => {
    // The pre-envelope shape. Accepting it would mean every client falls back to
    // string-matching a status, which is the thing this file exists to prevent.
    expect(errorBody.safeParse({ code: 'internal', message: MESSAGE }).success).toBe(false);
  });

  test('a code nobody has heard of is rejected rather than passed through', () => {
    // An unknown code used to mean "treat it as retryable", which is how a 500 in
    // an un-audited branch quietly becomes an infinite retry loop.
    expect(errorBody.safeParse({ code: 'teapot', message: MESSAGE, retryable: true }).success).toBe(false);
    expect(errorBody.safeParse({ code: 'method_not_allowed', message: MESSAGE, retryable: false }).success).toBe(false);
    expect(errorBody.safeParse({ code: 'not_found', message: MESSAGE, retryable: false }).success).toBe(false);
  });

  test('a code with no human message is rejected', () => {
    // `message` exists to be shown. An empty string would render as a blank strip
    // on a row the member is being asked to act on.
    expect(errorBody.safeParse({ code: 'internal', message: '', retryable: true }).success).toBe(false);
    expect(errorBody.safeParse({ code: 'internal', retryable: true }).success).toBe(false);
  });
});

describe('the 409 from ADR 0004', () => {
  const conflict = { code: 'idempotencyConflict', message: MESSAGE, retryable: false };

  test('names the fields that disagreed, and insists on at least one', () => {
    // "409, naming the conflict" from `message-lifecycle.md`. Naming it means
    // naming the FIELDS — a member staring at `Not sent` learns that the text
    // differed, not merely that something did.
    const parsed = parse({ ...conflict, conflictingFields: ['body', 'authorId'] });
    expect(parsed.code === 'idempotencyConflict' && parsed.conflictingFields).toEqual(['body', 'authorId']);

    // Empty would say "something differs" and identify nothing.
    expect(errorBody.safeParse({ ...conflict, conflictingFields: [] }).success).toBe(false);
    expect(errorBody.safeParse(conflict).success).toBe(false);
  });

  test('accepts exactly the four compared fields and nothing else', () => {
    // These four ARE the decision "what does the same content mean" (ADR 0059), so
    // the wire form and the ADR cannot drift apart: a fifth field here is a fifth
    // field the server would start comparing without anyone deciding it.
    expect(sendConflictField.options).toEqual(['body', 'attachments', 'conversationId', 'authorId']);
    expect(
      errorBody.safeParse({ ...conflict, conflictingFields: ['createdAt'] }).success,
    ).toBe(false);
    expect(
      errorBody.safeParse({ ...conflict, conflictingFields: ['seq'] }).success,
    ).toBe(false);
  });

  test('carries 23505 when the constraint fired before the comparison could run', () => {
    // The dedupe path is a unique violation on `message_id_key` re-read and compared
    // (stage 3.3.C). If the comparison finds nothing to disagree about, the client
    // is told the row already exists rather than being handed a bare 409.
    const parsed = parse({ ...conflict, conflictingFields: ['attachments'], postgresCode: '23505' });
    expect(parsed.code === 'idempotencyConflict' && parsed.postgresCode).toBe('23505');

    // Not any five characters, and certainly not a driver sentence.
    expect(
      errorBody.safeParse({ ...conflict, conflictingFields: ['body'], postgresCode: 'duplicate key' })
        .success,
    ).toBe(false);
    expect(
      errorBody.safeParse({ ...conflict, conflictingFields: ['body'], postgresCode: '2350' }).success,
    ).toBe(false);
  });
});

describe('the rest of the envelope', () => {
  test('a rate limit carries Retry-After, and only when the server sends one', () => {
    const withAfter = parse({ code: 'rateLimited', message: MESSAGE, retryable: true, retryAfterSeconds: 2 });
    expect(withAfter.code === 'rateLimited' && withAfter.retryAfterSeconds).toBe(2);

    // Omitting it is the common case. `retryAfterSeconds: undefined` must parse —
    // an optional field that rejects an explicit undefined is a nuisance, not safety.
    expect(parse({ code: 'rateLimited', message: MESSAGE, retryable: true }).code).toBe('rateLimited');
    expect(
      errorBody.safeParse({ code: 'rateLimited', message: MESSAGE, retryable: true, retryAfterSeconds: -1 })
        .success,
    ).toBe(false);
  });

  test('a validation failure names the fields, and the path is a path', () => {
    const parsed = parse({
      code: 'invalidRequest',
      message: MESSAGE,
      retryable: false,
      fields: [{ path: 'attachments[0].mediaId', message: 'must be a uuid' }],
    });
    expect(parsed.code === 'invalidRequest' && parsed.fields?.[0]?.path).toBe('attachments[0].mediaId');

    expect(
      errorBody.safeParse({
        code: 'invalidRequest',
        message: MESSAGE,
        retryable: false,
        fields: [{ path: 'body' }],
      }).success,
    ).toBe(false);
  });

  test('a locked conversation carries the reason the composer already renders', () => {
    // `sendPermission` reasons and the envelope's must be one list. Two lists drift,
    // and the UI then renders copy for a reason the server cannot name.
    for (const reason of ['blocked_by_me', 'blocked_by_them', 'not_a_member', 'too_many_members']) {
      expect(parse({ code: 'sendBlocked', message: MESSAGE, retryable: true, reason }).code).toBe(
        'sendBlocked',
      );
    }
    expect(
      errorBody.safeParse({ code: 'sendBlocked', message: MESSAGE, retryable: true, reason: 'nope' })
        .success,
    ).toBe(false);
    expect(errorBody.safeParse({ code: 'sendBlocked', message: MESSAGE, retryable: true }).success).toBe(
      false,
    );
  });

  test('an unknown field is dropped rather than passed through to the client', () => {
    // Extra keys on a Zod object are stripped by default. That is the behaviour we
    // want: a server that starts sending a field nobody has agreed on cannot
    // silently widen the protocol through the envelope.
    const parsed = parse({ code: 'internal', message: MESSAGE, retryable: true, stack: 'at send.ts' });
    expect(parsed).toEqual({ code: 'internal', message: MESSAGE, retryable: true });
  });
});

describe('the wrapper', () => {
  test('every failure is `{ error: … }`, and nothing else is accepted', () => {
    expect(errorEnvelope.parse({ error: { code: 'internal', message: MESSAGE, retryable: true } })).toEqual({
      error: { code: 'internal', message: MESSAGE, retryable: true },
    });

    // A bare body, or an array of them, is a second error shape.
    expect(errorEnvelope.safeParse({ code: 'internal', message: MESSAGE, retryable: true }).success).toBe(false);
    expect(
      errorEnvelope.safeParse({ errors: [{ code: 'internal', message: MESSAGE, retryable: true }] }).success,
    ).toBe(false);
  });

  test('an envelope that is valid JSON is not automatically a valid envelope', () => {
    // The trap this whole file guards: a shape that accepts anything is worse than
    // no shape, because it moves the failure from the server to the member.
    for (const junk of [
      {},
      { error: null },
      { error: 'unauthenticated' },
      { error: {} },
      { error: { code: 'internal' } },
    ]) {
      expect(errorEnvelope.safeParse(junk).success).toBe(false);
    }
  });
});
