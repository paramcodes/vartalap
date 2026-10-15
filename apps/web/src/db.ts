/**
 * `db.ts` — the store singleton, the rows it draws, and the one session
 * bootstrap. `store.ts` owns the Dexie instance; this owns the one the whole
 * app shares — one browser profile, one database name, one transcript.
 *
 * Nothing here touches IndexedDB or Dexie except `getStore`, and only
 * `getStore` reaches a handle — a handle that stays private to `store.ts`.
 */
import { catchUp } from './catch-up.ts';
import { fetchTransport } from './transport.ts';
import { createStore, type MessageRow, type MessageStore } from './store.ts';

let open: Promise<MessageStore> | null = null;

export function getStore(): Promise<MessageStore> {
  if (open === null) open = createStore('vartalap').open();
  return open;
}

/** Every held row for a conversation — the preview read and the transcript's source. */
export async function loadRows(conversationId: string): Promise<MessageRow[]> {
  return (await getStore()).rowsFor(conversationId);
}

/**
 * Boot a session: reclaim rows a reload was mid-POST for, catch up from the
 * cursor (a new browser starts at 0, which is the whole transcript), then
 * flush whatever the catch-up left queued. Three calls of the same path the
 * live socket and the composer use, in this order, so a reconnect and a cold
 * start converge.
 */
export async function startSession(): Promise<void> {
  const store = await getStore();
  await store.reclaimInFlight();
  await catchUp(store, fetchTransport({ baseUrl: '' }));
  const { flushQueue } = await import('./send.ts');
  await flushQueue(store, fetchTransport({ baseUrl: '' }));
}
