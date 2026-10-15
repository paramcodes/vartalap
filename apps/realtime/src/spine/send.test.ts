/**
 * The send path, and **gate G1a**.
 *
 * G1 is "within a conversation, commit order equals `seq` order". It is two tests
 * because this machine cannot run the obvious one: there is no Postgres server
 * binary, no Docker and no root, so the only database is PGlite behind a single
 * serialising connection, and two concurrent transactions there do not race —
 * the second one WAITS. A concurrency test written naively therefore hangs rather
 * than fails, and a test that "passes" on PGlite has proved nothing about
 * concurrency. `g1b.test.ts` is that other test; it skips loudly and is recorded
 * as unrun.
 *
 * This file is G1a: **the send path issues the lock, with ADR 0056's derivation,
 * inside the transaction that inserts the message, before the insert.** That is a
 * real property of a real implementation, it runs everywhere, and it is the part
 * of the guarantee that can be asserted without two open transactions.
 *
 * ── a note on what this file is allowed to assert ─────────────────────────────
 *
 * ADR 0005 says the lock "carries no comment of its own **and no test** — which is
 * why the client-side `COUNT(*)` reconciliation exists as an independent net." Both
 * now exist: the comment is in `send.ts` and this is the test. Neither one replaces
 * the other, and neither replaces G1b.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import { attachment, conversationId as conversationIdScalar, sendMessageRequest, serverFrame } from '@vartalap/protocol';
import { canonicalAttachments, sendMessage, type SendOutcome } from './send.ts';
import {
  captureSql,
  createDirectConversation,
  directConversationBetweenTwo,
  indexOfStatement,
  insertUser,
  LOCK_SQL,
  newMessageId,
  queriesOf,
} from './fixture.ts';

const LOCK = /pg_advisory_xact_lock/;
const INSERT_MESSAGE = /^insert into "message"/;
const INSERT_OUTBOX = /^insert into "outbox"/;
const UPDATE_CONVERSATION = /^update "conversation"/;
const MEMBERSHIP = /^select "conversation_id" from "member"/;

beforeEach(async () => {
  await testDb.reset();
});

/** Narrowing helper, so a failed expectation names what it was looking at. */
function created(outcome: SendOutcome) {
  if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
  return outcome.message;
}

/**
 * A committed message's position, as a plain string.
 *
 * The wire type has `seq: Seq | null` because `null` is a real state — it is what
 * a queued send holds before the server answers (ADR 0060). Every row read back
 * from the database has one, so this turns the type's honesty into an assertion
 * rather than a cast.
 */
function positionOf(wire: { seq: string | null }): string {
  if (wire.seq === null) throw new Error('a committed message has no position');
  return wire.seq;
}

/**
 * `timestamptz` is formatted in SQL rather than parsed in the test.
 *
 * postgres.js installs no parser for `timestamptz` — it hands back the server's
 * own text, in the session's timezone, which is not something a test can compare
 * against an ISO string. `new Date(...)` on that text would be guessing at a
 * format, and a test that guesses passes on one machine.
 */
