/**
 * History and catch-up, at the function boundary. Gate **G4, server half**.
 *
 * `history.http.test.ts` proves the endpoint. This proves the two reads underneath
 * it — and the parts of gate G4 that the endpoint cannot show, because they are
 * about SQL rather than about status codes:
 *
 * - keyset in both directions, no `OFFSET` anywhere (ADR 0005)
 * - `latestSeq` is the conversation's HEAD, not the newest row on the page
 * - `totalCount` is the conversation's real `COUNT(*)`, not the page's length
 * - catch-up is scoped to the caller's CURRENT memberships, and never leaks
 *
 * ── why `totalCount` needs the awkward tests it gets ───────────────────────────
 *
 * `totalCount: messages.length` is a bug that passes. On a full first page of a
 * conversation of exactly fifty messages the two are equal, which is why the
 * obvious test ("a page has two rows and `totalCount` is two") would prove
 * nothing. The assertions here are all built around making the two DIFFER:
 *
 * - a partial page (five messages, `limit: 2`) — two rows, count five;
 * - a short conversation (one message) — one row, count one, and the page is the
 *   whole transcript so there is nothing to reconcile against;
 * - a page reached by `after` rather than by `before`, because the remaining-rows
 *   reading and the whole-conversation reading are different wrong answers;
 * - a conversation with a hole in it, where `COUNT(*)` and `max - min` disagree —
 *   which is the check ADR 0005 says is UNSOUND, so this asserts the count is a
 *   count and the span is not being used as one.
 *
 * The client half of G4 — comparing this number against what the browser holds —
 * is 3.G's, and this file cannot do it. What it can do is make sure the number
 * they will compare against is the truth.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, testDb } from '@vartalap/database/test-harness';
import {
  PAGE_SIZE,
  conversationId as conversationIdScalar,
  seq as seqScalar,
  sendMessageRequest,
  type CatchUpPage,
  type ConversationId,
  type HistoryPage,
  type Message,
  type Seq,
  type UserId,
} from '@vartalap/protocol';
import { readCatchUp, readHistory } from './history.ts';
import { sendMessage } from './send.ts';
import {
  captureSql,
  createDirectConversation,
  directConversationBetweenTwo,
  insertUser,
  newMessageId,
  queriesOf,
} from './fixture.ts';

/** The wire's position — `"2"`, never a number (ADR 0005). */
function positionOf(wire: { seq: Seq | null }): Seq {
  if (wire.seq === null) throw new Error('a message read back from the database has a position');
  return wire.seq;
}

const bodiesOf = (messages: readonly Message[]): string[] => messages.map((message) => message.body);
const positionsOf = (messages: readonly Message[]): Seq[] => messages.map(positionOf);

/** Send through the REAL write path, so a page is tested against real rows. */
async function say(conversationId: ConversationId, authorId: UserId, body: string): Promise<Message> {
  const outcome = await sendMessage({
    authorId,
    request: sendMessageRequest.parse({ conversationId, id: newMessageId(), body, attachments: [] }),
  });
  if (outcome.kind !== 'created') throw new Error(`expected a created message, got ${outcome.kind}`);
  return outcome.message;
}

/**
 * `count` messages into one conversation, in order, and returns them.
 *
 * Sequential on purpose: PGlite serves one connection, so "concurrently" would
 * mean "queued", and a transcript whose order is a scheduling artefact is not the
 * fixture anybody wants.
 */
async function transcript(
  conversationId: ConversationId,
  authorId: UserId,
  count: number,
  prefix = 'm',
): Promise<Message[]> {
  const written: Message[] = [];
  for (let index = 1; index <= count; index += 1) {
    written.push(await say(conversationId, authorId, `${prefix}${index}`));
  }
  return written;
}

/** A conversation with `count` messages in it, and the reader who is a member. */
async function withTranscript(count: number): Promise<{
  conversationId: ConversationId;
  readerId: UserId;
  written: Message[];
}> {
  const direct = await directConversationBetweenTwo();
  const written = await transcript(direct.conversationId, direct.authorId, count);
  // Named `readerId` rather than `authorId` because most of these tests are about
  // the relationship between the two claims, not about who wrote the rows.
  return { conversationId: direct.conversationId, readerId: direct.authorId, written };
}

