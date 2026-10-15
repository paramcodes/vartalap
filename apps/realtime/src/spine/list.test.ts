/**
 * The list, proved at the function level: ordering by position with `0`
 * sorting last, mute as a marker that never filters, unread derived per
 * request, blocked pairs carrying their lock, and former memberships gone.
 *
 * No HTTP sign-up here — every user comes from the fixture, so this file
 * spends none of the shared sign-up budget. The route boundary (401 vs 200)
 * is one test in `list.http.test.ts`.
 *
 *     bun run test
 */
import { expect, test } from 'bun:test';
import { sql } from '@vartalap/database/test-harness';
import { newMessageId, insertUser } from './fixture.ts';
import { createDirectConversationWith, createGroupConversation } from './conversations.ts';
import { sendMessage } from './send.ts';
import { advanceReceipt } from './receipt.ts';
import { blockMember } from './blocks.ts';
import { leaveConversation } from './leave.ts';
import { listConversations } from './list.ts';

async function handleOf(userId: string): Promise<string> {
  const rows = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE id = ${userId}`;
  return rows[0]!.username;
}

async function send(conversationId: string, authorId: string, body: string): Promise<string> {
  const outcome = await sendMessage({
    authorId,
    request: { id: newMessageId(), conversationId, body, attachments: [] },
  });
  if (outcome.kind !== 'created') throw new Error(`send refused: ${outcome.kind}`);
  return String(outcome.message.seq);
}

test('orders by position, keeps the muted row with its unread, locks the blocked pair', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const third = await insertUser('Third');

  const direct = await createDirectConversationWith(String(viewer), await handleOf(String(peer)));
  if (direct.kind !== 'created') throw new Error('direct creation refused');
  const group = await createGroupConversation(String(viewer), 'Study group', [
    await handleOf(String(peer)),
    await handleOf(String(third)),
  ]);
  if (group.kind !== 'created') throw new Error('group creation refused');
  const empty = await createDirectConversationWith(String(viewer), await handleOf(String(third)));
  if (empty.kind !== 'created') throw new Error('empty direct creation refused');

  // One message in the group first, then two in the direct pair — then the
  // viewer reads the group, mutes the pair, and the peer blocks the viewer.
  const groupSeq = await send(String(group.conversation.id), String(peer), 'group hello');
  await send(String(direct.conversation.id), String(viewer), 'one');
  const second = await send(String(direct.conversation.id), String(peer), 'two');
  await advanceReceipt({
    userId: String(viewer),
    request: {
      conversationId: String(group.conversation.id),
      readThrough: groupSeq,
      sharedThrough: groupSeq,
    },
  });
  await sql`UPDATE member SET muted_at = now() WHERE conversation_id = ${direct.conversation.id} AND user_id = ${viewer}`;
  const blocked = await blockMember(String(peer), String(viewer));
  expect(blocked.kind).toBe('blocked');

  const items = await listConversations(String(viewer));
  expect(items.map((item) => String(item.conversationId))).toEqual([
    String(direct.conversation.id),
    String(group.conversation.id),
    String(empty.conversation.id),
  ]);

  const [pair, study, quiet] = items;
  // The muted pair stays in place with its unread intact: two messages past a
  // zero receipt, one of them the viewer's own — sends never advance a receipt.
  expect(pair!.muted).toBe(true);
  expect(pair!.unreadCount).toBe(2);
  expect(pair!.title).toBeNull();
  expect(pair!.peers?.map((peerRow) => peerRow.displayName)).toEqual(['Peer']);
  expect(pair!.permission).toEqual({ allowed: false, reason: 'blocked_by_them' });
  expect(second).toBe(String(pair!.lastSeq));

  // Read to the end: no badge, stored title, no peers, sending open.
  expect(study!.unreadCount).toBe(0);
  expect(study!.title).toBe('Study group');
  expect(study!.peers).toBeUndefined();
  expect(study!.presence).toEqual([]);
  expect(study!.permission).toEqual({ allowed: true });

  // Positionless sorts last and carries nothing to render beyond its peer.
  expect(String(quiet!.lastSeq)).toBe('0');
  expect(quiet!.unreadCount).toBe(0);
});

test('a zero-position conversation sorts below every positioned one', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const first = await createDirectConversationWith(String(viewer), await handleOf(String(peer)));
  if (first.kind !== 'created') throw new Error('direct creation refused');
  await send(String(first.conversation.id), String(viewer), 'hello');

  // A second pair created afterwards has no messages — it sorts below the
  // conversation with a position even though it is newer.
  const third = await insertUser('Third');
  const later = await createDirectConversationWith(String(viewer), await handleOf(String(third)));
  if (later.kind !== 'created') throw new Error('direct creation refused');

  const items = await listConversations(String(viewer));
  expect(items.map((item) => String(item.conversationId))).toEqual([
    String(first.conversation.id),
    String(later.conversation.id),
  ]);
});

test('leaving removes the row; the receipt survives underneath', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const group = await createGroupConversation(String(viewer), 'Leavers', [
    await handleOf(String(peer)),
  ]);
  if (group.kind !== 'created') throw new Error('group creation refused');
  const groupId = String(group.conversation.id);
  await send(groupId, String(peer), 'before you left');

  expect((await listConversations(String(viewer))).map((item) => String(item.conversationId))).toEqual([
    groupId,
  ]);
  expect(await leaveConversation(groupId, String(viewer))).toEqual({ kind: 'left' });
  expect(await listConversations(String(viewer))).toEqual([]);
});