const CLIENT_CLOCK_ISO = `to_char(client_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// ═══════════════════════════════════════════════════════════════════════════════
// G1a — the lock
// ═══════════════════════════════════════════════════════════════════════════════

describe('G1a: the send path issues the lock ADR 0056 documents', () => {
  test('it is taken inside the transaction that inserts the message, and before the insert', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });

    const { result, statements } = await captureSql(sql, () => sendMessage({ authorId, request }));

    const begin = indexOfStatement(statements, /^begin$/);
    const commit = indexOfStatement(statements, /^commit$/);
    const lock = indexOfStatement(statements, LOCK);
    const insert = indexOfStatement(statements, INSERT_MESSAGE);
    const outbox = indexOfStatement(statements, INSERT_OUTBOX);
    const conversation = indexOfStatement(statements, UPDATE_CONVERSATION);

    // All five have to EXIST first. `-1` would otherwise satisfy every ordering
    // comparison below, which is how a test that asserts nothing gets written.
    for (const [name, at] of [
      ['begin', begin],
      ['commit', commit],
      ['lock', lock],
      ['insert into message', insert],
      ['insert into outbox', outbox],
      ['update conversation', conversation],
    ] as const) {
      expect(at, `${name} was never emitted`).toBeGreaterThanOrEqual(0);
    }

    // Before the insert, and inside the transaction that inserts it.
    expect(lock).toBeGreaterThan(begin);
    expect(lock).toBeLessThan(insert);
    // ADR 0004: the outbox row is in the SAME transaction, before the response.
    expect(outbox).toBeGreaterThan(insert);
    expect(outbox).toBeLessThan(commit);
    expect(conversation).toBeGreaterThan(outbox);
    expect(conversation).toBeLessThan(commit);

    expect(result.kind).toBe('created');
  });

  test('the statement is ADR 0056\'s derivation, exactly — the `::uuid::text` cast included', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });

    const { statements } = await captureSql(sql, () => sendMessage({ authorId, request }));
    const lock = statements[indexOfStatement(statements, LOCK)]!;

    // Byte equality, not a lookalike. The seed is `0x76617274616C6170` — ASCII
    // `vartalap` — and `$1` rather than an interpolated literal, because
    // `hashtextextended` is IMMUTABLE and with a literal the planner folds the
    // whole expression to a constant at plan time.
    expect(lock.query).toBe(LOCK_SQL);
    expect(lock.query).toContain('8530225013392695664');
    expect(lock.query).toContain('::uuid::text');
    expect(lock.query).not.toContain('8530225013392695664:bigint');
  });

  test('the key is derived from THIS conversation, as a bound parameter', async () => {
    // A lock statement can be present, in the right place, and still be keyed on
    // the wrong conversation — which serialises nothing. Only the bound parameter
    // distinguishes that, so this asserts the parameter and not just the text.
    const alice = await directConversationBetweenTwo();
    const bob = await directConversationBetweenTwo();

    const send = async (conversationId: string, authorId: string) => {
      const request = sendMessageRequest.parse({
        conversationId,
        id: newMessageId(),
        body: 'hello',
        attachments: [],
      });
      const { statements } = await captureSql(sql, () => sendMessage({ authorId, request }));
      return statements[indexOfStatement(statements, LOCK)]!;
    };

    const intoAlice = await send(alice.conversationId, alice.authorId);
    const intoBob = await send(bob.conversationId, bob.authorId);

    expect(intoAlice.parameters).toEqual([alice.conversationId]);
    expect(intoBob.parameters).toEqual([bob.conversationId]);
    expect(intoAlice.parameters).not.toEqual(intoBob.parameters);
  });

  test('the membership read happens BEFORE the transaction opens', async () => {
    // Not the guarantee — but a transaction held open across an authorisation
    // check would serialise two members against each other for no reason, and the
    // statement order is already being captured, so it is cheap to pin.
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });

    const { statements } = await captureSql(sql, () => sendMessage({ authorId, request }));
    expect(indexOfStatement(statements, MEMBERSHIP)).toBeLessThan(indexOfStatement(statements, /^begin$/));
  });

  test('four spellings of one conversation hash to one lock key, because the cast normalises', async () => {
    // ADR 0056's table, re-measured rather than recalled. Hashing the raw string
    // gives four keys for one conversation; two members whose clients disagree
    // about case would then take different locks and ADR 0005's race would be
    // back — with no error and no log line.
    const canonical = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f405162';
    const spellings = [canonical, canonical.toUpperCase(), canonical.replaceAll('-', ''), `{${canonical}}`];

    const keys = await Promise.all(
      spellings.map(async (spelling) => {
        const rows = await sql<{ key: string }[]>`
          SELECT hashtextextended(${spelling}::uuid::text, 8530225013392695664)::text AS key`;
        return rows[0]!.key;
      }),
    );

    expect(new Set(keys).size).toBe(1);

    // And the derivation the send path actually ships is the normalising one —
    // otherwise this measurement describes a statement nobody runs.
    expect(LOCK_SQL).toContain('::uuid::text');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A new message
// ═══════════════════════════════════════════════════════════════════════════════

describe('a new message', () => {
  test('the row carries the assigned position, both timestamps, and the author', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const clientCreatedAt = '2026-10-15T09:30:00.000Z';
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
      clientCreatedAt,
    });

    const wire = created(await sendMessage({ authorId, request }));
    expect(wire.seq).not.toBeNull();
    expect(wire.id).toBe(request.id);
    expect(wire.conversationId).toBe(conversationId);
    expect(wire.authorId).toBe(authorId);
    // The client's clock, verbatim, and never a sort key.
    expect(wire.createdAt).toBe(clientCreatedAt);

    const rows = await sql<{ seq: string; id: string; body: string; client_created_at: string; created_at: string }[]>`
      SELECT seq, id, body, ${sql.unsafe(CLIENT_CLOCK_ISO)} AS client_created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM message WHERE id = ${request.id}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(positionOf(wire));
    expect(rows[0]!.body).toBe('hello');
    expect(rows[0]!.client_created_at).toBe(clientCreatedAt);
    // `created_at` is the server's, and it is NOT what the wire calls `createdAt`.
    expect(rows[0]!.created_at).not.toBe(clientCreatedAt);
  });

  test('a send with no client clock stores the server\'s stamp rather than failing', async () => {
    // `client_created_at` is NOT NULL with no default, so omitting the field is a
    // choice rather than an accident — and it must not become a 500. See the
    // frames.ts comment: the column is documented as the client's clock and the
    // wire did not carry it, which is the compromise this records.
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });

    const wire = created(await sendMessage({ authorId, request }));
    const rows = await sql<{ client_created_at: string }[]>`
      SELECT ${sql.unsafe(CLIENT_CLOCK_ISO)} AS client_created_at FROM message WHERE id = ${request.id}`;
    expect(rows[0]!.client_created_at).toBe(wire.createdAt);
  });

  test('the outbox row is the validated `message.created` frame, and the relay publishes it verbatim', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });

    const wire = created(await sendMessage({ authorId, request }));

    const rows = await sql<{ message_seq: string; conversation_id: string; payload: unknown }[]>`
      SELECT message_seq, conversation_id, payload FROM outbox`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_seq).toBe(positionOf(wire));
    expect(rows[0]!.conversation_id).toBe(conversationId);

    // Parsed through the protocol schema, not compared to a hand-copied literal:
    // what matters is that the bytes in the table ARE a frame, so the relay cannot
    // publish something the protocol would refuse.
    const frame = serverFrame.parse(rows[0]!.payload);
    if (frame.type !== 'message.created') throw new Error(`unexpected frame: ${frame.type}`);
    expect(frame.conversationId).toBe(conversationId);
    expect(frame.message).toEqual(wire);
  });

  test('the conversation\'s position advances to the new message', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const before = await sql<{ last_seq: string }[]>`
      SELECT last_seq FROM conversation WHERE id = ${conversationId}`;
    expect(before[0]!.last_seq).toBe('0');

    const wire = created(
      await sendMessage({
        authorId,
        request: sendMessageRequest.parse({
          conversationId,
          id: newMessageId(),
          body: 'hello',
          attachments: [],
        }),
      }),
    );

    const after = await sql<{ last_seq: string }[]>`
      SELECT last_seq FROM conversation WHERE id = ${conversationId}`;
    expect(after[0]!.last_seq).toBe(positionOf(wire));
  });

  test('nothing is broadcast from request handling', async () => {
    // ADR 0004 and ADR 0057: the outbox row IS what the relay reads. Nothing here
    // reaches for a broker, and there is no broker in this repo yet — so what this
    // can honestly assert is that the durable fact and the publishable fact are
    // ONE object, committed together.
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });
    const wire = created(await sendMessage({ authorId, request }));

    const rows = await sql<{ payload: unknown }[]>`
      SELECT payload FROM outbox WHERE message_seq = ${positionOf(wire)}`;
    const frame = serverFrame.parse(rows[0]!.payload);

    // The frame in the outbox is the frame a client receives, built once. There is
    // no second derivation on the publish path to drift from this one.
    expect(frame).toEqual({ type: 'message.created', conversationId, message: wire });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADR 0059's other two answers
