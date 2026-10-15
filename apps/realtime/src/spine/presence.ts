/**
 * Presence: "connected within the last 45 seconds" (ADR 0006, and the glossary).
 *
 * ── what this module is ────────────────────────────────────────────────────
 *
 * Four functions over a TTL store. `markAlive` writes `presence:<userId>` with a
 * 45-second TTL; `isOnline` reads one key; `onlineOf` paints a list with one
 * `MGET`; `markOffline` deletes on explicit disconnect. That is the whole
 * module, and its smallness is the point: presence is a fact about a TTL, not a
 * service.
 *
 * ── what this module is NOT ────────────────────────────────────────────────
 *
 * There is no timer anywhere in this file — no `setInterval`, no refresh loop,
 * no heartbeat. ADR 0006 forbids the client-side timer explicitly (browsers
 * throttle background tabs; WebSocket keepalives are protocol-level and are
 * not), and the same reasoning forbids a server-side one: a loop that refreshes
 * keys is a second definition of "alive" that can disagree with the
 * connection's. The ONLY writer is `markAlive`, and its only caller is the
 * socket layer observing a live connection (stage 6). Silence lets the key
 * lapse; that lapse IS the offline signal, and no code delivers it.
 *
 * There is no last-seen here. No `lastSeen`, no `seenAt`, no `onlineAt`. The
 * glossary bans the word from every schema and ADR 0006 declined the feature
 * with the reasoning recorded — a timestamp keyed to a user id would be
 * personal data under GDPR Art. 4(1) built on a fiction no Centrifugo
 * primitive can supply precisely. A presence-adjacent timestamp appearing in
 * this module is a bug.
 *
 * ── testing ────────────────────────────────────────────────────────────────
 *
 * `presence.test.ts` runs against the real `redis-server` on 6379 (userland,
 * `mise install redis`, no persistence — presence keys are ephemeral by
 * design). TTL expiry is proved with short TTLs because the suite cannot wait
 * 45 seconds; the 45 is the design and the mechanism is what is tested. Tests
 * use throwaway user ids and delete their keys, because the server is shared
 * with development and a fixture that leaves keys behind is a bad trade.
 */
import { Redis } from './redis.ts';

/** ADR 0006: "connected now" means connected within the last 45 seconds. */
export const PRESENCE_TTL_SECONDS = 45;

/** The key. One per user, because users do not share a channel (ADR 0006). */
export function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

export interface PresenceStore {
  readonly redis: Redis;
  /** Overridden in tests to keep them short. Production is always 45. */
  readonly ttlSeconds?: number;
}

/**
 * The connection is live — observed, not assumed. Called BY the socket layer
 * (stage 6) on connection open and on every keepalive it already sends, never
 * on a timer owned here. `SETEX` re-arms the full window unconditionally: an
 * alive member stays alive past any number of 45-second windows, and that is
 * the only way a key survives.
 */
export async function markAlive(
  store: PresenceStore,
  userId: string,
  ttlSeconds: number = store.ttlSeconds ?? PRESENCE_TTL_SECONDS,
): Promise<void> {
  const reply = await store.redis.command('SETEX', presenceKey(userId), ttlSeconds, 'online');
  if (reply !== 'OK') throw new Error(`SETEX refused: ${JSON.stringify(reply)}`);
}

/**
 * Explicit disconnect: closed tab, signed out, socket revoked. The key would
 * lapse on its own within 45 seconds; deleting it says what the server already
 * knows instead of waiting out the window. Never called on a timer.
 */
export async function markOffline(store: PresenceStore, userId: string): Promise<void> {
  await store.redis.command('DEL', presenceKey(userId));
}

/** One member, now. A missing key is offline — there is no third state. */
export async function isOnline(store: PresenceStore, userId: string): Promise<boolean> {
  return (await store.redis.command('GET', presenceKey(userId))) !== null;
}

/**
 * Many members, one round trip. ADR 0006: `MGET` paints fifty conversations in
 * the time a person actually perceives; the subscription keeps it true
 * afterwards. The subscription half needs the socket and is stage 6's; this
 * half is complete here.
 *
 * The answer is a `Map` with an entry for EVERY id asked about — missing keys
 * read `false`, never absent — so a caller cannot mistake "not asked" for
 * "offline".
 */
export async function onlineOf(
  store: PresenceStore,
  userIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (userIds.length === 0) return new Map();
  const reply = await store.redis.command('MGET', ...userIds.map(presenceKey));
  if (!Array.isArray(reply)) throw new Error(`MGET answered ${JSON.stringify(reply)}`);
  const online = new Map<string, boolean>();
  userIds.forEach((userId, index) => {
    online.set(userId, reply[index] !== null);
  });
  return online;
}
