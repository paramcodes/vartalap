/**
 * `GET /api/conversations` over real HTTP: the boundary and the shape.
 *
 * One sign-up — this file's only spend of the shared budget. Everything the
 * list guarantees (order, mute, unread, locks) is proved at the function
 * level in `list.test.ts`; here the claims are thin: anonymous is 401, a
 * member gets 200 with items that parse as `conversationListItem`, and a
 * wrong verb is 405 rather than a second error shape.
 *
 *     bun run test
 */
import { afterAll, expect, test } from 'bun:test';
import { conversationListItem } from '@vartalap/protocol';
import { start } from '../server.ts';
import { signUpOverHttp } from './fixture.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

const SLOW = 30_000;

test('anonymous list is 401, and POST is 405', async () => {
  const anon = await fetch(`${origin}/api/conversations`);
  expect(anon.status).toBe(401);

  const wrongVerb = await fetch(`${origin}/api/conversations`, { method: 'POST' });
  expect(wrongVerb.status).toBe(405);
}, SLOW);

test('a member gets 200 with a parseable, empty list', async () => {
  const member = await signUpOverHttp(origin);
  const response = await fetch(`${origin}/api/conversations`, { headers: member.headers });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body)).toBe(true);
  for (const item of body as unknown[]) {
    conversationListItem.parse(item);
  }
  expect(body).toEqual([]);
}, SLOW);

afterAll(() => {
  server.stop(true);
});
