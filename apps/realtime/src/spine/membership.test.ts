/**
 * The membership read: ever-members read, strangers get `null`, and the
 * direct title stays null with the peer beside it.
 *
 *     bun run test
 */
import { expect, test } from 'bun:test';
import { insertUser } from './fixture.ts';
import { createDirectConversationWith, createGroupConversation } from './conversations.ts';
import { leaveConversation } from './leave.ts';
import { readMembership } from './membership.ts';

async function handleOf(userId: string): Promise<string> {
  const { sql } = await import('@vartalap/database/test-harness');
  const rows = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE id = ${userId}`;
  return rows[0]!.username;
}

test('a member reads the conversation and everybody in it', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const direct = await createDirectConversationWith(String(viewer), await handleOf(String(peer)));
  if (direct.kind !== 'created') throw new Error('direct creation refused');

  const found = await readMembership(String(direct.conversation.id), String(viewer));
  expect(found?.conversation.kind).toBe('direct');
  expect(found?.conversation.title).toBeNull();
  expect(found?.members.map((m) => String(m.userId)).sort()).toEqual(
    [String(viewer), String(peer)].sort(),
  );
});

test('a stranger reads nothing — indistinguishable from an unknown id', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const stranger = await insertUser('Stranger');
  const direct = await createDirectConversationWith(String(viewer), await handleOf(String(peer)));
  if (direct.kind !== 'created') throw new Error('direct creation refused');

  expect(await readMembership(String(direct.conversation.id), String(stranger))).toBeNull();
  expect(
    await readMembership('00000000-0000-4000-8000-000000000000', String(stranger)),
  ).toBeNull();
});

test('a former member still reads — leaving removes the list row, not the history', async () => {
  const viewer = await insertUser('Viewer');
  const peer = await insertUser('Peer');
  const group = await createGroupConversation(String(viewer), 'Leavers', [
    await handleOf(String(peer)),
  ]);
  if (group.kind !== 'created') throw new Error('group creation refused');

  expect(await leaveConversation(String(group.conversation.id), String(viewer))).toEqual({
    kind: 'left',
  });
  const found = await readMembership(String(group.conversation.id), String(viewer));
  expect(found?.members.find((m) => String(m.userId) === String(viewer))?.leftAt).not.toBeNull();
});
