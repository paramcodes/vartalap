/**
 * Gate C2 — a blocked sender is refused with the reason the composer renders.
 *
 * Both directions, because `blocked_by_me` and `blocked_by_them` are different
 * facts with different copy and a test that blocks one way proves half the
 * predicate. Plus the negative space the design depends on: unblock restores
 * with no residue, groups ignore blocks, and watermarks never consult them.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import { sendMessageRequest } from '@vartalap/protocol';
import { blockMember, canSend, unblockMember } from './blocks.ts';
import { advanceReceipt } from './receipt.ts';
import { sendMessage } from './send.ts';
import { directConversationBetweenTwo, insertUser, newMessageId } from './fixture.ts';
import { createGroupConversation } from './conversations.ts';
import { receiptAdvanceRequest } from '@vartalap/protocol';

const SLOW = 30_000;

beforeEach(async () => {
  await testDb.reset();
});

async function send(conversationId: string, authorId: string) {
  return sendMessage({
    authorId,
    request: sendMessageRequest.parse({
      conversationId,
      id: newMessageId(),
      body: 'hello',
      attachments: [],
    }),
  });
}

describe('C2 — the blocked party cannot send, in either direction', () => {
  test('B blocks A: A is refused as blocked_by_them', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    expect(await blockMember(peerId, authorId)).toEqual({ kind: 'blocked' });

    const outcome = await send(String(conversationId), authorId);
    expect(outcome).toEqual({ kind: 'sendBlocked', reason: 'blocked_by_them' });
  });

  test('A blocks B: A is refused as blocked_by_me', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    expect(await blockMember(authorId, peerId)).toEqual({ kind: 'blocked' });

    const outcome = await send(String(conversationId), authorId);
    expect(outcome).toEqual({ kind: 'sendBlocked', reason: 'blocked_by_me' });
  });

  test('the blocker is refused too: one block locks the pair', async () => {
    // ADR 0007's second sentence ("B's messages to A are not delivered") made
    // precise: per-member delivery suppression would contradict the spine's
    // uniformity, so a block between the pair locks sending for both, each
    // refusal naming its own direction.
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    await blockMember(peerId, authorId);

    const blockerSend = await send(String(conversationId), peerId);
    expect(blockerSend).toEqual({ kind: 'sendBlocked', reason: 'blocked_by_me' });
  });

  test('unblock restores sending with no residue', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    await blockMember(peerId, authorId);
    expect(await send(String(conversationId), authorId)).toEqual({
      kind: 'sendBlocked',
      reason: 'blocked_by_them',
    });

    expect(await unblockMember(peerId, authorId)).toEqual({ kind: 'unblocked' });
    const outcome = await send(String(conversationId), authorId);
    if (outcome.kind !== 'created') throw new Error(`send after unblock failed: ${outcome.kind}`);

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM block`;
    expect(rows[0]!.n).toBe(0);
  });

  test('blocking twice is still blocked, and unblocking air is fine', async () => {
    const { authorId, peerId } = await directConversationBetweenTwo();
    expect(await blockMember(peerId, authorId)).toEqual({ kind: 'blocked' });
    expect(await blockMember(peerId, authorId)).toEqual({ kind: 'blocked' });
    expect(await unblockMember(peerId, authorId)).toEqual({ kind: 'unblocked' });
    expect(await unblockMember(peerId, authorId)).toEqual({ kind: 'unblocked' });
  });

  test('blocking yourself is refused, and blocking a stranger is refused', async () => {
    const { authorId } = await directConversationBetweenTwo();
    expect(await blockMember(authorId, authorId)).toEqual({ kind: 'cannotBlockSelf' });
    expect(await blockMember(authorId, '00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'unknownUser',
    });
  });
});

describe('C2 — the negative space', () => {
  test('groups ignore blocks: one member cannot veto the rest', async () => {
    const first = await insertUser('First');
    const second = await insertUser('Second');
    const third = await insertUser('Third');
    const group = await createGroupConversation(first, 'Blockproof', [
      await handleOf(second),
      await handleOf(third),
    ]);
    if (group.kind !== 'created') throw new Error(`group creation failed: ${group.kind}`);
    const groupId = String(group.conversation.id);

    await blockMember(second, third);
    const outcome = await send(groupId, third);
    if (outcome.kind !== 'created') throw new Error(`group send failed under a block: ${outcome.kind}`);
  });

  test('a blocked member still advances receipts: blocks gate sending, never reading', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    await blockMember(peerId, authorId);

    const outcome = await advanceReceipt({
      userId: authorId,
      request: receiptAdvanceRequest.parse({
        conversationId: String(conversationId),
        readThrough: '1',
        sharedThrough: '1',
      }),
    });
    expect(outcome.kind).toBe('advanced');
  });

  test('canSend answers not_a_member before it ever looks at blocks', async () => {
    const stranger = await insertUser('Stranger');
    const { conversationId } = await directConversationBetweenTwo();
    expect(await canSend(String(conversationId), stranger)).toEqual({
      allowed: false,
      reason: 'not_a_member',
    });
  });
});

async function handleOf(userId: string): Promise<string> {
  const rows = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE id = ${userId}`;
  return rows[0]!.username;
}