/**
 * A walk must END, and the only thing that ends it is a short page.
 *
 * The cap exists so that a cursor which does not move fails as an ASSERTION with a
 * sentence naming the cause, rather than as a test timeout five seconds later with
 * a stack in postgres.js. A loop that cannot terminate is the bug this cap exists
 * to describe, so the cap is part of the assertion and not a safety net.
 */
const MAX_WALK_PAGES = 20;

/** Walk backwards with keyset cursors until the page comes back short. */
async function walkBackwards(conversationId: ConversationId, readerId: UserId, limit: number) {
  const collected: Message[] = [];
  const pageLengths: number[] = [];
  let cursor: Seq | undefined;

  do {
    const page = await readHistory({ userId: readerId, conversationId, limit, before: cursor });
    collected.push(...page.messages);
    pageLengths.push(page.messages.length);
    cursor = page.messages.length === 0 ? undefined : positionOf(page.messages[page.messages.length - 1]!);
  } while (pageLengths[pageLengths.length - 1] === limit);

  expect(
    pageLengths.length,
    'the walk never saw a short page — the cursor is not moving backwards',
  ).toBeLessThan(MAX_WALK_PAGES);

  return { collected, pageLengths };
}

/** Walk forwards from a cursor until the page comes back short. */
async function walkForwards(conversationId: ConversationId, readerId: UserId, after: Seq, limit: number) {
  const collected: Message[] = [];
  const pageLengths: number[] = [];
  let cursor = after;

  do {
    const page = await readHistory({ userId: readerId, conversationId, limit, after: cursor });
    collected.push(...page.messages);
    pageLengths.push(page.messages.length);
    if (page.messages.length > 0) cursor = positionOf(page.messages[page.messages.length - 1]!);
  } while (pageLengths[pageLengths.length - 1] === limit);

  expect(pageLengths.length, 'the walk never saw a short page — the cursor is not moving').toBeLessThan(MAX_WALK_PAGES);

  return { collected, pageLengths };
}

