/**
 * Gate P1 — presence means "connected within the last 45 seconds".
 *
 * Against the real `redis-server` on 6379, because TTL expiry is the mechanism
 * under test and a fake with a virtual clock would prove the fake. Short TTLs
 * keep the suite fast; the 45 is the design and the expiry is what is tested.
 *
 * Keys are throwaway (`presence:test:<uuid>`) and deleted afterwards — the
 * server is shared with development, and `FLUSHDB` in a test file is how a
 * fixture destroys state it did not create.
 *
 *     bun run test
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { isOnline, markAlive, markOffline, onlineOf, presenceKey, PRESENCE_TTL_SECONDS } from './presence.ts';
import { Redis } from './redis.ts';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis;
const owned: string[] = [];

/** A user id nobody else will ever hold, tracked for cleanup. */
function testUser(): string {
  const id = `test:${crypto.randomUUID()}`;
  owned.push(id);
  return id;
}

async function store(ttlSeconds?: number) {
  redis ??= await Redis.connect({ url: REDIS_URL });
  return ttlSeconds === undefined ? { redis } : { redis, ttlSeconds };
}

afterEach(async () => {
  if (redis !== undefined) {
    for (const userId of owned.splice(0)) {
      await redis.command('DEL', presenceKey(userId));
    }
  }
});

test('the design number is 45 seconds, and it is stated once', () => {
  expect(PRESENCE_TTL_SECONDS).toBe(45);
});

describe('P1 — alive refreshes it, silence lets it lapse', () => {
  test('markAlive is visible, then lapses without another word', async () => {
    const userId = testUser();
    const presence = await store(1);
    expect(await isOnline(presence, userId)).toBe(false);

    await markAlive(presence, userId);
    expect(await isOnline(presence, userId)).toBe(true);

    // Silence. Nothing refreshes, nothing deletes, nothing notifies — the TTL
    // is the entire offline mechanism, and this wait is what proves it.
    await Bun.sleep(1_200);
    expect(await isOnline(presence, userId)).toBe(false);
  }, 10_000);

  test('refresh re-arms the full window, past any number of windows', async () => {
    const userId = testUser();
    const presence = await store(1);
    await markAlive(presence, userId);
    await Bun.sleep(700);
    // Still alive here, so this refresh is a re-arm rather than a rebirth —
    // the distinction matters because only a live connection may call it.
    await markAlive(presence, userId);
    await Bun.sleep(700);
    expect(await isOnline(presence, userId)).toBe(true);
    await Bun.sleep(1_200);
    expect(await isOnline(presence, userId)).toBe(false);
  }, 10_000);

  test('markOffline says now what the TTL would say in 45 seconds', async () => {
    const userId = testUser();
    const presence = await store();
    await markAlive(presence, userId);
    expect(await isOnline(presence, userId)).toBe(true);
    await markOffline(presence, userId);
    expect(await isOnline(presence, userId)).toBe(false);
  });

  test('deleting a key that was never there is fine', async () => {
    const presence = await store();
    await markOffline(presence, testUser());
  });
});

describe('P1 — one MGET paints a mixed list', () => {
  test('every id asked about gets an answer, missing keys read false', async () => {
    const [alice, bob, carol] = [testUser(), testUser(), testUser()];
    const presence = await store();
    await markAlive(presence, alice);
    await markAlive(presence, carol);

    const online = await onlineOf(presence, [alice, bob, carol]);
    expect([...online.entries()]).toEqual([
      [alice, true],
      [bob, false],
      [carol, true],
    ]);
  });

  test('an empty list asks nothing and answers nothing', async () => {
    const presence = await store();
    expect((await onlineOf(presence, [])).size).toBe(0);
  });
});

describe('the key', () => {
  test('one per user, and the prefix is the whole namespace', () => {
    expect(presenceKey('abc')).toBe('presence:abc');
  });
});