// ═══════════════════════════════════════════════════════════════════════════════

describe('the same key arriving twice', () => {
  const setup = async () => {
    const direct = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId: direct.conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    });
    const first = created(await sendMessage({ authorId: direct.authorId, request }));
    return { ...direct, request, first };
  };

  test('same key, same content: the ORIGINAL row, with its position', async () => {
    const { authorId, request, first } = await setup();

    const retry = await sendMessage({ authorId, request });

    expect(retry.kind).toBe('deduplicated');
    if (retry.kind !== 'deduplicated') throw new Error('unreachable');
    // Returning the original WITH its seq is the entire point: it lets a client
    // reconcile from its own retry response instead of waiting for an echo over
    // the socket.
    expect(retry.message).toEqual(first);

    // One row, one outbox row. A retry that produced a second row would be the
    // failure this whole mechanism exists to prevent.
    const messages = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM message`;
    const outbox = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM outbox`;
    expect(messages[0]!.n).toBe('1');
    expect(outbox[0]!.n).toBe('1');
  });

  test('the retry is a fresh attempt, not a replay: it inserts, rolls back, and reads', async () => {
    // The trap this records. postgres.js rolls the transaction back as soon as the
    // callback rejects, so the dedupe re-read CANNOT run on the aborted
    // transaction — every further statement there would answer `25P02`. Doing it
    // in the wrong place produces a dedupe path that reads the row as absent and
    // answers `409` for a retry of a message that committed perfectly well.
    const { authorId, request } = await setup();

    const { statements } = await captureSql(sql, () => sendMessage({ authorId, request }));
    const queries = queriesOf(statements);

    const rollback = queries.indexOf('rollback');
    // The re-read. Matched on the table rather than the column list, because the
    // point is WHERE it ran — after the rollback, on a transaction that still
    // exists — not which columns came back.
    const read = queries.findIndex((query, at) => at > rollback && /from "message"/.test(query));

    expect(rollback, 'the colliding insert must have rolled back').toBeGreaterThanOrEqual(0);
    expect(read, `the original row must be re-read after the rollback: ${queries.join(' | ')}`).toBeGreaterThan(rollback);
    expect(queries).not.toContain('commit');
  });

  test('same key, different body: `409`, naming `body`', async () => {
    const { conversationId, authorId, request } = await setup();

    const outcome = await sendMessage({
      authorId,
      request: sendMessageRequest.parse({
        conversationId,
        id: request.id,
        body: 'something else entirely',
        attachments: [],
      }),
    });

    expect(outcome).toEqual({ kind: 'conflict', conflictingFields: ['body'] });
    // Terminal by ruling, not by accident: a key reused for a different message is
    // a client bug and retrying cannot fix one.
  });

  test('same key, different author: `409`, naming `authorId` rather than answering `200`', async () => {
    const { conversationId, authorId, peerId, request } = await setup();

    const outcome = await sendMessage({
      authorId: peerId,
      request: sendMessageRequest.parse({
        conversationId,
        id: request.id,
        body: 'hello',
        attachments: [],
      }),
    });

    // `200` here would hide the bug: the second author would see their own text
    // attached to somebody else's send with nothing anywhere saying why.
    expect(outcome).toEqual({ kind: 'conflict', conflictingFields: ['authorId'] });
    expect(authorId).not.toBe(peerId);
  });

  test('same key, different conversation: `409`, naming `conversationId`', async () => {
    const first = await setup();
    // A second conversation this author is genuinely a member of, so the refusal
    // is about the CONTENT and not about membership — which is the whole point of
    // ordering the checks the way this file orders them.
    const third = await insertUser();
    const elsewhere = await createDirectConversation([first.authorId, third]);

    const outcome = await sendMessage({
      authorId: first.authorId,
      request: sendMessageRequest.parse({
        conversationId: elsewhere.conversationId,
        id: first.request.id,
        body: 'hello',
        attachments: [],
      }),
    });

    expect(outcome).toEqual({ kind: 'conflict', conflictingFields: ['conversationId'] });
    // Not `notAMember`: the author really is a member of `elsewhere`.
    const members = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM member WHERE conversation_id = ${elsewhere.conversationId}`;
    expect(members[0]!.n).toBe('2');
  });

  test('two changed fields are both named', async () => {
    const { conversationId, authorId, peerId, request } = await setup();

    const outcome = await sendMessage({
      authorId: peerId,
      request: sendMessageRequest.parse({
        conversationId,
        id: request.id,
        body: 'edited',
        attachments: [],
      }),
    });

    expect(outcome).toEqual({ kind: 'conflict', conflictingFields: ['body', 'authorId'] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Refusals before execution — the ones that leave the key unconsumed
// ═══════════════════════════════════════════════════════════════════════════════

describe('a refusal before execution', () => {
  test('a non-member is refused and nothing is written', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const stranger = await insertUser();

    const outcome = await sendMessage({
      authorId: stranger,
      request: sendMessageRequest.parse({
        conversationId,
        id: newMessageId(),
        body: 'let me in',
        attachments: [],
      }),
    });

    expect(outcome).toEqual({ kind: 'notAMember' });

    const messages = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM message`;
    const outbox = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM outbox`;
    expect(messages[0]!.n).toBe('0');
    expect(outbox[0]!.n).toBe('0');
  });

  test('a former member is not a member', async () => {
    // `left_at` is set, so they remain a row and remain a member for history —
    // and they are not a member who can send. One `isNull` on the membership read.
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    await sql`UPDATE member SET left_at = now() WHERE user_id = ${peerId}`;

    const outcome = await sendMessage({
      authorId: peerId,
      request: sendMessageRequest.parse({
        conversationId,
        id: newMessageId(),
        body: 'still here?',
        attachments: [],
      }),
    });

    expect(outcome).toEqual({ kind: 'notAMember' });
    expect(authorId).not.toBe(peerId);
  });

  test('attachments are refused rather than silently dropped', async () => {
    // `message_attachment` stores `media_id` and `position` and no `variant`, so a
    // stored attachment cannot be reproduced in a dedupe response. Accepting them
    // would leave a state where the database claims a message has attachments and
    // the server cannot show them. `message-lifecycle.md` puts the media seam here
    // and says it does not cross it.
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const request = sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'look',
      attachments: [
        attachment.parse({ mediaId: crypto.randomUUID(), variant: 'thumb', width: 80, height: 80 }),
      ],
    });

    const outcome = await sendMessage({ authorId, request });
    expect(outcome).toEqual({ kind: 'attachmentsUnsupported' });

    const messages = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM message`;
    expect(messages[0]!.n).toBe('0');
  });

  test('canonicalisation is order-independent and collapses duplicates', async () => {
    // ADR 0059: two clients that picked the same photos in a different order sent
    // the same message, and a `409` for a reordering is a false accusation.
    const a = attachment.parse({ mediaId: '4d3e5f60-7182-4c9d-a0e1-2a3b4c5d6e7f', variant: 'thumb', width: 80, height: 80 });
    const b = attachment.parse({ mediaId: '5d3e5f60-7182-4c9d-a0e1-2a3b4c5d6e7f', variant: 'full', width: 800, height: 800 });

    const forwards = canonicalAttachments([a, b]);
    const backwards = canonicalAttachments([b, a]);
    const withADuplicate = canonicalAttachments([b, a, a]);

    expect(backwards).toEqual(forwards);
    expect(withADuplicate).toEqual(forwards);
    expect(forwards).toHaveLength(2);
    // Ordered by mediaId, not by the order they arrived in.
    expect(forwards.map((entry) => entry.mediaId)).toEqual([a.mediaId, b.mediaId]);
  });
});

describe('the conversation fixture is real', () => {
  test('two members, one conversation, and argument order cannot make a second', async () => {
    const [one, two] = await Promise.all([insertUser(), insertUser()]);
    const forwards = await createDirectConversation([one, two]);
    const backwards = await createDirectConversation([two, one]);

    // ADR 0007's `direct_key` is the two ids sorted and joined, so this is a
    // constraint and not an application check.
    expect(backwards.conversationId).toBe(forwards.conversationId);
    expect(conversationIdScalar.safeParse(forwards.conversationId).success).toBe(true);

    const members = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM member WHERE conversation_id = ${forwards.conversationId}`;
    expect(members[0]!.n).toBe('2');
  });
});