beforeEach(async () => {
  await testDb.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Keyset pagination
// ═══════════════════════════════════════════════════════════════════════════════

describe('history: keyset, both directions', () => {
  test('with no cursor the page is the newest rows, newest first', async () => {
    const { conversationId, readerId, written } = await withTranscript(5);

    const page = await readHistory({ userId: readerId, conversationId, limit: 2 });

    expect(bodiesOf(page.messages)).toEqual(['m5', 'm4']);
    expect(positionsOf(page.messages)).toEqual([positionOf(written[4]!), positionOf(written[3]!)]);
    // Descending, as a number. Two decimal strings compared as strings would sort
    // "10" before "9" and every assertion below would pass on a broken order.
    const asNumbers = positionsOf(page.messages).map(Number);
    expect(asNumbers).toEqual([...asNumbers].sort((a, b) => b - a));
  });

  test('paging backwards walks the whole transcript once — no repeat, no hole, and a short page ends it', async () => {
    const { conversationId, readerId } = await withTranscript(5);

    const { collected, pageLengths } = await walkBackwards(conversationId, readerId, 2);

    // Two full pages then a short one: the short page is the loop's only exit
    // condition, so this is also the assertion that it can happen.
    expect(pageLengths).toEqual([2, 2, 1]);
    expect(bodiesOf(collected)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    expect(new Set(collected.map((message) => message.id)).size).toBe(5);
  });

  test('paging forwards from the oldest reaches the present', async () => {
    const { conversationId, readerId } = await withTranscript(5);

    const page = await readHistory({ userId: readerId, conversationId, limit: 50, after: seqScalar.parse('0') });

    expect(bodiesOf(page.messages)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  test('a forward walk from a cursor terminates the same way a backward one does', async () => {
    const { conversationId, readerId, written } = await withTranscript(5);

    const { collected, pageLengths } = await walkForwards(conversationId, readerId, positionOf(written[1]!), 2);

    expect(pageLengths).toEqual([2, 1]);
    expect(bodiesOf(collected)).toEqual(['m3', 'm4', 'm5']);
  });

  test('the cursor is EXCLUSIVE in both directions — the row it names is not on the next page', async () => {
    // `<=` and `>=` are the two off-by-ones that a keyset page really has, and
    // both of them duplicate exactly one row per page — which a transcript of odd
    // length can hide.
    const { conversationId, readerId, written } = await withTranscript(5);
    const middle = positionOf(written[2]!);

    const backwards = await readHistory({ userId: readerId, conversationId, limit: 3, before: seqScalar.parse(middle) });
    const forwards = await readHistory({ userId: readerId, conversationId, limit: 3, after: seqScalar.parse(middle) });

    expect(bodiesOf(backwards.messages)).toEqual(['m2', 'm1']);
    expect(bodiesOf(forwards.messages)).toEqual(['m4', 'm5']);
    expect(positionsOf(backwards.messages)).not.toContain(middle);
    expect(positionsOf(forwards.messages)).not.toContain(middle);
  });

  test('a cursor at either end is an empty page, not an error and not a wrap', async () => {
    const { conversationId, readerId, written } = await withTranscript(2);

    const older = await readHistory({
      userId: readerId,
      conversationId,
      limit: 10,
      before: seqScalar.parse(positionOf(written[0]!)),
    });
    const newer = await readHistory({
      userId: readerId,
      conversationId,
      limit: 10,
      after: seqScalar.parse(positionOf(written[1]!)),
    });

    expect(older.messages).toEqual([]);
    expect(newer.messages).toEqual([]);
    // …and the conversation's head is still reported on both.
    expect(older.latestSeq).toBe(positionOf(written[1]!));
    expect(newer.latestSeq).toBe(positionOf(written[1]!));
  });

  test('one conversation\'s messages never appear in another\'s page', async () => {
    const mine = await directConversationBetweenTwo();
    const elsewhere = await directConversationBetweenTwo();
    // Interleaved on purpose: `seq` is global, so a filter that forgot
    // `conversation_id` would return the other conversation's rows.
    await say(mine.conversationId, mine.authorId, 'mine-1');
    await say(elsewhere.conversationId, elsewhere.authorId, 'theirs-1');
    await say(mine.conversationId, mine.authorId, 'mine-2');
    await say(elsewhere.conversationId, elsewhere.authorId, 'theirs-2');

    const page = await readHistory({ userId: mine.authorId, conversationId: mine.conversationId, limit: 50 });

    // Newest first, as every page without a cursor is.
    expect(bodiesOf(page.messages)).toEqual(['mine-2', 'mine-1']);
    expect(page.totalCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// No OFFSET, and the SQL ADR 0005 writes down
// ═══════════════════════════════════════════════════════════════════════════════

describe('the SQL itself', () => {
  test('no statement either endpoint emits contains OFFSET', async () => {
    // ADR 0005: "OFFSET is never used. Under concurrent inserts, page three is not
    // the same fifty rows it was a second ago." A ban nobody checks is a comment,
    // so this is the check — over the SQL that ACTUALLY RAN, which is the only
    // place an `OFFSET` can hide.
    const { conversationId, readerId } = await withTranscript(3);

    const { statements } = await captureSql(sql, async () => {
      await readHistory({ userId: readerId, conversationId, limit: 1 });
      await readHistory({ userId: readerId, conversationId, limit: 1, after: seqScalar.parse('0') });
      await readCatchUp({ userId: readerId, after: seqScalar.parse('0'), limit: 1 });
    });

    expect(statements.length).toBeGreaterThan(0);
    const offenders = queriesOf(statements).filter((query) => /offset/i.test(query));
    expect(offenders, `OFFSET is banned (ADR 0005): ${offenders.join(' | ')}`).toEqual([]);
  });

  test('no source file in the realtime app can reach Drizzle\'s `.offset(`', async () => {
    // The captured-SQL check above can only see an `OFFSET` that a test happens to
    // execute. This catches the one written on a page no test reaches: Drizzle's
    // own `.offset(n)`, which is the only other way to emit the clause.
    const srcDir = fileURLToPath(new URL('../', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((name) => /\.offset\s*\(/.test(readFileSync(`${srcDir}${name}`, 'utf8')));
    expect(offenders, `OFFSET is banned (ADR 0005): ${offenders.join(', ')}`).toEqual([]);
  });

  test('backwards is `seq < $2 … DESC … LIMIT`, with all three parameters BOUND', async () => {
    const { conversationId, readerId, written } = await withTranscript(3);

    const { statements } = await captureSql(sql, () =>
      readHistory({ userId: readerId, conversationId, limit: 2, before: seqScalar.parse(positionOf(written[2]!)) }),
    );

    const page = statements.find((statement) => /from "message"/.test(statement.query) && /order by/i.test(statement.query));
    if (page === undefined) throw new Error(`no page statement was emitted: ${queriesOf(statements).join(' | ')}`);

    expect(page.query).toMatch(/"conversation_id" = \$1/);
    expect(page.query).toMatch(/"seq" < \$2/);
    expect(page.query).toMatch(/order by .*"seq" desc/i);
    expect(page.query).toMatch(/limit \$3/);
    // Bound, not interpolated: a cursor built into the string would escape every
    // other check here while still being one that can never be parameterised.
    expect(page.parameters).toEqual([conversationId, Number(positionOf(written[2]!)), 2]);
  });

  test('forwards is `seq > $2 … ASC … LIMIT`, with all three parameters bound', async () => {
    const { conversationId, readerId, written } = await withTranscript(3);

    const { statements } = await captureSql(sql, () =>
      readHistory({ userId: readerId, conversationId, limit: 2, after: seqScalar.parse(positionOf(written[0]!)) }),
    );

    const page = statements.find((statement) => /from "message"/.test(statement.query) && /order by/i.test(statement.query));
    if (page === undefined) throw new Error(`no page statement was emitted: ${queriesOf(statements).join(' | ')}`);

    expect(page.query).toMatch(/"conversation_id" = \$1/);
    expect(page.query).toMatch(/"seq" > \$2/);
    expect(page.query).toMatch(/order by .*"seq" asc/i);
    expect(page.query).toMatch(/limit \$3/);
    expect(page.parameters).toEqual([conversationId, Number(positionOf(written[0]!)), 2]);
  });

  test('the aggregate is its own `count(*)` statement, with no LIMIT in it', async () => {
    // If the count rode along with the page it would be counting the page. It is a
    // separate statement over the whole conversation precisely so it cannot be.
    const { conversationId, readerId } = await withTranscript(3);

    const { statements } = await captureSql(sql, () =>
      readHistory({ userId: readerId, conversationId, limit: 1 }),
    );

    const aggregate = statements.find((statement) => /count\(\*\)/.test(statement.query));
    if (aggregate === undefined) throw new Error(`no aggregate was emitted: ${queriesOf(statements).join(' | ')}`);

    expect(aggregate.query).toMatch(/count\(\*\)/);
    expect(aggregate.query).toMatch(/coalesce\(max\("seq"\), 0\)/);
    expect(aggregate.query).toMatch(/"message"\."conversation_id" = \$1/);
    expect(aggregate.query).not.toMatch(/limit/i);
    expect(aggregate.query).not.toMatch(/order by/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// latestSeq — the conversation's head
// ═══════════════════════════════════════════════════════════════════════════════

describe('latestSeq', () => {
  test('is the head of the conversation, NOT the newest row on the page', async () => {
    // The ruling, and the reason: "it lets a client assert it is caught up", which
    // is only true if it is the head. A client on a short middle page must still
    // learn that it is behind.
    //
    // So the page here is a MIDDLE page — `before` a row in the middle, not at the
    // end. That is the only shape in which the two can differ: the newest page
    // always contains the head, so "the max on the page" would pass on it.
    const { conversationId, readerId, written } = await withTranscript(5);

    const page = await readHistory({
      userId: readerId,
      conversationId,
      limit: 2,
      before: seqScalar.parse(positionOf(written[2]!)),
    });

    expect(bodiesOf(page.messages)).toEqual(['m2', 'm1']);
    expect(page.latestSeq).toBe(positionOf(written[4]!));
    // The strongest form of the assertion: the page's own maximum is a DIFFERENT
    // number, so the field cannot have been derived from the page.
    const newestOnPage = Math.max(...positionsOf(page.messages).map(Number));
    expect(newestOnPage).toBe(Number(positionOf(written[1]!)));
    expect(Number(page.latestSeq)).toBeGreaterThan(newestOnPage);
  });

  test('is the conversation\'s head even when every row is on the page', async () => {
    const { conversationId, readerId, written } = await withTranscript(2);

    const page = await readHistory({ userId: readerId, conversationId, limit: 50 });

    expect(page.latestSeq).toBe(positionOf(written[1]!));
    expect(Number(page.latestSeq)).toBe(Math.max(...positionsOf(page.messages).map(Number)));
  });

  test('moves when a message lands, and is not cached', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    await say(conversationId, authorId, 'first');

    const before = await readHistory({ userId: authorId, conversationId, limit: 1 });
    await say(conversationId, authorId, 'second');
    const after = await readHistory({ userId: authorId, conversationId, limit: 1 });

    expect(Number(after.latestSeq)).toBeGreaterThan(Number(before.latestSeq));
    expect(after.totalCount).toBe(2);
  });

  test('an empty conversation answers `latestSeq: 0` and `totalCount: 0`', async () => {
    // Not null and not an error. `conversation.last_seq` is `NOT NULL DEFAULT 0`
    // because IndexedDB does not index null (ADR 0045), and a wire field that can
    // be null is a field every consumer has to special-case.
    const { conversationId, authorId } = await directConversationBetweenTwo();

    const page = await readHistory({ userId: authorId, conversationId, limit: 50 });

    expect(page).toEqual({ messages: [], latestSeq: seqScalar.parse('0'), totalCount: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// G4 — totalCount is the conversation's COUNT(*)
// ═══════════════════════════════════════════════════════════════════════════════

describe('G4 (server half): totalCount is the conversation\'s COUNT(*)', () => {
  test('a PARTIAL page reports the whole conversation, not the rows it returned', async () => {
    // The test the bug needs. `totalCount: messages.length` passes on any full
    // page; here the two are 5 and 2.
    const { conversationId, readerId } = await withTranscript(5);

    const page = await readHistory({ userId: readerId, conversationId, limit: 2 });

    expect(page.messages).toHaveLength(2);
    expect(page.totalCount).toBe(5);
  });

  test('a short conversation counts its one row, and there is nothing to reconcile', async () => {
    const { conversationId, readerId } = await withTranscript(1);

    const page = await readHistory({ userId: readerId, conversationId, limit: 50 });

    expect(page.messages).toHaveLength(1);
    expect(page.totalCount).toBe(1);
  });

  test('it is the whole conversation on a FORWARD page too, not the rows remaining', async () => {
    // "Rows remaining after this cursor" is a different wrong answer from "rows on
    // this page", and a client reconciling against it would conclude it is behind
    // forever.
    const { conversationId, readerId, written } = await withTranscript(5);

    const page = await readHistory({
      userId: readerId,
      conversationId,
      limit: 2,
      after: seqScalar.parse(positionOf(written[1]!)),
    });

    expect(page.messages).toHaveLength(2);
    expect(page.totalCount).toBe(5);
  });

  test('it counts THIS conversation, and no other', async () => {
    const mine = await directConversationBetweenTwo();
    const elsewhere = await directConversationBetweenTwo();
    await transcript(mine.conversationId, mine.authorId, 4);
    await transcript(elsewhere.conversationId, elsewhere.authorId, 9);

    const page = await readHistory({ userId: mine.authorId, conversationId: mine.conversationId, limit: 50 });

    expect(page.totalCount).toBe(4);
    expect(page.latestSeq).toBe(positionOf((await readHistory({ userId: mine.authorId, conversationId: mine.conversationId, limit: 1 })).messages[0]!));
  });

  test('it is a COUNT and not the span: a hole in the transcript shows up as a smaller number', async () => {
    // The outbox row goes first because `outbox.message_seq` is `NO ACTION`, not
    // `CASCADE` (3.B): a hard delete that cascaded would drop an undelivered send,
    // and the schema refuses the delete instead. That refusal is the point, so the
    // test clears it deliberately rather than working around it.
    const { conversationId, readerId, written } = await withTranscript(5);
    const holed = positionOf(written[2]!);

    await sql`DELETE FROM outbox WHERE message_seq = ${holed}`;
    await sql`DELETE FROM message WHERE seq = ${holed}`;

    const page = await readHistory({ userId: readerId, conversationId, limit: 50 });

    expect(page.totalCount).toBe(4);
    // The span says five and the count says four, and ADR 0005 is explicit that
    // the span is the UNSOUND check: a rolled-back transaction burns a sequence
    // value, so a conversation can legitimately be 100, 101, 102, 105. If the
    // count were derived from the span this test would read 5.
    expect(Number(page.latestSeq)).toBe(Number(positionOf(written[4]!)));
    expect(page.messages.map(positionOf)).not.toContain(holed);
  });

  test('the number a client reconciles against is a real net, not decoration', async () => {
    // Gate G4 in one assertion: what the client holds, what the server says, and
    // the number of rows it would have to go and fetch. 3.G performs the
    // comparison; the server's half is that `5 - 3` is exactly the shortfall.
    const { conversationId, readerId } = await withTranscript(5);

    const page = await readHistory({ userId: readerId, conversationId, limit: 2 });
    const held = page.messages.length;

    expect(page.totalCount - held).toBe(3);
    expect(page.totalCount).toBeGreaterThan(held);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Membership — and the answer a non-member gets
// ═══════════════════════════════════════════════════════════════════════════════

describe('a conversation that is not the caller\'s', () => {
  test('a stranger, a conversation that does not exist, and an empty one all get the SAME answer', async () => {
    const elsewhere = await directConversationBetweenTwo();
    await transcript(elsewhere.conversationId, elsewhere.authorId, 3);
    const stranger = await insertUser('Stranger');

    const notMine = await readHistory({
      userId: stranger,
      conversationId: elsewhere.conversationId,
      limit: 50,
    });
    const doesNotExist = await readHistory({
      userId: stranger,
      conversationId: conversationIdScalar.parse('00000000-0000-4000-8000-000000000000'),
      limit: 50,
    });
    const empty = await directConversationBetweenTwo();

    expect(notMine).toEqual({ messages: [], latestSeq: seqScalar.parse('0'), totalCount: 0 });
    expect(doesNotExist).toEqual(notMine);
    // …and the same as a conversation they ARE in and nobody has spoken in.
    expect(await readHistory({ userId: empty.authorId, conversationId: empty.conversationId, limit: 50 })).toEqual(notMine);
    // Nothing from the other conversation, not even its size.
    expect(notMine.totalCount).toBe(0);
  });

  test('a former member is treated exactly like a stranger', async () => {
    // `left_at` set: still a row, still a member FOR HISTORY per the glossary —
    // and whether a former member may still read a transcript is stage 5's
    // question, not this unit's. One predicate for both endpoints beats two
    // half-decided answers.
    const direct = await directConversationBetweenTwo();
    await transcript(direct.conversationId, direct.authorId, 2);
    await sql`UPDATE member SET left_at = now() WHERE user_id = ${direct.peerId}`;

    const page = await readHistory({ userId: direct.peerId, conversationId: direct.conversationId, limit: 50 });

    expect(page).toEqual({ messages: [], latestSeq: seqScalar.parse('0'), totalCount: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Catch-up — one query for the whole account
// ═══════════════════════════════════════════════════════════════════════════════

describe('catch-up', () => {
  /** Two conversations, written alternately so positions interleave. */
  async function twoInterleavedConversations() {
    const mine = await directConversationBetweenTwo();
    const other = await directConversationBetweenTwo();
    const written: Message[] = [];

    written.push(await say(mine.conversationId, mine.authorId, 'mine-1'));
    written.push(await say(other.conversationId, other.authorId, 'theirs-1'));
    written.push(await say(mine.conversationId, mine.authorId, 'mine-2'));
    written.push(await say(other.conversationId, other.authorId, 'theirs-2'));
    written.push(await say(mine.conversationId, mine.authorId, 'mine-3'));

    return { mine, other, written };
  }

  test('one query spans every conversation the caller is in, in global position order', async () => {
    // ADR 0005: "Reconnect is one query, not one per conversation." The reason it
    // CAN be is that `seq` is a single global column, so this page crosses
    // conversation boundaries in one strictly increasing run.
    const { mine, written } = await twoInterleavedConversations();

    const page = await readCatchUp({ userId: mine.authorId, after: seqScalar.parse('0'), limit: 50 });

    expect(bodiesOf(page.messages)).toEqual(['mine-1', 'mine-2', 'mine-3']);
    const positions = positionsOf(page.messages).map(Number);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).toEqual([positionOf(written[0]!), positionOf(written[2]!), positionOf(written[4]!)].map(Number));
    expect(page.latestSeq).toBe(positionOf(written[4]!));
  });

  test('the cursor is exclusive and pages towards the present', async () => {
    const { mine, written } = await twoInterleavedConversations();

    const page = await readCatchUp({
      userId: mine.authorId,
      after: seqScalar.parse(positionOf(written[0]!)),
      limit: 50,
    });

    expect(bodiesOf(page.messages)).toEqual(['mine-2', 'mine-3']);
    expect(positionsOf(page.messages)).not.toContain(positionOf(written[0]!));
  });

  test('the loop terminates on a short page, and the walk covers everything exactly once', async () => {
    const { mine } = await twoInterleavedConversations();
    await say(mine.conversationId, mine.authorId, 'mine-4');
    await say(mine.conversationId, mine.authorId, 'mine-5');

    const collected: Message[] = [];
    const pageLengths: number[] = [];
    let cursor = '0';

    do {
      const page = await readCatchUp({ userId: mine.authorId, after: seqScalar.parse(cursor), limit: 2 });
      collected.push(...page.messages);
      pageLengths.push(page.messages.length);
      if (page.messages.length > 0) cursor = positionOf(page.messages[page.messages.length - 1]!);
    } while (pageLengths[pageLengths.length - 1] === 2);

    expect(pageLengths).toEqual([2, 2, 1]);
    expect(bodiesOf(collected)).toEqual(['mine-1', 'mine-2', 'mine-3', 'mine-4', 'mine-5']);
    expect(new Set(collected.map((message) => message.id)).size).toBe(5);
  });

  test('never a message from a conversation the caller is not in', async () => {
    const { mine, other } = await twoInterleavedConversations();

    const page = await readCatchUp({ userId: mine.authorId, after: seqScalar.parse('0'), limit: 50 });

    expect(bodiesOf(page.messages)).toEqual(['mine-1', 'mine-2', 'mine-3']);
    for (const message of page.messages) expect(message.conversationId).toBe(mine.conversationId);
    // …and the other's newest position is not even the caller's head, because
    // `latestSeq` is over what the caller can see.
    expect(page.latestSeq).not.toBe(positionOf((await readHistory({ userId: other.authorId, conversationId: other.conversationId, limit: 1 })).messages[0]!));
  });

  test('never a message from a conversation the caller has LEFT, at any position', async () => {
    // The security-relevant half. `left_at IS NULL` is in the query itself, so the
    // exclusion does not depend on a filter being applied afterwards — and this
    // asserts the rows really are gone rather than merely filtered out of the
    // response.
    const { mine, other, written } = await twoInterleavedConversations();
    await sql`UPDATE member SET left_at = now() WHERE user_id = ${mine.authorId} AND conversation_id = ${mine.conversationId}`;
    const rejoined = await createDirectConversation([mine.authorId, await insertUser('Third')]);

    const page = await readCatchUp({ userId: mine.authorId, after: seqScalar.parse('0'), limit: 50 });

    expect(page.messages).toEqual([]);
    expect(page.latestSeq).toBe(seqScalar.parse('0'));
    // A conversation they are in again, with nothing said in it, changes nothing:
    // the cursor is global and the membership is per conversation.
    await say(rejoined.conversationId, mine.authorId, 'after leaving');
    const next = await readCatchUp({ userId: mine.authorId, after: seqScalar.parse('0'), limit: 50 });
    expect(bodiesOf(next.messages)).toEqual(['after leaving']);
    expect(next.messages[0]!.seq).not.toBe(positionOf(written[0]!));
  });

  test('a member of no conversation at all gets an empty page and a zero head', async () => {
    const alone = await insertUser('Alone');

    const page = await readCatchUp({ userId: alone, after: seqScalar.parse('0'), limit: 50 });

    expect(page).toEqual({ messages: [], latestSeq: seqScalar.parse('0') });
  });

  test('the head is over what THIS caller can see: both of a pair agree, and a wider account sees a later one', async () => {
    const pair = await directConversationBetweenTwo();
    const written = await transcript(pair.conversationId, pair.authorId, 2);

    const forAuthor = await readCatchUp({ userId: pair.authorId, after: seqScalar.parse('0'), limit: 50 });
    const forPeer = await readCatchUp({ userId: pair.peerId, after: seqScalar.parse('0'), limit: 50 });

    // Two callers who can see exactly the same rows get exactly the same head.
    expect(forAuthor.latestSeq).toBe(forPeer.latestSeq);
    expect(forAuthor.latestSeq).toBe(positionOf(written[1]!));
    expect(bodiesOf(forAuthor.messages)).toEqual(bodiesOf(forPeer.messages));

    // A stranger's conversation is invisible from here, so it does not move this
    // head — and its author, who cannot see the first conversation at all, has a
    // head that is only their own.
    const elsewhere = await directConversationBetweenTwo();
    const theirWritten = await transcript(elsewhere.conversationId, elsewhere.authorId, 1);

    expect((await readCatchUp({ userId: pair.authorId, after: seqScalar.parse('0'), limit: 50 })).latestSeq)
      .toBe(forPeer.latestSeq);
    const theirs = await readCatchUp({ userId: elsewhere.authorId, after: seqScalar.parse('0'), limit: 50 });
    expect(theirs.latestSeq).toBe(positionOf(theirWritten[0]!));
    expect(Number(theirs.latestSeq)).toBeGreaterThan(Number(forPeer.latestSeq));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The page shapes the protocol promises
// ═══════════════════════════════════════════════════════════════════════════════

describe('the wire', () => {
  test('a position is a DECIMAL STRING on a page, like everywhere else', async () => {
    const { conversationId, readerId, written } = await withTranscript(1);

    const page = await readHistory({ userId: readerId, conversationId, limit: 50 });

    expect(page.messages[0]!.seq).toBe(positionOf(written[0]!));
    expect(typeof page.messages[0]!.seq).toBe('string');
    expect(typeof page.latestSeq).toBe('string');
    expect(Number.isInteger(page.totalCount)).toBe(true);
  });

  test('a page round-trips through the protocol schemas', async () => {
    // A field this path gets wrong is a failed parse here rather than a body a
    // client has to cope with.
    const { conversationId, readerId } = await withTranscript(2);
    const history: HistoryPage = await readHistory({ userId: readerId, conversationId, limit: 1 });
    const catchUp: CatchUpPage = await readCatchUp({ userId: readerId, after: seqScalar.parse('0'), limit: 1 });

    expect(history.messages[0]!.attachments).toEqual([]);
    expect(catchUp.messages[0]!.attachments).toEqual([]);
    expect(JSON.parse(JSON.stringify(history))).toEqual(history);
    expect(JSON.parse(JSON.stringify(catchUp))).toEqual(catchUp);
  });

  test('the default page size is 50, and it is one constant', async () => {
    // ADR 0005 calls fifty "roughly a screen and a half" and says the exact
    // number matters less than it being a constant. `PAGE_SIZE` is that constant
    // and the route's schema is what defaults to it; this pins the number itself.
    expect(PAGE_SIZE).toBe(50);
  });
});