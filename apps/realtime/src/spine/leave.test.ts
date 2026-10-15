/**
 * Gate C3 — leaving retains the row and the receipt; rejoining resumes it; a
 * former member cannot write anywhere.
 *
 * The receipt inheritance is the point: a rejoining member's watermark is
 * where they left it because nothing deleted it, and a test that advances,
 * leaves, rejoins and reads back the same number proves the row survived
 * rather than assuming it.
 *
 *     bun run test
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { sql, testDb } from '@vartalap/database/test-harness';
import { receiptAdvanceRequest, receiptSharingRequest, sendMessageRequest } from '@vartalap/protocol';
import { advanceReceipt, setReceiptSharing } from './receipt.ts';
import { acknowledgeDelivery } from './delivery.ts';
import { leaveConversation, rejoinConversation } from './leave.ts';
import { sendMessage } from './send.ts';
import { directConversationBetweenTwo, insertUser, newMessageId } from './fixture.ts';
import { deliveryAckRequest } from '@vartalap/protocol';

const SLOW = 30_000;

beforeEach(async () => {
  await testDb.reset();
});

describe('C3 — leave retains, rejoin resumes', () => {
  test('a rejoining member inherits their receipt', async () => {
    const { conversationId, authorId, peerId } = await directConversationBetweenTwo();
    const id = String(conversationId);

    const advanced = await advanceReceipt({
      userId: authorId,
      request: receiptAdvanceRequest.parse({ conversationId: id, readThrough: '3', sharedThrough: '3' }),
    });
    if (advanced.kind !== 'advanced') throw new Error(`advance failed: ${advanced.kind}`);

    expect(await leaveConversation(id, authorId)).toEqual({ kind: 'left' });
    // The row survives with left_at set — retained, not deleted.
    const left = await sql<{ left_at: string | null }[]>`
      SELECT left_at::text AS left_at FROM member WHERE conversation_id = ${id} AND user_id = ${authorId}`;
    expect(left).toHaveLength(1);
    expect(left[0]!.left_at).not.toBeNull();

    // The receipt survives too — nothing about leaving moves a watermark.
    const kept = await sql<{ read_through: string }[]>`
      SELECT read_through::text AS read_through FROM receipt
      WHERE conversation_id = ${id} AND user_id = ${authorId}`;
    expect(kept[0]!.read_through).toBe('3');

    expect(await rejoinConversation(id, authorId)).toEqual({ kind: 'rejoined' });
    const current = await sql<{ left_at: string | null }[]>`
      SELECT left_at::text AS left_at FROM member WHERE conversation_id = ${id} AND user_id = ${authorId}`;
    expect(current[0]!.left_at).toBeNull();
    const inherited = await sql<{ read_through: string }[]>`
      SELECT read_through::text AS read_through FROM receipt
      WHERE conversation_id = ${id} AND user_id = ${authorId}`;
    expect(inherited[0]!.read_through).toBe('3');
    void peerId;
  });

  test('leaving what you are not in, and rejoining what you never joined', async () => {
    const stranger = await insertUser('Stranger');
    const { conversationId } = await directConversationBetweenTwo();
    const id = String(conversationId);
    expect(await leaveConversation(id, stranger)).toEqual({ kind: 'notAMember' });
    expect(await rejoinConversation(id, stranger)).toEqual({ kind: 'notAMember' });
  });

  test('rejoining while current is a no-op success', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    expect(await rejoinConversation(String(conversationId), authorId)).toEqual({ kind: 'rejoined' });
  });

  test('leaving twice: the second leave finds nobody current', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const id = String(conversationId);
    expect(await leaveConversation(id, authorId)).toEqual({ kind: 'left' });
    expect(await leaveConversation(id, authorId)).toEqual({ kind: 'notAMember' });
  });
});

describe('C3 — a former member cannot write anywhere', () => {
  test('send, receipt, delivery and sharing all refuse', async () => {
    const { conversationId, authorId } = await directConversationBetweenTwo();
    const id = String(conversationId);
    expect(await leaveConversation(id, authorId)).toEqual({ kind: 'left' });

    const sent = await sendMessage({
      authorId,
      request: sendMessageRequest.parse({ conversationId: id, id: newMessageId(), body: 'x', attachments: [] }),
    });
    expect(sent).toEqual({ kind: 'notAMember' });

    const advanced = await advanceReceipt({
      userId: authorId,
      request: receiptAdvanceRequest.parse({ conversationId: id, readThrough: '1', sharedThrough: '1' }),
    });
    expect(advanced).toEqual({ kind: 'notAMember' });

    const acknowledged = await acknowledgeDelivery({
      userId: authorId,
      request: deliveryAckRequest.parse({ conversationId: id, deliveredThrough: '1' }),
    });
    expect(acknowledged).toEqual({ kind: 'notAMember' });

    const sharing = await setReceiptSharing({
      userId: authorId,
      request: receiptSharingRequest.parse({ conversationId: id, sharing: false }),
    });
    expect(sharing).toEqual({ kind: 'notAMember' });

    // And the refused writes left nothing behind.
    const receipts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt WHERE conversation_id = ${id} AND user_id = ${authorId}`;
    expect(receipts[0]!.n).toBe(0);
  });
});
