/**
 * Gate C1 — one conversation per direct pair — plus the group ceiling and the
 * creation contract.
 *
 * C1 runs everywhere, unlike G1b: the uniqueness is a constraint (`ON CONFLICT
 * DO NOTHING` on `direct_key`), not a timing property, so PGlite serialising
 * the two inserts does not make the test vacuous. Two concurrent creations
 * still yield exactly one row, which is precisely the claim — the constraint
 * does the work whatever the timing.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import { MAX_GROUP_MEMBERS } from '@vartalap/protocol';
import {
  createDirectConversationWith,
  createGroupConversation,
} from './conversations.ts';
import { directConversationBetweenTwo, insertUser } from './fixture.ts';

const SLOW = 30_000;

beforeEach(async () => {
  await testDb.reset();
});

async function handleOf(userId: string): Promise<string> {
  const rows = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE id = ${userId}`;
  return rows[0]!.username;
}

async function conversationRows(): Promise<{ id: string; kind: string; title: string | null }[]> {
  return sql`SELECT id::text AS id, kind::text AS kind, title FROM conversation`;
}

describe('C1 — two people messaging each other for the first time get one conversation', () => {
  test('two simultaneous creations converge on one row', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    const peerHandle = await handleOf(peerId);
    const authorHandle = await handleOf(authorId);

    // The race, as concurrent as this machine gets: both creations in flight
    // before either resolves. PGlite serialises them; a real server races
    // them. Either way the constraint allows exactly one row.
    const [first, second] = await Promise.all([
      createDirectConversationWith(authorId, peerHandle),
      createDirectConversationWith(peerId, authorHandle),
    ]);
    if (first.kind !== 'created' || second.kind !== 'created') {
      throw new Error(`a creation failed: ${first.kind} / ${second.kind}`);
    }
    expect(first.conversation.id).toBe(second.conversation.id);
    expect(await conversationRows()).toHaveLength(1);
  }, SLOW);

  test('argument order cannot produce two keys', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    const peerHandle = await handleOf(peerId);
    const authorHandle = await handleOf(authorId);

    const first = await createDirectConversationWith(authorId, peerHandle);
    const second = await createDirectConversationWith(peerId, authorHandle);
    if (first.kind !== 'created' || second.kind !== 'created') {
      throw new Error(`a creation failed: ${first.kind} / ${second.kind}`);
    }
    expect(first.conversation.id).toBe(second.conversation.id);
    expect(await conversationRows()).toHaveLength(1);
  });

  test('re-creating an existing pair returns it, and re-seeds harmlessly', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    const peerHandle = await handleOf(peerId);
    const outcome = await createDirectConversationWith(authorId, peerHandle);
    if (outcome.kind !== 'created') throw new Error(`creation failed: ${outcome.kind}`);
    expect(String(outcome.conversation.id)).toBe(String(conversationId));
  });
});

describe('the direct contract', () => {
  test('the row carries no stored title — derivation, not storage', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    const outcome = await createDirectConversationWith(authorId, await handleOf(peerId));
    if (outcome.kind !== 'created') throw new Error(`creation failed: ${outcome.kind}`);
    expect(outcome.conversation.title).toBeNull();
    const rows = await conversationRows();
    expect(rows[0]!.title).toBeNull();
    expect(rows[0]!.kind).toBe('direct');
  });

  test('both members and both watermarks are seeded', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    const outcome = await createDirectConversationWith(authorId, await handleOf(peerId));
    if (outcome.kind !== 'created') throw new Error(`creation failed: ${outcome.kind}`);

    const members = await sql<{ user_id: string }[]>`
      SELECT user_id::text AS user_id FROM member WHERE conversation_id = ${String(conversationId)} AND left_at IS NULL`;
    expect(members.map((row) => row.user_id).sort()).toEqual([authorId, peerId].sort());

    // A new conversation never has a member with no watermark: the receipt and
    // delivery rows exist before the first message does.
    const receipts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt WHERE conversation_id = ${String(conversationId)}`;
    const deliveries = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM delivery WHERE conversation_id = ${String(conversationId)}`;
    expect(receipts[0]!.n).toBe(2);
    expect(deliveries[0]!.n).toBe(2);
  });

  test('an unknown handle names itself', async () => {
    const { authorId } = await directConversationBetweenTwo();
    const outcome = await createDirectConversationWith(authorId, 'nobody_here_zzz');
    expect(outcome).toEqual({ kind: 'unknownHandle', handle: 'nobody_here_zzz' });
    // Refused whole: the fixture's own direct conversation is the only row.
    expect(await conversationRows()).toHaveLength(1);
  });

  test('talking to yourself is refused', async () => {
    const { authorId } = await directConversationBetweenTwo();
    const outcome = await createDirectConversationWith(authorId, await handleOf(authorId));
    expect(outcome.kind).toBe('cannotTalkToSelf');
  });
});

describe('groups', () => {
  test('creation stores the title and seeds every member', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    const third = await insertUser('Third');
    const outcome = await createGroupConversation(authorId, 'Study group', [
      await handleOf(peerId),
      await handleOf(third),
    ]);
    if (outcome.kind !== 'created') throw new Error(`creation failed: ${outcome.kind}`);
    expect(outcome.conversation.kind).toBe('group');
    expect(outcome.conversation.title).toBe('Study group');

    const rows = await conversationRows();
    expect(rows).toHaveLength(2);
    const group = rows.find((row) => row.kind === 'group');
    expect(group?.title).toBe('Study group');

    const members = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM member WHERE conversation_id = ${String(outcome.conversation.id)}`;
    expect(members[0]!.n).toBe(3);
  });

  test('the creator is a member even when unnamed', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    const outcome = await createGroupConversation(authorId, 'No self-naming', [await handleOf(peerId)]);
    if (outcome.kind !== 'created') throw new Error(`creation failed: ${outcome.kind}`);
    const members = await sql<{ user_id: string }[]>`
      SELECT user_id::text AS user_id FROM member WHERE conversation_id = ${String(outcome.conversation.id)}`;
    expect(members.map((row) => row.user_id).sort()).toEqual([authorId, peerId].sort());
  });

  test('the ceiling is a clean refusal, and exactly-500 is fine', async () => {
    const { authorId } = await directConversationBetweenTwo();
    // 500 members: the creator plus 499 handles. Built as one multi-row
    // INSERT — five hundred round trips would test PGlite, not the ceiling.
    const values = Array.from({ length: 499 }, (_, index) => {
      const handle = `ceil_${index.toString().padStart(3, '0')}`;
      return `('ceil_${index}@example.test', '${handle}', 'Ceiling ${index}')`;
    }).join(', ');
    await sql.unsafe(
      `INSERT INTO "user" (email, username, name) VALUES ${values}`,
    );
    const handles = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE username LIKE 'ceil\\_%'`;
    expect(handles.length).toBe(499);

    const full = await createGroupConversation(
      authorId,
      'Full house',
      handles.map((row) => row.username),
    );
    if (full.kind !== 'created') throw new Error(`creation at the ceiling failed: ${full.kind}`);

    const oneMore = await insertUser('OneMore');
    const over = await createGroupConversation(authorId, 'Overfull', [
      ...(handles.map((row) => row.username)),
      await handleOf(oneMore),
    ]);
    expect(over).toEqual({ kind: 'tooManyMembers', members: MAX_GROUP_MEMBERS + 1 });
    // Refused whole, not half-written: the failed creation left no group behind.
    expect((await conversationRows()).filter((row) => row.kind === 'group')).toHaveLength(1);
  }, SLOW);
});
