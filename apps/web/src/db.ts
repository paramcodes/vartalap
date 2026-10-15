/**
 * The store singleton for the interface. `store.ts` owns the Dexie instance;
 * this owns the one the whole app shares — one browser profile, one database
 * name, one transcript (0061). Tests never touch this: they build their own
 * stores with unique names and inject loaders instead.
 */
import { createStore, type MessageRow, type MessageStore } from './store.ts';

let open: Promise<MessageStore> | null = null;

export function getStore(): Promise<MessageStore> {
  if (open === null) open = createStore('vartalap').open();
  return open;
}

/** The preview read: every held row for a conversation, newest decided in `list.ts`. */
export async function loadRows(conversationId: string): Promise<MessageRow[]> {
  return (await getStore()).rowsFor(conversationId);
}
