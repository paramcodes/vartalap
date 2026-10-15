/**
 * Creation over real HTTP: the routes, the envelope, and the 201.
 *
 * Two sign-ups per file — the measured trap-17 budget is three per run and
 * this file spends two of them (`server.test.ts` spends the third), so every
 * other test here isolates with fresh conversations rather than fresh members.
 *
 *     bun run test
 */
import { afterAll, expect, test } from 'bun:test';
import { sql } from '@vartalap/database/test-harness';
import { start } from '../server.ts';
import { signUpOverHttp } from './fixture.ts';

const server = start(0);
const origin = `http://${server.hostname}:${server.port}`;

const SLOW = 30_000;

let author: Awaited<ReturnType<typeof signUpOverHttp>>;
let peer: Awaited<ReturnType<typeof signUpOverHttp>>;

async function handleOf(userId: string): Promise<string> {
  const rows = await sql<{ username: string }[]>`SELECT username FROM "user" WHERE id = ${userId}`;
  return rows[0]!.username;
}

function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

test('two members sign up, and their handles resolve', async () => {
  author = await signUpOverHttp(origin);
  peer = await signUpOverHttp(origin);
  expect(await handleOf(author.userId)).toMatch(/^spine_/);
  expect(await handleOf(peer.userId)).toMatch(/^spine_/);
}, SLOW);

test('POST /api/conversations/direct answers 201 with the conversation', async () => {
  const response = await post('/api/conversations/direct', author.cookie, {
    handle: await handleOf(peer.userId),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; kind: string; title: string | null };
  expect(body.kind).toBe('direct');
  expect(body.title).toBeNull();

  // Creating it again answers the same row, not a second one.
  const repeat = await post('/api/conversations/direct', author.cookie, {
    handle: await handleOf(peer.userId),
  });
  expect(repeat.status).toBe(201);
  expect(((await repeat.json()) as { id: string }).id).toBe(body.id);
}, SLOW);

test('an unknown handle is 404 and names itself', async () => {
  const response = await post('/api/conversations/direct', author.cookie, { handle: 'nobody_here_zzz' });
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
    'nobody_here_zzz',
  );
}, SLOW);

test('POST /api/conversations/groups answers 201 with the stored title', async () => {
  const response = await post('/api/conversations/groups', author.cookie, {
    title: 'HTTP study group',
    handles: [await handleOf(peer.userId)],
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; kind: string; title: string | null };
  expect(body.kind).toBe('group');
  expect(body.title).toBe('HTTP study group');
}, SLOW);

test('anonymous creation is 401 on both routes', async () => {
  const direct = await fetch(`${origin}/api/conversations/direct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'whoever' }),
  });
  expect(direct.status).toBe(401);
  const groups = await fetch(`${origin}/api/conversations/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Nope', handles: [] }),
  });
  expect(groups.status).toBe(401);
}, SLOW);

afterAll(() => {
  server.stop(true);
});
